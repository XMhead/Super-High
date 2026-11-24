//! Native menu state for chat. No WebView terminal, renderer, font or resize is needed.
use std::collections::HashMap;
use crate::models::TerminalBufferSnapshot;

#[derive(Clone, serde::Serialize)]
pub(crate) struct ScreenLine { text: String, highlighted: bool }
#[derive(serde::Serialize)]
pub(crate) struct Snapshot { revision: u64, lines: Vec<ScreenLine> }

struct Screen { parser: vt100::Parser, end_byte: u64 }
#[derive(Default)]
pub(crate) struct ChatUiScreens(HashMap<String, Screen>);
impl ChatUiScreens {
    pub fn after(&self, id: &str) -> Option<u64> { self.0.get(id).map(|screen| screen.end_byte) }
    pub fn update(&mut self, id: &str, snapshot: &TerminalBufferSnapshot) -> Snapshot {
        let first = snapshot.sizes.first();
        let rows = first.map_or(snapshot.rows, |size| size.rows).clamp(1, 500);
        let cols = first.map_or(snapshot.cols, |size| size.cols).clamp(1, 1000);
        let reset = self.0.get(id).is_none_or(|screen| screen.end_byte != snapshot.start_byte);
        if reset { self.0.insert(id.into(), Screen { parser: vt100::Parser::new(rows, cols, 0), end_byte: snapshot.start_byte }); }
        let screen = self.0.get_mut(id).unwrap();
        let mut cursor = 0;
        let bytes = snapshot.buffer.as_bytes();
        for size in &snapshot.sizes {
            let offset = size.at_byte.saturating_sub(snapshot.start_byte).min(bytes.len() as u64) as usize;
            if offset < cursor { continue; }
            screen.parser.process(&bytes[cursor..offset]);
            screen.parser.screen_mut().set_size(size.rows.clamp(1, 500), size.cols.clamp(1, 1000));
            cursor = offset;
        }
        screen.parser.process(&bytes[cursor..]);
        screen.end_byte = snapshot.end_byte;
        let parsed = screen.parser.screen();
        let (rows, cols) = parsed.size();
        let mut lines: Vec<ScreenLine> = Vec::new();
        for (row, text) in parsed.rows(0, cols).enumerate().take(rows as usize) {
            let highlighted = (0..cols).any(|col| parsed.cell(row as u16, col)
                .is_some_and(|cell| cell.inverse() || cell.bgcolor() != vt100::Color::Default));
            if row > 0 && parsed.row_wrapped(row as u16 - 1) && !text.trim_start().starts_with(['›', '❯', '>']) {
                if let Some(previous) = lines.last_mut() { previous.text.push_str(&text); previous.highlighted |= highlighted; continue; }
            }
            lines.push(ScreenLine { text, highlighted });
        }
        Snapshot { revision: snapshot.end_byte, lines }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot(text: &str, start: u64) -> TerminalBufferSnapshot {
        TerminalBufferSnapshot { buffer: text.into(), start_byte: start, end_byte: start + text.len() as u64,
            cols: 80, rows: 24, modes: String::new(), sizes: vec![] }
    }
    #[test]
    fn preserves_menu_selection_across_incremental_repaints_and_sessions() {
        let mut screens = ChatUiScreens::default();
        let initial = snapshot("Select Model\r\n\x1b[7m› 1. First\x1b[0m\r\n  2. Second\r\nEnter to select", 0);
        let first = screens.update("a", &initial);
        assert!(first.lines[1].highlighted);
        let second = screens.update("a", &snapshot("\x1b[2;1H\x1b[2K  1. First\x1b[3;1H\x1b[7m› 2. Second\x1b[0m", initial.end_byte));
        assert!(!second.lines[1].highlighted);
        assert!(second.lines[2].highlighted);
        assert!(screens.update("b", &snapshot("Separate", 0)).lines[0].text.contains("Separate"));
        assert!(screens.update("a", &snapshot("Reset", second.revision + 100)).lines[0].text.contains("Reset"));
    }
}
