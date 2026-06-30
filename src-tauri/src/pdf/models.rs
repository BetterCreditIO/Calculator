//! Wire types shared with the frontend.
//!
//! These mirror `src/types/pdf.ts` exactly. The `rename_all = "camelCase"`
//! attribute makes the JSON match the TypeScript field names, so the two stay
//! in lockstep with no manual mapping on either side.
//!
//! All geometry is emitted in a NORMALIZED, TOP-LEFT, POINT-BASED space (see
//! `engine.rs::to_top_left_rect`). Pdfium's native space is bottom-left; we
//! convert once, here at the boundary, which is the key to pixel-accurate
//! overlay positioning on the DOM side.

use serde::{Deserialize, Serialize};

/// Axis-aligned rectangle, top-left origin, units = PDF points.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// Intrinsic page dimensions in PDF points.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSize {
    pub page_index: usize,
    pub width: f32,
    pub height: f32,
    pub rotation: i32,
}

/// Document-level metadata returned when a PDF is opened.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentMeta {
    pub id: String,
    pub path: Option<String>,
    pub title: String,
    pub author: Option<String>,
    pub subject: Option<String>,
    pub producer: Option<String>,
    pub creator: Option<String>,
    pub page_count: usize,
    pub pages: Vec<PageSize>,
    pub encrypted: bool,
    pub file_size_bytes: Option<u64>,
}

/// A run of text with a tight bounding box (the overlay unit).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSpan {
    pub index: usize,
    pub text: String,
    pub bounds: Rect,
    pub font_size: f32,
    pub font_name: Option<String>,
    pub bold: bool,
    pub italic: bool,
    pub color: Option<String>,
    pub rotation: f32,
}

/// The selectable/editable text layer for one page.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageTextLayer {
    pub page_index: usize,
    pub size: PageSize,
    pub spans: Vec<TextSpan>,
}

/// A single full-text search hit.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub page_index: usize,
    pub span_index: usize,
    pub text: String,
    pub char_start: usize,
    pub char_end: usize,
}

/// Markup annotation kinds accepted on save.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationType {
    Highlight,
    Underline,
    Strikethrough,
    Comment,
    Redaction,
}

/// A markup annotation to bake into the saved PDF.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: AnnotationType,
    pub page_index: usize,
    pub rects: Vec<Rect>,
    pub color: String,
    pub opacity: f32,
    #[serde(default)]
    pub note: Option<String>,
}

/// A pending in-place text edit to apply on save.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEdit {
    pub id: String,
    pub page_index: usize,
    pub span_index: usize,
    pub original_bounds: Rect,
    pub original_text: String,
    pub new_text: String,
    pub font_size: f32,
    pub font_name: Option<String>,
    pub color: String,
}
