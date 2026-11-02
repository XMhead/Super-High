//! Parsing of the native apply_patch format.  This module never reads or writes files.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchFile {
    pub path: String,
    pub kind: String,
    pub hunks: Vec<PatchHunk>,
    pub added: usize,
    pub removed: usize,
    /// Moves and malformed patches cannot be safely reconstructed.
    pub supported: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchHunk {
    pub before: String,
    pub after: String,
}

/// Parse only an explicit apply_patch payload. Context lines are retained in both
/// sides so callers can require an unambiguous exact match before reversing.
pub fn parse_patch(raw: &str) -> Vec<PatchFile> {
    let Some(start) = raw.find("*** Begin Patch") else { return vec![] };
    let Some(end) = raw[start..].find("*** End Patch").map(|n| start + n) else { return vec![] };
    let mut files: Vec<PatchFile> = Vec::new();
    let mut before = Vec::new();
    let mut after = Vec::new();
    fn flush(files: &mut [PatchFile], before: &mut Vec<String>, after: &mut Vec<String>) {
        if !before.is_empty() || !after.is_empty() {
            if let Some(file) = files.last_mut() {
                file.hunks.push(PatchHunk { before: before.join("\n"), after: after.join("\n") });
            }
            before.clear(); after.clear();
        }
    }
    for line in raw[start..end].lines().skip(1) {
        let header = [("*** Update File: ", "update"), ("*** Add File: ", "add"), ("*** Delete File: ", "delete")]
            .into_iter().find_map(|(prefix, kind)| line.strip_prefix(prefix).map(|path| (path, kind)));
        if let Some((path, kind)) = header {
            flush(&mut files, &mut before, &mut after);
            files.push(PatchFile { path: path.trim().to_owned(), kind: kind.to_owned(), hunks: Vec::new(), added: 0, removed: 0, supported: !path.trim().is_empty() });
        } else if line.starts_with("*** Move to:") {
            if let Some(file) = files.last_mut() { file.supported = false; }
        } else if line.starts_with("@@") {
            flush(&mut files, &mut before, &mut after);
        } else if line == "*** End of File" {
            // EOF anchoring is significant; do not offer inverse editing yet.
            if let Some(file) = files.last_mut() { file.supported = false; }
        } else if let Some(file) = files.last_mut() {
            match line.chars().next() {
                Some('+') => { file.added += 1; after.push(line[1..].to_owned()); }
                Some('-') => { file.removed += 1; before.push(line[1..].to_owned()); }
                Some(' ') => { before.push(line[1..].to_owned()); after.push(line[1..].to_owned()); }
                _ => file.supported = false,
            }
        }
    }
    flush(&mut files, &mut before, &mut after);
    files
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn update_preserves_context_and_counts() {
        let files = parse_patch("*** Begin Patch\n*** Update File: src/a.txt\n@@\n context\n-old\n+new\n*** End Patch");
        assert_eq!(files.len(), 1);
        assert_eq!((files[0].added, files[0].removed), (1, 1));
        assert_eq!(files[0].hunks[0].before, "context\nold");
        assert_eq!(files[0].hunks[0].after, "context\nnew");
    }
    #[test]
    fn rejects_incomplete_and_marks_moves_unsafe() {
        assert!(parse_patch("*** Begin Patch\n*** Add File: x\n+a").is_empty());
        assert!(!parse_patch("*** Begin Patch\n*** Update File: x\n*** Move to: y\n@@\n-a\n+b\n*** End Patch")[0].supported);
    }
}


/// Extract a patch literal, including JSON-quoted strings inside functions.exec JavaScript.
/// Never evaluate the tool input.
pub fn extract_patch(input: &str) -> Vec<PatchFile> {
    let direct = parse_patch(input);
    if !direct.is_empty() && direct.iter().all(|f| f.supported) { return direct; }
    for (offset, byte) in input.bytes().enumerate() {
        if byte != b'"' { continue; }
        let mut stream = serde_json::Deserializer::from_str(&input[offset..]).into_iter::<String>();
        if let Some(Ok(literal)) = stream.next() {
            let files = parse_patch(&literal);
            if !files.is_empty() { return files; }
        }
    }
    direct
}

