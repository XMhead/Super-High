use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use walkdir::WalkDir;

use crate::{fs_ops::normalize_path, models::WorkflowRefs};

static PATH_REF: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?x)
        (?P<path>
            [A-Za-z]:[/\\][^`"'\)\]\},，。；、\r\n]+?\.(?:markdown|json|toml|lock|html|yaml|tsx|jsx|vue|css|yml|txt|bat|rs|ts|js|md|py)
            |
            (?:\.{1,2}[/\\])?(?:\.superhigh|\.codex|\.claude|\.opencode|\.gemini|src-tauri|src|scripts|vitepress-docs|logs|dist|docs)[/\\][^`"'\)\]\},，。；、\r\n]+?\.(?:markdown|json|toml|lock|html|yaml|tsx|jsx|vue|css|yml|txt|bat|rs|ts|js|md|py)
            |
            (?:AGENTS|CLAUDE|README|package-lock|package|vite\.config|vitest\.config|tsconfig|Cargo|SKILL)\.(?:md|json|toml|lock|ts)
        )
        (?::[0-9]+)?
        "#,
    )
    .expect("workflow memory path regex")
});

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowMemoryGraph {
    pub project_path: String,
    pub generated_at: String,
    pub nodes: Vec<WorkflowMemoryNode>,
    pub edges: Vec<WorkflowMemoryEdge>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowMemoryNode {
    pub id: String,
    pub kind: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub metadata: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkflowMemoryEdge {
    pub source: String,
    pub target: String,
    pub kind: String,
    pub confidence: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub metadata: BTreeMap<String, Value>,
}

#[derive(Debug, Clone)]
struct CardSource {
    id: String,
    title: String,
    status: String,
    assigned_cli: Option<String>,
    labels: Vec<String>,
    body: String,
    path: PathBuf,
    created_at: String,
    updated_at: String,
    refs: Option<WorkflowRefs>,
}

struct GraphBuilder<'a> {
    project_path: &'a Path,
    nodes: BTreeMap<String, WorkflowMemoryNode>,
    edges: Vec<WorkflowMemoryEdge>,
    edge_keys: BTreeSet<(String, String, String)>,
    warnings: Vec<String>,
}

impl<'a> GraphBuilder<'a> {
    fn new(project_path: &'a Path) -> Self {
        Self {
            project_path,
            nodes: BTreeMap::new(),
            edges: Vec::new(),
            edge_keys: BTreeSet::new(),
            warnings: Vec::new(),
        }
    }

    fn finish(self) -> WorkflowMemoryGraph {
        WorkflowMemoryGraph {
            project_path: normalize_path(&self.project_path.to_path_buf()),
            generated_at: crate::chrono_like_now(),
            nodes: self.nodes.into_values().collect(),
            edges: self.edges,
            warnings: self.warnings,
        }
    }

    fn add_node(&mut self, node: WorkflowMemoryNode) {
        match self.nodes.get_mut(&node.id) {
            Some(existing) => {
                if existing.path.is_none() {
                    existing.path = node.path;
                }
                if existing.summary.is_none() {
                    existing.summary = node.summary;
                }
                for (key, value) in node.metadata {
                    existing.metadata.entry(key).or_insert(value);
                }
            }
            None => {
                self.nodes.insert(node.id.clone(), node);
            }
        }
    }

    fn add_edge(
        &mut self,
        source: impl Into<String>,
        target: impl Into<String>,
        kind: impl Into<String>,
        confidence: impl Into<String>,
        evidence: Option<String>,
        metadata: BTreeMap<String, Value>,
    ) {
        let source = source.into();
        let target = target.into();
        let kind = kind.into();
        let key = (source.clone(), target.clone(), kind.clone());
        if !self.edge_keys.insert(key) {
            return;
        }
        self.edges.push(WorkflowMemoryEdge {
            source,
            target,
            kind,
            confidence: confidence.into(),
            evidence,
            metadata,
        });
    }

    fn add_file_node(&mut self, rel_path: &str) -> String {
        let rel_path = normalize_ref_path(rel_path);
        let id = format!("file:{rel_path}");
        let path = self
            .project_path
            .join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        let mut metadata = BTreeMap::new();
        metadata.insert("relativePath".to_string(), json!(rel_path));
        metadata.insert("exists".to_string(), json!(path.exists()));
        self.add_node(WorkflowMemoryNode {
            id: id.clone(),
            kind: "file".to_string(),
            title: Path::new(&rel_path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&rel_path)
                .to_string(),
            path: Some(normalize_path(&path)),
            summary: None,
            metadata,
        });
        id
    }

    fn add_text_file_edges(&mut self, source_id: &str, text: &str, implements: bool) {
        for rel_path in extract_file_refs(self.project_path, text) {
            let file_id = self.add_file_node(&rel_path);
            self.add_edge(
                source_id,
                file_id,
                "mentions-file",
                "explicit",
                Some(rel_path.clone()),
                BTreeMap::new(),
            );

            if implements {
                self.add_edge(
                    source_id,
                    format!("file:{rel_path}"),
                    "implements",
                    "explicit",
                    Some(rel_path.clone()),
                    BTreeMap::new(),
                );
            }
        }
    }

    fn add_card(&mut self, card: CardSource) {
        let id = format!("card:{}", card.id);

        let mut metadata = BTreeMap::new();
        metadata.insert("status".to_string(), json!(card.status));
        metadata.insert("labels".to_string(), json!(card.labels));
        metadata.insert("createdAt".to_string(), json!(card.created_at));
        metadata.insert("updatedAt".to_string(), json!(card.updated_at));
        if let Some(assigned) = &card.assigned_cli {
            metadata.insert("assignedCli".to_string(), json!(assigned));
        }
        if let Some(refs) = &card.refs {
            metadata.insert("refs".to_string(), json!(refs));
        }

        self.add_node(WorkflowMemoryNode {
            id: id.clone(),
            kind: "card".to_string(),
            title: card.title,
            path: Some(normalize_path(&card.path)),
            summary: summarize(&card.body),
            metadata,
        });
        self.add_text_file_edges(&id, &card.body, true);
        if let Some(refs) = &card.refs {
            self.add_workflow_refs_edges(&id, refs, "explicit");
        }
        self.add_decision_edges(&id, &card.body);
    }

    fn add_decision_edges(&mut self, card_id: &str, body: &str) {
        for (index, line) in body
            .lines()
            .filter(|line| line.trim_start().starts_with("### "))
            .filter(|line| line.contains("决策") || line.to_ascii_lowercase().contains("decision"))
            .enumerate()
        {
            let decision_id = format!("{card_id}:decision:{}", index + 1);
            self.add_node(WorkflowMemoryNode {
                id: decision_id.clone(),
                kind: "decision".to_string(),
                title: line.trim_start_matches('#').trim().to_string(),
                path: None,
                summary: None,
                metadata: BTreeMap::new(),
            });
            self.add_edge(
                card_id,
                decision_id,
                "needs-decision",
                "explicit",
                Some(line.trim().to_string()),
                BTreeMap::new(),
            );
        }
    }

    fn add_workflow_refs_edges(&mut self, source_id: &str, refs: &WorkflowRefs, confidence: &str) {
        for card_id in &refs.cards {
            self.add_edge(
                source_id,
                format!("card:{card_id}"),
                "created-from",
                confidence,
                Some(format!("refs.cards:{card_id}")),
                BTreeMap::new(),
            );
        }
        for file in &refs.files {
            if let Some(rel_path) = normalize_file_ref(self.project_path, file) {
                let target = self.add_file_node(&rel_path);
                self.add_edge(
                    source_id,
                    target,
                    "mentions-file",
                    confidence,
                    Some(format!("refs.files:{rel_path}")),
                    BTreeMap::new(),
                );
            }
        }
    }
}

pub(crate) fn scan_workflow_memory_graph(project_path: &Path) -> Result<WorkflowMemoryGraph> {
    if !project_path.exists() {
        anyhow::bail!("project path does not exist: {}", project_path.display());
    }

    let mut builder = GraphBuilder::new(project_path);
    scan_instructions(project_path, &mut builder);
    scan_cards(project_path, &mut builder)?;
    Ok(builder.finish())
}

fn scan_instructions(project_path: &Path, builder: &mut GraphBuilder<'_>) {
    for file_name in ["AGENTS.md", "CLAUDE.md"] {
        let path = project_path.join(file_name);
        if !path.is_file() {
            continue;
        }
        let raw = fs::read_to_string(&path).unwrap_or_default();
        let id = format!("instruction:{file_name}");
        builder.add_node(WorkflowMemoryNode {
            id: id.clone(),
            kind: "instruction".to_string(),
            title: file_name.to_string(),
            path: Some(normalize_path(&path)),
            summary: summarize(&raw),
            metadata: BTreeMap::from([("fileName".to_string(), json!(file_name))]),
        });
        builder.add_text_file_edges(&id, &raw, false);
    }
}

fn scan_cards(project_path: &Path, builder: &mut GraphBuilder<'_>) -> Result<()> {
    let cards_dir = project_path.join(".superhigh").join("cards");
    if !cards_dir.exists() {
        return Ok(());
    }

    for entry in WalkDir::new(&cards_dir)
        .follow_links(false)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
    {
        let path = entry.path();
        if !path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("md"))
            .unwrap_or(false)
        {
            continue;
        }
        let raw =
            fs::read_to_string(path).with_context(|| format!("read card {}", path.display()))?;
        let card = parse_card_source(path, &raw);
        builder.add_card(card);
    }
    Ok(())
}

