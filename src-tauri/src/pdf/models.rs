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
    /// Real (matrix-scaled) font size in points, from FPDFText_GetFontSize.
    pub font_size: f32,
    /// Raw PDF font name (subset prefixes like "ABCDEF+" preserved so the
    /// save path can detect subsetted embeds; the frontend matches by
    /// substring, so the prefix is harmless there).
    pub font_name: Option<String>,
    pub bold: bool,
    pub italic: bool,
    pub color: Option<String>,
    pub rotation: f32,
    /// Baseline Y in top-left point space (from FPDFText_GetCharOrigin).
    pub baseline: f32,
}

/// The selectable/editable text layer for one page.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageTextLayer {
    pub page_index: usize,
    pub size: PageSize,
    pub spans: Vec<TextSpan>,
    /// True when the spans came from OCR (the page has no embedded text).
    pub ocr: bool,
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
    /// Wire-contract field (frontend identity); not consumed by the baker.
    #[allow(dead_code)]
    pub id: String,
    #[serde(rename = "type")]
    pub kind: AnnotationType,
    pub page_index: usize,
    pub rects: Vec<Rect>,
    pub color: String,
    pub opacity: f32,
    /// Comment body. Currently comments bake as a visible marker only; the
    /// note text lives in the app session (see ARCHITECTURE "future work").
    #[allow(dead_code)]
    #[serde(default)]
    pub note: Option<String>,
}

/// A structural page operation applied to the engine's cached document.
///
/// Ops mutate the in-memory document bytes (persisted to disk only on the
/// user's next Save); each op returns the refreshed [`DocumentMeta`] so the
/// frontend can re-layout immediately.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PageOp {
    /// Rotate one page by 90° in the given direction.
    #[serde(rename_all = "camelCase")]
    Rotate { page_index: usize, clockwise: bool },
    /// Delete one page (guarded: a document must keep at least one page).
    #[serde(rename_all = "camelCase")]
    Delete { page_index: usize },
    /// Move a page so it ends up at index `to`.
    #[serde(rename_all = "camelCase")]
    Move { from: usize, to: usize },
    /// Insert a blank page (sized like the reference page) after `after_index`.
    #[serde(rename_all = "camelCase")]
    InsertBlank { after_index: usize },
    /// Append every page of another PDF file to the end of this document.
    #[serde(rename_all = "camelCase")]
    AppendPdf { path: String },
    /// Write a single page out as a new one-page PDF (does not mutate).
    #[serde(rename_all = "camelCase")]
    ExtractPage {
        page_index: usize,
        output_path: String,
    },
}

/// A pending in-place text edit to apply on save.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextEdit {
    pub id: String,
    pub page_index: usize,
    /// Wire-contract field (span identity in the frontend text layer); the
    /// save path matches by geometry + text instead.
    #[allow(dead_code)]
    pub span_index: usize,
    pub original_bounds: Rect,
    pub original_text: String,
    pub new_text: String,
    pub font_size: f32,
    pub font_name: Option<String>,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    pub color: String,
    /// Baseline Y in top-left point space the replacement is stamped on.
    #[serde(default)]
    pub baseline: f32,
}
