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

/// Kinds of interactive AcroForm field widgets surfaced to the frontend.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FormFieldKind {
    Text,
    Checkbox,
    RadioButton,
    ComboBox,
    ListBox,
    Signature,
}

/// One interactive form-field widget on a page.
///
/// Identity is positional — `(page_index, annot_index)` names the widget
/// annotation within its page — which stays stable across re-parses of the
/// same document bytes and needs no synthetic id table on either side.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormField {
    pub page_index: usize,
    /// Index of the widget annotation within its page's annotation array.
    pub annot_index: usize,
    pub kind: FormFieldKind,
    /// Fully-qualified field name (widgets of one radio group share a name).
    pub name: Option<String>,
    /// Widget bounds in display (top-left origin) point space.
    pub bounds: Rect,
    /// Current textual value (text / combo box / list box), if any. For
    /// choice fields this is the EXPORT value (`/V`), which need not equal
    /// any display label — selection identity travels via `selected_index`.
    pub value: Option<String>,
    /// Current checked state (checkbox / radio button), if any.
    pub checked: Option<bool>,
    /// Choice options in PDF order (combo box / list box), display labels.
    pub options: Vec<String>,
    /// Index of the currently selected option (combo box / list box).
    pub selected_index: Option<usize>,
    pub read_only: bool,
    pub multiline: bool,
    pub password: bool,
    /// Whether the combo box also accepts free text (an "editable" combo).
    pub editable: bool,
}

/// A single form-field mutation, dispatched to pdfium's form-fill machinery.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FormFieldValue {
    /// Replace the full text of a text field (or editable combo box).
    #[serde(rename_all = "camelCase")]
    Text {
        page_index: usize,
        annot_index: usize,
        value: String,
    },
    /// Check or clear a checkbox.
    #[serde(rename_all = "camelCase")]
    Checkbox {
        page_index: usize,
        annot_index: usize,
        checked: bool,
    },
    /// Select this widget within its radio group.
    #[serde(rename_all = "camelCase")]
    Radio { page_index: usize, annot_index: usize },
    /// Select an option by index in a combo box or list box.
    #[serde(rename_all = "camelCase")]
    Choice {
        page_index: usize,
        annot_index: usize,
        option_index: usize,
    },
}

impl FormFieldValue {
    pub fn page_index(&self) -> usize {
        match self {
            Self::Text { page_index, .. }
            | Self::Checkbox { page_index, .. }
            | Self::Radio { page_index, .. }
            | Self::Choice { page_index, .. } => *page_index,
        }
    }

    pub fn annot_index(&self) -> usize {
        match self {
            Self::Text { annot_index, .. }
            | Self::Checkbox { annot_index, .. }
            | Self::Radio { annot_index, .. }
            | Self::Choice { annot_index, .. } => *annot_index,
        }
    }
}

/// A folder-level batch operation applied to many PDF files at once.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BatchOp {
    /// Rotate every page of every input by `clockwise_turns` × 90° and write
    /// a " (rotated)" copy of each file into `output_dir`.
    #[serde(rename_all = "camelCase")]
    Rotate {
        clockwise_turns: u32,
        output_dir: String,
    },
    /// Merge all inputs, in selection order, into one PDF at `output_path`.
    #[serde(rename_all = "camelCase")]
    Merge { output_path: String },
}

/// One input that could not be processed (the batch continues without it).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchFailure {
    pub path: String,
    pub error: String,
}

/// Outcome of a batch run.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchReport {
    pub processed: usize,
    pub outputs: Vec<String>,
    pub failures: Vec<BatchFailure>,
}

/// A placed signature (or other image) stamp to bake into the saved PDF.
///
/// The PNG arrives base64-encoded because Tauri's JSON IPC has no efficient
/// raw-bytes lane for nested fields; a signature PNG is a few KB, so the
/// overhead is immaterial.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageStamp {
    /// Wire-contract field (frontend identity); not consumed by the baker.
    #[allow(dead_code)]
    pub id: String,
    pub page_index: usize,
    /// Placement in display (top-left origin) point space.
    pub rect: Rect,
    /// PNG bytes, base64-encoded (no `data:` prefix).
    pub png_base64: String,
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