/// Decode Codex's completed FileChange item, which carries native unified diffs.
pub fn native_file_changes(item: &serde_json::Value) -> Vec<PatchFile> {
    if item["status"].as_str() != Some("completed") { return vec![]; }
    let Some(changes) = item["changes"].as_object() else { return vec![] };
    let mut result = Vec::new();
    for (path, change) in changes {
        match change["type"].as_str() {
            Some("update") => {
                let Some(diff) = change["unified_diff"].as_str() else { continue };
                let diff = diff.trim_end_matches(['\r', '\n']);
                let patch = format!("*** Begin Patch\n*** Update File: {path}\n{diff}\n*** End Patch");
                let mut files = parse_patch(&patch);
                if change["move_path"].as_str().is_some() { for file in &mut files { file.supported = false; } }
                result.extend(files);
            },
            Some("add") => {
                let Some(content) = change["content"].as_str() else { continue };
                let trailing_newline = content.ends_with('\n');
                let body = content.strip_suffix('\n').unwrap_or(content);
                result.push(PatchFile { path: path.clone(), kind: "add".into(),
                    hunks: vec![PatchHunk { before: String::new(), after: body.to_owned() }],
                    added: content.lines().count(), removed: 0, supported: trailing_newline });
            },
            Some("delete") => result.push(PatchFile { path: path.clone(), kind: "delete".into(), hunks: vec![], added: 0, removed: 0, supported: false }),
            _ => {},
        }
    }
    result
}

pub fn same_path(a: &str, b: &str) -> bool {
    let a = a.replace('\\', "/").to_lowercase();
    let b = b.replace('\\', "/").to_lowercase();
    a == b || a.ends_with(&format!("/{b}")) || b.ends_with(&format!("/{a}"))
}

/// Decode structured tool output without interpreting or executing it.
pub fn output_text(value: &serde_json::Value) -> String {
    fn collect(value: &serde_json::Value, out: &mut Vec<String>, depth: usize) {
        if depth > 4 { return; }
        match value {
            serde_json::Value::String(text) => {
                if let Ok(nested) = serde_json::from_str::<serde_json::Value>(text) {
                    if !nested.is_string() { collect(&nested, out, depth + 1); return; }
                }
                out.push(text.clone());
            },
            serde_json::Value::Array(items) => for item in items { collect(item, out, depth + 1); },
            serde_json::Value::Object(items) => for (key, item) in items { if key == "text" || key == "content" || key == "output" { collect(item, out, depth + 1); } },
            _ => {},
        }
    }
    let mut out = Vec::new(); collect(value, &mut out, 0); out.join("\n")
}

pub fn claude_edit(input: &serde_json::Value) -> Vec<PatchFile> {
    let (Some(path), Some(before), Some(after)) = (input["file_path"].as_str(), input["old_string"].as_str(), input["new_string"].as_str()) else { return vec![] };
    let supported = !path.is_empty() && !after.is_empty() && input["replace_all"] != true;
    let old_lines: Vec<_> = before.lines().collect();
    let new_lines: Vec<_> = after.lines().collect();
    let prefix = old_lines.iter().zip(&new_lines).take_while(|(a, b)| a == b).count();
    let suffix = old_lines[prefix..].iter().rev().zip(new_lines[prefix..].iter().rev()).take_while(|(a, b)| a == b).count();
    vec![PatchFile { path: path.to_owned(), kind: "edit".into(),
        hunks: vec![PatchHunk { before: before.into(), after: after.into() }],
        added: new_lines.len() - prefix - suffix, removed: old_lines.len() - prefix - suffix, supported }]
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditPreview {
    pub old_text: String,
    pub new_text: String,
    pub can_undo: bool,
    pub reason: String,
}

fn resolve_file(cwd: &str, path: &str) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(cwd).map_err(|e| e.to_string())?;
    let input = Path::new(path);
    let joined = if input.is_absolute() { input.to_path_buf() } else { root.join(input) };
    let resolved = std::fs::canonicalize(&joined).map_err(|e| e.to_string())?;
    if !resolved.starts_with(&root) || !resolved.is_file() { return Err("文件不在当前工作区内".into()); }
    Ok(resolved)
}

fn unique_replace(text: &str, needle: &str, replacement: &str, line_boundary: bool) -> Option<String> {
    if needle.is_empty() { return None; }
    let matches: Vec<_> = text.match_indices(needle).filter(|(offset, _)| {
        !line_boundary || ((*offset == 0 || text.as_bytes().get(offset - 1) == Some(&b'\n'))
            && (offset + needle.len() == text.len() || (text.as_bytes().get(offset + needle.len()) == Some(&b'\n') || text.as_bytes().get(offset + needle.len()..offset + needle.len() + 2) == Some(b"\r\n"))))
    }).collect();
    if matches.len() != 1 { return None; }
    let offset = matches[0].0;
    let mut result = text.to_owned();
    result.replace_range(offset..offset + needle.len(), replacement);
    Some(result)
}