fn parse_card_source(path: &Path, raw: &str) -> CardSource {
    let (frontmatter, body) = split_frontmatter(raw);
    let id = frontmatter
        .get("id")
        .cloned()
        .unwrap_or_else(|| file_stem(path).unwrap_or_else(|| "card".to_string()));
    let title = frontmatter
        .get("title")
        .cloned()
        .unwrap_or_else(|| id.clone());
    let status = status_from_card_path(path)
        .or_else(|| frontmatter.get("status").cloned())
        .unwrap_or_else(|| "proposed".to_string());
    CardSource {
        id,
        title,
        status,
        assigned_cli: frontmatter
            .get("assignedCli")
            .or_else(|| frontmatter.get("assigned_cli"))
            .cloned()
            .filter(|value| !value.trim().is_empty()),
        labels: frontmatter
            .get("labels")
            .map(|value| {
                value
                    .trim_matches(['[', ']'])
                    .split(',')
                    .map(strip_quotes)
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        body,
        path: path.to_path_buf(),
        created_at: frontmatter.get("createdAt").cloned().unwrap_or_default(),
        updated_at: frontmatter.get("updatedAt").cloned().unwrap_or_default(),
        refs: frontmatter
            .get("refs")
            .and_then(|value| serde_json::from_str::<WorkflowRefs>(value).ok())
            .filter(|refs| !refs.is_empty()),
    }
}

fn split_frontmatter(raw: &str) -> (BTreeMap<String, String>, String) {
    let normalized = raw.replace("\r\n", "\n");
    let trimmed = normalized.trim_start_matches('\u{feff}');
    let Some(rest) = trimmed.strip_prefix("---\n") else {
        return (BTreeMap::new(), trimmed.to_string());
    };
    let Some(end) = rest.find("\n---") else {
        return (BTreeMap::new(), trimmed.to_string());
    };
    let frontmatter = &rest[..end];
    let body = rest[end + 4..].trim_start_matches('\n').to_string();
    let mut values = BTreeMap::new();
    for line in frontmatter.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        values.insert(key.trim().to_string(), strip_quotes(value.trim()));
    }
    (values, body)
}

fn status_from_card_path(path: &Path) -> Option<String> {
    match path
        .parent()
        .and_then(|path| path.file_name())
        .and_then(|value| value.to_str())?
    {
        "提议" | "建议" | "proposed" => Some("proposed".to_string()),
        "已采纳" | "approved" => Some("approved".to_string()),
        "已派发" | "dispatched" => Some("dispatched".to_string()),
        "已完成" | "done" => Some("done".to_string()),
        "已搁置" | "rejected" => Some("rejected".to_string()),
        _ => None,
    }
}

fn strip_quotes(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'')))
    {
        trimmed[1..trimmed.len() - 1].to_string()
    } else {
        trimmed.to_string()
    }
}

