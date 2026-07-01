//! Tauri command handlers — the IPC surface the frontend calls.
//!
//! These are thin: they validate/marshal arguments, delegate to the
//! [`PdfEngine`], and return either typed JSON (serde) or, for rendered images,
//! a raw byte [`Response`] that arrives in JS as an `ArrayBuffer` (no base64
//! overhead). Tauri maps camelCase JS argument keys to these snake_case params
//! automatically.

use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use tauri::State;
use uuid::Uuid;

use crate::error::{PdfError, PdfResult};
use crate::pdf::engine::PdfEngine;
use crate::pdf::models::{Annotation, DocumentMeta, PageOp, PageTextLayer, SearchHit, TextEdit};

/// Derive a friendly display name from a file path.
fn file_stem_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "Document".to_string())
}

/// Open a PDF from an absolute file-system path.
#[tauri::command]
pub fn open_pdf(engine: State<'_, PdfEngine>, path: String) -> PdfResult<DocumentMeta> {
    let bytes = std::fs::read(&path).map_err(PdfError::from)?;
    let name = file_stem_name(&path);
    let id = Uuid::new_v4().to_string();
    log::info!("Opening PDF '{}' ({} bytes)", name, bytes.len());
    engine.open(id, bytes, Some(path), name)
}

/// Open a PDF supplied as raw bytes (e.g. drag-and-drop).
#[tauri::command]
pub fn open_pdf_bytes(
    engine: State<'_, PdfEngine>,
    bytes: Vec<u8>,
    name: String,
) -> PdfResult<DocumentMeta> {
    let id = Uuid::new_v4().to_string();
    log::info!("Opening in-memory PDF '{}' ({} bytes)", name, bytes.len());
    engine.open(id, bytes, None, name)
}

/// Release backend resources for a document.
#[tauri::command]
pub fn close_pdf(engine: State<'_, PdfEngine>, id: String) -> PdfResult<()> {
    engine.close(id)
}

/// Render a page to a PNG at the given scale and return it base64-encoded. The
/// frontend wraps this in a `data:image/png;base64,…` URL. Base64 is a little
/// larger on the wire than raw bytes, but it is a rock-solid transport that
/// avoids binary-IPC / blob-URL edge cases, and rasters are cached client-side.
#[tauri::command]
pub fn render_page(
    engine: State<'_, PdfEngine>,
    id: String,
    page_index: usize,
    scale: f32,
) -> PdfResult<String> {
    let png = engine.render(id, page_index, scale.clamp(0.05, 8.0))?;
    Ok(STANDARD.encode(png))
}

/// Fetch the selectable/editable text layer for a page.
#[tauri::command]
pub fn get_page_text(
    engine: State<'_, PdfEngine>,
    id: String,
    page_index: usize,
) -> PdfResult<PageTextLayer> {
    engine.text(id, page_index)
}

/// Search the whole document (case-insensitive).
#[tauri::command]
pub fn search_text(
    engine: State<'_, PdfEngine>,
    id: String,
    query: String,
) -> PdfResult<Vec<SearchHit>> {
    engine.search(id, query)
}

/// Apply a structural page operation (rotate / delete / move / insert blank /
/// append PDF / extract page) to the engine's cached document and return the
/// refreshed metadata. Mutations live in memory until the user saves.
#[tauri::command]
pub fn transform_pages(
    engine: State<'_, PdfEngine>,
    id: String,
    op: PageOp,
) -> PdfResult<DocumentMeta> {
    log::info!("Applying page op {:?}", op);
    engine.transform(id, op)
}

/// Write a UTF-8 text file (used by the mortgage-estimate export). The path is
/// chosen by the user via the native save dialog, so this is the same trusted
/// flow as saving a PDF.
#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> PdfResult<()> {
    std::fs::write(&path, contents).map_err(PdfError::from)
}

/// Apply pending edits + annotations and save to a new PDF at `output_path`.
#[tauri::command]
pub fn save_document(
    engine: State<'_, PdfEngine>,
    id: String,
    output_path: String,
    edits: Vec<TextEdit>,
    annotations: Vec<Annotation>,
) -> PdfResult<()> {
    log::info!(
        "Saving '{}' with {} edit(s), {} annotation(s)",
        output_path,
        edits.len(),
        annotations.len()
    );
    engine.save(id, output_path, edits, annotations)
}