fn reverse(current: &str, changes: &[PatchFile]) -> Result<(String, bool), String> {
    let mut text = current.to_owned();
    let mut remove = false;
    for change in changes.iter().rev() {
        if !change.supported { return Err("此操作无法安全还原".into()); }
        match change.kind.as_str() {
            "update" | "edit" => for hunk in change.hunks.iter().rev() {
                // Unified patches use LF. Only convert on an unambiguously CRLF file;
                // Claude Edit strings retain their exact original bytes.
                let has_crlf = text.contains("\r\n");
                let other_newlines = text.replace("\r\n", "").contains(['\r', '\n']);
                if change.kind == "update" && has_crlf && other_newlines { return Err("混合换行无法安全还原".into()); }
                let crlf = change.kind == "update" && has_crlf && !other_newlines;
                let before = if crlf { hunk.before.replace('\n', "\r\n") } else { hunk.before.clone() };
                let after = if crlf { hunk.after.replace('\n', "\r\n") } else { hunk.after.clone() };
                text = unique_replace(&text, &after, &before, change.kind == "update")
                    .ok_or_else(|| "当前文件与改动不匹配或匹配位置不唯一".to_owned())?;
            },
            "add" => {
                let Some(hunk) = change.hunks.first() else { return Err("新增内容不完整".into()) };
                if change.hunks.len() != 1 || text != format!("{}\n", hunk.after) { return Err("新增文件已被修改".into()); }
                text.clear(); remove = true;
            },
            _ => return Err("缺少原文件内容，无法还原".into()),
        }
    }
    Ok((text, remove))
}

pub fn preview(cwd: &str, path: &str, changes: &[PatchFile]) -> Result<EditPreview, String> {
    let file = resolve_file(cwd, path)?;
    let current = std::fs::read_to_string(file).map_err(|e| e.to_string())?;
    match reverse(&current, changes) {
        Ok((old_text, _)) => Ok(EditPreview { old_text, new_text: current, can_undo: true, reason: String::new() }),
        Err(reason) => Ok(EditPreview { old_text: String::new(), new_text: current, can_undo: false, reason }),
    }
}

pub fn undo(cwd: &str, path: &str, changes: &[PatchFile], expected: &str) -> Result<(), String> {
    let file = resolve_file(cwd, path)?;
    let current = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
    if current != expected { return Err("文件已变化，请重新预览".into()); }
    let (old, remove) = reverse(&current, changes)?;
    if remove { std::fs::remove_file(file) } else { std::fs::write(file, old) }.map_err(|e| e.to_string())
}

#[cfg(test)]
mod safety_tests {
    use super::*;
    #[test]
    fn javascript_string_literal_is_parsed_without_execution() {
        let patch = "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch";
        let js = format!("await tools.apply_patch({})", serde_json::to_string(patch).unwrap());
        assert_eq!(extract_patch(&js)[0].path, "a.txt");
    }
    #[test]
    fn reverse_only_unique_content_and_in_reverse_order() {
        let edits = vec![PatchFile { path: "a".into(), kind: "edit".into(), hunks: vec![PatchHunk { before: "one".into(), after: "two".into() }], added: 1, removed: 1, supported: true },
            PatchFile { path: "a".into(), kind: "edit".into(), hunks: vec![PatchHunk { before: "two".into(), after: "three".into() }], added: 1, removed: 1, supported: true }];
        assert_eq!(reverse("three", &edits).unwrap().0, "one");
        assert!(reverse("three three", &edits).is_err());
        assert!(reverse("user changed", &edits).is_err());
    }
    #[test]
    fn boundaries_and_unrelated_user_edits_are_preserved() {
        let edits = parse_patch("*** Begin Patch\n*** Update File: a\n@@\n context\n-old\n+new\n*** End Patch");
        assert_eq!(reverse("user\ncontext\nnew\nother", &edits).unwrap().0, "user\ncontext\nold\nother");
        assert!(reverse("usercontext\nnew", &edits).is_err());
    }
    #[test]
    fn native_file_change_structured_diff_and_crlf() {
        let item = serde_json::json!({"type":"FileChange", "status":"completed", "changes": {
            "D:\\workspace\\a.txt": {"type":"update", "unified_diff":"@@ -1,2 +1,2 @@\n 中文\r\n-old\r\n+new\r\n", "move_path":null}
        }});
        let edits = native_file_changes(&item);
        assert_eq!((edits[0].added, edits[0].removed), (1, 1));
        assert!(edits[0].supported);
        assert_eq!(reverse("其他\r\n中文\r\nnew\r\n保留\r\n", &edits).unwrap().0, "其他\r\n中文\r\nold\r\n保留\r\n");
        assert!(reverse("中文\r\nnew\n混合", &edits).is_err());
    }
    #[test]
    fn native_added_file_requires_exact_bytes() {
        let item = serde_json::json!({"status":"completed", "changes":{"x":{"type":"add", "content":"你好\r\n"}}});
        let edits = native_file_changes(&item);
        assert!(reverse("你好\r\n", &edits).unwrap().1);
        assert!(reverse("你好", &edits).is_err());
    }
    #[test]
    fn added_file_only_removed_if_exactly_unchanged() {
        let edits = parse_patch("*** Begin Patch\n*** Add File: a\n+hello\n*** End Patch");
        assert!(reverse("hello\n", &edits).unwrap().1);
        assert!(reverse("hello\nuser", &edits).is_err());
    }
}