fn extract_file_refs(project_path: &Path, text: &str) -> Vec<String> {
    let mut seen = BTreeSet::new();
    for caps in PATH_REF.captures_iter(text) {
        let Some(raw) = caps.name("path") else {
            continue;
        };
        if let Some(path) = normalize_file_ref(project_path, raw.as_str()) {
            seen.insert(path);
        }
    }
    seen.into_iter().collect()
}

fn normalize_file_ref(project_path: &Path, raw: &str) -> Option<String> {
    let mut value = raw
        .trim()
        .trim_matches(['`', '"', '\'', '<', '>', '(', ')', '[', ']'])
        .trim_end_matches(['.', ',', ';', ':', '，', '。', '；', '、'])
        .replace('\\', "/");
    if value.is_empty() || value.contains("://") {
        return None;
    }
    if let Some(hash) = value.find('#') {
        value.truncate(hash);
    }
    if let Some((prefix, suffix)) = value.rsplit_once(':') {
        if !prefix.contains('/') && prefix.len() == 1 {
            // Keep Windows drive prefixes.
        } else if suffix.chars().all(|ch| ch.is_ascii_digit()) {
            value = prefix.to_string();
        }
    }

    let project = normalize_path(&project_path.to_path_buf()).replace('\\', "/");
    if let Some(rest) = value
        .to_ascii_lowercase()
        .strip_prefix(&project.to_ascii_lowercase())
        .map(|_| value[project.len()..].to_string())
    {
        value = rest.trim_start_matches('/').to_string();
    }
    value = value
        .trim_start_matches("./")
        .trim_start_matches('/')
        .to_string();
    if value.is_empty() {
        None
    } else {
        Some(normalize_ref_path(&value))
    }
}

fn normalize_ref_path(value: &str) -> String {
    let normalized = value.replace('\\', "/");
    let mut parts = Vec::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

fn summarize(text: &str) -> Option<String> {
    let trimmed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.is_empty() {
        return None;
    }
    let mut chars = trimmed.chars();
    let summary = chars.by_ref().take(180).collect::<String>();
    if chars.next().is_some() {
        Some(format!("{summary}..."))
    } else {
        Some(summary)
    }
}

fn file_stem(path: &Path) -> Option<String> {
    path.file_stem()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string())
}
