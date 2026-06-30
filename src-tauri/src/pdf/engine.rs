//! The PDF engine.
//!
//! THREADING MODEL
//! ---------------
//! Pdfium (the underlying C++ library) is NOT thread-safe and prefers to be
//! driven from a single thread. Tauri, by contrast, dispatches commands across
//! a thread pool. To reconcile the two safely we run Pdfium on ONE dedicated
//! worker thread and talk to it over a channel: every command sends a request
//! and blocks on a per-request reply channel. This guarantees serialized,
//! same-thread access to Pdfium with no `unsafe`, no global locks leaking into
//! the rest of the app, and no self-referential lifetime gymnastics.
//!
//! DOCUMENT STORAGE
//! ----------------
//! `PdfDocument` borrows from `Pdfium`, which makes it awkward to cache across
//! calls. Instead the worker caches the raw file BYTES per document id and
//! re-parses them for each operation. Re-parsing is cheap relative to
//! rendering, and the frontend caches rasters as object URLs so pages are only
//! re-rendered on zoom changes. This keeps the design simple and robust.
//!
//! FIDELITY
//! --------
//! Display fidelity is exact: pages are rendered to high-DPI rasters by Pdfium,
//! the same engine Chrome uses, so what the user sees matches the source
//! pixel-for-pixel. Text geometry for the selection/edit overlay is converted
//! ONCE here from Pdfium's bottom-left point space into a normalized top-left
//! point space (`to_top_left_rect`), which is what makes the DOM overlay align
//! precisely with the rendered glyphs.

use std::collections::HashMap;
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::thread::JoinHandle;

use parking_lot::Mutex;
use pdfium_render::prelude::*;

use crate::error::{PdfError, PdfResult};
use crate::pdf::models::{
    Annotation, AnnotationType, DocumentMeta, PageSize, PageTextLayer, Rect, SearchHit, TextEdit,
    TextSpan,
};

/// A document held open by the engine. Only the raw bytes are retained; they
/// are re-parsed per operation (cheap relative to rendering), which sidesteps
/// the lifetime coupling between `PdfDocument` and `Pdfium`.
struct LoadedDoc {
    bytes: Vec<u8>,
}

/// Work items handled by the engine thread. Each carries a reply `Sender`.
enum EngineRequest {
    Open {
        id: String,
        bytes: Vec<u8>,
        path: Option<String>,
        name: String,
        reply: Sender<PdfResult<DocumentMeta>>,
    },
    Close {
        id: String,
        reply: Sender<PdfResult<()>>,
    },
    Render {
        id: String,
        page_index: usize,
        scale: f32,
        reply: Sender<PdfResult<Vec<u8>>>,
    },
    Text {
        id: String,
        page_index: usize,
        reply: Sender<PdfResult<PageTextLayer>>,
    },
    Search {
        id: String,
        query: String,
        reply: Sender<PdfResult<Vec<SearchHit>>>,
    },
    Save {
        id: String,
        output_path: String,
        edits: Vec<TextEdit>,
        annotations: Vec<Annotation>,
        reply: Sender<PdfResult<()>>,
    },
}

/// Public facade. Cloneable handle is stored as Tauri managed state.
pub struct PdfEngine {
    tx: Mutex<Sender<EngineRequest>>,
    _worker: JoinHandle<()>,
}

impl PdfEngine {
    /// Spawn the engine worker thread. Always succeeds; if Pdfium cannot bind,
    /// the worker records that and every operation returns `EngineUnavailable`
    /// with an actionable message instead of crashing the app.
    ///
    /// `lib_dir` is an optional first place to look for the Pdfium library —
    /// typically the app's resource directory, where the bundler installs
    /// `pdfium.dll`. The worker also falls back to the executable directory,
    /// the working directory, and the system library path.
    pub fn spawn(lib_dir: Option<PathBuf>) -> Self {
        let (tx, rx) = channel::<EngineRequest>();
        let worker = std::thread::Builder::new()
            .name("pdfium-worker".into())
            .spawn(move || run_worker(rx, lib_dir))
            .expect("failed to spawn pdfium worker thread");
        Self {
            tx: Mutex::new(tx),
            _worker: worker,
        }
    }

    /// Send a request and block on its reply.
    fn dispatch<T>(
        &self,
        make: impl FnOnce(Sender<PdfResult<T>>) -> EngineRequest,
    ) -> PdfResult<T> {
        let (reply_tx, reply_rx) = channel::<PdfResult<T>>();
        self.tx
            .lock()
            .send(make(reply_tx))
            .map_err(|_| PdfError::EngineStopped)?;
        reply_rx.recv().map_err(|_| PdfError::EngineStopped)?
    }

    pub fn open(
        &self,
        id: String,
        bytes: Vec<u8>,
        path: Option<String>,
        name: String,
    ) -> PdfResult<DocumentMeta> {
        self.dispatch(|reply| EngineRequest::Open {
            id,
            bytes,
            path,
            name,
            reply,
        })
    }

    pub fn close(&self, id: String) -> PdfResult<()> {
        self.dispatch(|reply| EngineRequest::Close { id, reply })
    }

    pub fn render(&self, id: String, page_index: usize, scale: f32) -> PdfResult<Vec<u8>> {
        self.dispatch(|reply| EngineRequest::Render {
            id,
            page_index,
            scale,
            reply,
        })
    }

    pub fn text(&self, id: String, page_index: usize) -> PdfResult<PageTextLayer> {
        self.dispatch(|reply| EngineRequest::Text {
            id,
            page_index,
            reply,
        })
    }

    pub fn search(&self, id: String, query: String) -> PdfResult<Vec<SearchHit>> {
        self.dispatch(|reply| EngineRequest::Search { id, query, reply })
    }

    pub fn save(
        &self,
        id: String,
        output_path: String,
        edits: Vec<TextEdit>,
        annotations: Vec<Annotation>,
    ) -> PdfResult<()> {
        self.dispatch(|reply| EngineRequest::Save {
            id,
            output_path,
            edits,
            annotations,
            reply,
        })
    }
}

// ===========================================================================
// Worker thread
// ===========================================================================

fn run_worker(rx: Receiver<EngineRequest>, lib_dir: Option<PathBuf>) {
    // Bind Pdfium once for the lifetime of the thread. On failure, `pdfium`
    // stays None and operations report EngineUnavailable.
    let pdfium = match init_pdfium(lib_dir.as_deref()) {
        Ok(p) => {
            log::info!("Pdfium engine initialized");
            Some(p)
        }
        Err(e) => {
            log::error!("Pdfium failed to initialize: {e}");
            None
        }
    };

    let mut docs: HashMap<String, LoadedDoc> = HashMap::new();

    while let Ok(req) = rx.recv() {
        match req {
            EngineRequest::Open {
                id,
                bytes,
                path,
                name,
                reply,
            } => {
                let result = guard(|| {
                    with_pdfium(&pdfium, |pdfium| {
                        let meta = build_meta(pdfium, &id, &bytes, path.clone(), &name)?;
                        docs.insert(id.clone(), LoadedDoc { bytes });
                        Ok(meta)
                    })
                });
                let _ = reply.send(result);
            }
            EngineRequest::Close { id, reply } => {
                docs.remove(&id);
                let _ = reply.send(Ok(()));
            }
            EngineRequest::Render {
                id,
                page_index,
                scale,
                reply,
            } => {
                let result = guard(|| {
                    with_pdfium(&pdfium, |pdfium| {
                        let doc = docs.get(&id).ok_or(PdfError::DocumentNotFound)?;
                        render_page_png(pdfium, &doc.bytes, page_index, scale)
                    })
                });
                let _ = reply.send(result);
            }
            EngineRequest::Text {
                id,
                page_index,
                reply,
            } => {
                let result = guard(|| {
                    with_pdfium(&pdfium, |pdfium| {
                        let doc = docs.get(&id).ok_or(PdfError::DocumentNotFound)?;
                        page_text_layer(pdfium, &doc.bytes, page_index)
                    })
                });
                let _ = reply.send(result);
            }
            EngineRequest::Search { id, query, reply } => {
                let result = guard(|| {
                    with_pdfium(&pdfium, |pdfium| {
                        let doc = docs.get(&id).ok_or(PdfError::DocumentNotFound)?;
                        search_document(pdfium, &doc.bytes, &query)
                    })
                });
                let _ = reply.send(result);
            }
            EngineRequest::Save {
                id,
                output_path,
                edits,
                annotations,
                reply,
            } => {
                let result = guard(|| {
                    with_pdfium(&pdfium, |pdfium| {
                        let doc = docs.get(&id).ok_or(PdfError::DocumentNotFound)?;
                        save_document(pdfium, &doc.bytes, &output_path, &edits, &annotations)
                    })
                });
                let _ = reply.send(result);
            }
        }
    }

    log::info!("Pdfium worker thread shutting down");
}

/// Run `f` only if Pdfium is available, else return EngineUnavailable.
fn with_pdfium<T>(
    pdfium: &Option<Pdfium>,
    f: impl FnOnce(&Pdfium) -> PdfResult<T>,
) -> PdfResult<T> {
    match pdfium {
        Some(p) => f(p),
        None => Err(PdfError::EngineUnavailable),
    }
}

/// Run a request handler, converting a panic (e.g. from a malformed PDF that
/// trips PDFium) into a recoverable error so a single bad operation never kills
/// the worker thread or the app. Our mutations of the document map happen
/// outside the panic-prone work, so the cached state stays consistent.
fn guard<T>(f: impl FnOnce() -> PdfResult<T>) -> PdfResult<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_or_else(|_| {
        log::error!("recovered from a panic while processing a PDF request");
        Err(PdfError::Pdfium(
            "an internal error occurred while processing this PDF".into(),
        ))
    })
}

/// Locate and bind the Pdfium dynamic library.
///
/// Tries, in order: the provided `lib_dir` (the app resource dir where the
/// bundler installs pdfium.dll), next to the executable, the current working
/// directory, then the system library path. The first that binds wins.
fn init_pdfium(lib_dir: Option<&std::path::Path>) -> Result<Pdfium, PdfiumError> {
    // 0. Explicit hint (resource directory) supplied by the app.
    if let Some(dir) = lib_dir {
        let name = Pdfium::pdfium_platform_library_name_at_path(dir);
        if let Ok(bindings) = Pdfium::bind_to_library(&name) {
            return Ok(Pdfium::new(bindings));
        }
    }
    // 1. Alongside the executable — where the installer places pdfium.dll.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let name = Pdfium::pdfium_platform_library_name_at_path(dir);
            if let Ok(bindings) = Pdfium::bind_to_library(&name) {
                return Ok(Pdfium::new(bindings));
            }
        }
    }
    // 2. Current working directory (useful during `tauri dev`).
    if let Ok(bindings) =
        Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path("./"))
    {
        return Ok(Pdfium::new(bindings));
    }
    // 3. System-installed Pdfium.
    Pdfium::bind_to_system_library().map(Pdfium::new)
}

// ===========================================================================
// Operations (all run on the worker thread)
// ===========================================================================

fn build_meta(
    pdfium: &Pdfium,
    id: &str,
    bytes: &[u8],
    path: Option<String>,
    name: &str,
) -> PdfResult<DocumentMeta> {
    let document = pdfium.load_pdf_from_byte_slice(bytes, None)?;
    let pages = document.pages();
    let page_count = pages.len() as usize;

    let mut page_sizes = Vec::with_capacity(page_count);
    for (i, page) in pages.iter().enumerate() {
        page_sizes.push(PageSize {
            page_index: i,
            width: page.width().value,
            height: page.height().value,
            rotation: rotation_degrees(&page),
        });
    }

    let meta = document.metadata();
    let title = meta
        .get(PdfDocumentMetadataTagType::Title)
        .map(|t| t.value().to_string())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| name.to_string());

    Ok(DocumentMeta {
        id: id.to_string(),
        path,
        title,
        author: metadata_value(&meta, PdfDocumentMetadataTagType::Author),
        subject: metadata_value(&meta, PdfDocumentMetadataTagType::Subject),
        producer: metadata_value(&meta, PdfDocumentMetadataTagType::Producer),
        creator: metadata_value(&meta, PdfDocumentMetadataTagType::Creator),
        page_count,
        pages: page_sizes,
        encrypted: false,
        file_size_bytes: Some(bytes.len() as u64),
    })
}

fn metadata_value(meta: &PdfMetadata, tag: PdfDocumentMetadataTagType) -> Option<String> {
    meta.get(tag)
        .map(|t| t.value().to_string())
        .filter(|s| !s.trim().is_empty())
}

fn rotation_degrees(page: &PdfPage) -> i32 {
    match page.rotation() {
        Ok(PdfPageRenderRotation::Degrees90) => 90,
        Ok(PdfPageRenderRotation::Degrees180) => 180,
        Ok(PdfPageRenderRotation::Degrees270) => 270,
        _ => 0,
    }
}

/// Render a single page to PNG bytes at `scale` (cssPixels per PDF point).
fn render_page_png(
    pdfium: &Pdfium,
    bytes: &[u8],
    page_index: usize,
    scale: f32,
) -> PdfResult<Vec<u8>> {
    let document = pdfium.load_pdf_from_byte_slice(bytes, None)?;
    let pages = document.pages();
    let page = pages
        .get(page_index as i32)
        .map_err(|_| PdfError::PageOutOfRange(page_index))?;

    let width_pts = page.width().value;
    // Clamp to a sane device-pixel ceiling to avoid pathological allocations.
    let target_w = ((width_pts * scale).round() as i32).clamp(1, 12_000);

    // Setting only the target width scales height by the same factor, so the
    // raster is produced at exactly `scale` device-pixels per point.
    let config = PdfRenderConfig::new()
        .set_target_width(target_w)
        .set_maximum_height(40_000);

    let bitmap = page.render_with_config(&config)?;
    let rgba = bitmap.as_rgba_bytes();
    let width = bitmap.width() as u32;
    let height = bitmap.height() as u32;
    encode_png(rgba, width, height)
}

/// Encode raw RGBA pixels into PNG bytes using our own `image` version (so we
/// don't couple to pdfium-render's internal image dependency).
fn encode_png(rgba: Vec<u8>, width: u32, height: u32) -> PdfResult<Vec<u8>> {
    let img = image::RgbaImage::from_raw(width, height, rgba)
        .ok_or_else(|| PdfError::Encode("pixel buffer size mismatch".into()))?;
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png)?;
    Ok(out.into_inner())
}

/// Build the selectable/editable text layer for one page.
fn page_text_layer(pdfium: &Pdfium, bytes: &[u8], page_index: usize) -> PdfResult<PageTextLayer> {
    let document = pdfium.load_pdf_from_byte_slice(bytes, None)?;
    let pages = document.pages();
    let page = pages
        .get(page_index as i32)
        .map_err(|_| PdfError::PageOutOfRange(page_index))?;

    let page_height = page.height().value;
    let size = PageSize {
        page_index,
        width: page.width().value,
        height: page_height,
        rotation: rotation_degrees(&page),
    };

    let text = page.text()?;
    let spans = build_spans(&text, page_height);

    Ok(PageTextLayer {
        page_index,
        size,
        spans,
    })
}

/// Convert a Pdfium rect (bottom-left origin, points) into our normalized
/// top-left, point-based rect.
///
/// NOTE: this y-flip is exact for pages with intrinsic rotation 0 (the common
/// case). Rotated pages (`PageSize.rotation` ∈ {90,180,270}) render correctly
/// but their text overlay is not yet rotation-corrected — see ARCHITECTURE.md
/// §15 "Known limitations". `rotation` is captured per page so a future overlay
/// transform can consume it without a wire-format change.
fn to_top_left_rect(r: &PdfRect, page_height: f32) -> Rect {
    // PdfRect exposes its edges via accessor methods returning PdfPoints.
    let left = r.left().value;
    let right = r.right().value;
    let top = r.top().value;
    let bottom = r.bottom().value;
    Rect {
        x: left.min(right),
        y: page_height - top.max(bottom),
        width: (right - left).abs(),
        height: (top - bottom).abs(),
    }
}

/// Accumulates consecutive characters into a single line-level text span.
struct SpanBuilder {
    text: String,
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
    font_size: f32,
    line_center: f32,
}

impl SpanBuilder {
    fn start(c: char, rect: &Rect) -> Self {
        Self {
            text: c.to_string(),
            x0: rect.x,
            y0: rect.y,
            x1: rect.x + rect.width,
            y1: rect.y + rect.height,
            font_size: rect.height,
            line_center: rect.y + rect.height / 2.0,
        }
    }

    /// Whether `rect` (the next glyph) belongs to this same run.
    fn accepts(&self, rect: &Rect) -> bool {
        let center = rect.y + rect.height / 2.0;
        let same_line = (center - self.line_center).abs() <= self.font_size * 0.6;
        let gap = rect.x - self.x1;
        // Break on large horizontal gaps (column / table-cell boundaries).
        let close_enough = gap <= self.font_size * 2.0;
        same_line && close_enough
    }

    fn push(&mut self, c: char, rect: &Rect) {
        self.text.push(c);
        self.x0 = self.x0.min(rect.x);
        self.y0 = self.y0.min(rect.y);
        self.x1 = self.x1.max(rect.x + rect.width);
        self.y1 = self.y1.max(rect.y + rect.height);
        self.font_size = self.font_size.max(rect.height);
        self.line_center = (self.line_center + (rect.y + rect.height / 2.0)) / 2.0;
    }

    fn finish(self, index: usize) -> TextSpan {
        TextSpan {
            index,
            text: self.text,
            bounds: Rect {
                x: self.x0,
                y: self.y0,
                width: (self.x1 - self.x0).max(0.0),
                height: (self.y1 - self.y0).max(0.0),
            },
            font_size: self.font_size,
            font_name: None,
            bold: false,
            italic: false,
            color: None,
            rotation: 0.0,
        }
    }
}

/// Group a page's characters into line-level spans suitable for an overlay.
fn build_spans(text: &PdfPageText, page_height: f32) -> Vec<TextSpan> {
    let mut spans: Vec<TextSpan> = Vec::new();
    let mut current: Option<SpanBuilder> = None;

    for ch in text.chars().iter() {
        let Some(c) = ch.unicode_char() else { continue };

        // A hard line break always terminates the current span.
        if c == '\n' || c == '\r' {
            if let Some(b) = current.take() {
                spans.push(b.finish(0));
            }
            continue;
        }

        let Ok(bounds) = ch.loose_bounds() else {
            continue;
        };
        let rect = to_top_left_rect(&bounds, page_height);

        match current.as_mut() {
            Some(b) if b.accepts(&rect) => b.push(c, &rect),
            _ => {
                if let Some(b) = current.take() {
                    spans.push(b.finish(0));
                }
                current = Some(SpanBuilder::start(c, &rect));
            }
        }
    }
    if let Some(b) = current.take() {
        spans.push(b.finish(0));
    }

    // Drop whitespace-only spans and assign stable indices.
    spans.retain(|s| !s.text.trim().is_empty());
    for (i, s) in spans.iter_mut().enumerate() {
        s.index = i;
    }
    spans
}

/// Case-insensitive full-text search across the whole document.
fn search_document(pdfium: &Pdfium, bytes: &[u8], query: &str) -> PdfResult<Vec<SearchHit>> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }

    let document = pdfium.load_pdf_from_byte_slice(bytes, None)?;
    let mut hits = Vec::new();

    for (page_index, page) in document.pages().iter().enumerate() {
        let page_height = page.height().value;
        let Ok(text) = page.text() else { continue };
        let spans = build_spans(&text, page_height);

        // Join span texts with single spaces; track each span's char offset so
        // a match can be mapped back to the span it starts in.
        let mut joined = String::new();
        let mut offsets: Vec<(usize, usize)> = Vec::new(); // (span_index, start)
        for span in &spans {
            offsets.push((span.index, joined.len()));
            joined.push_str(&span.text.to_lowercase());
            joined.push(' ');
        }

        let mut from = 0usize;
        while let Some(rel) = joined[from..].find(&needle) {
            let start = from + rel;
            let end = start + needle.len();
            let span_index = offsets
                .iter()
                .rev()
                .find(|(_, off)| *off <= start)
                .map(|(idx, _)| *idx)
                .unwrap_or(0);
            hits.push(SearchHit {
                page_index,
                span_index,
                text: query.to_string(),
                char_start: start,
                char_end: end,
            });
            from = end;
            if hits.len() >= 5_000 {
                return Ok(hits); // safety cap
            }
        }
    }

    Ok(hits)
}

// ===========================================================================
// Save / edit pipeline
// ===========================================================================
//
// Strategy (see ARCHITECTURE.md "Text editing fidelity"):
//   • Markup (highlight / underline / strikethrough / redaction) is baked in as
//     filled rectangle path objects at the recorded geometry.
//   • In-place text edits white-out the original glyph region with an opaque
//     rectangle, then stamp the replacement string as a new text object at the
//     same baseline and size using a standard font.
//
// These calls target the pdfium-render 0.9 page-object API. They are the most
// version-sensitive surface in the backend; if a point release renames an
// object constructor, the fix is localized to the helpers below.

fn save_document(
    pdfium: &Pdfium,
    bytes: &[u8],
    output_path: &str,
    edits: &[TextEdit],
    annotations: &[Annotation],
) -> PdfResult<()> {
    let mut document = pdfium.load_pdf_from_byte_slice(bytes, None)?;

    for annotation in annotations {
        apply_annotation(&document, annotation)?;
    }
    for edit in edits {
        apply_edit(&mut document, edit)?;
    }

    document.save_to_file(output_path)?;
    Ok(())
}

/// Convert our top-left point rect back into a Pdfium bottom-left `PdfRect`.
fn to_pdf_rect(r: &Rect, page_height: f32) -> PdfRect {
    let left = r.x;
    let right = r.x + r.width;
    let top = page_height - r.y;
    let bottom = page_height - (r.y + r.height);
    PdfRect::new(
        PdfPoints::new(bottom),
        PdfPoints::new(left),
        PdfPoints::new(top),
        PdfPoints::new(right),
    )
}

/// Parse a #rrggbb string into a Pdfium color at the given alpha.
fn parse_color(hex: &str, alpha: u8) -> PdfColor {
    let hex = hex.trim_start_matches('#');
    let parse = |i: usize| u8::from_str_radix(hex.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0);
    if hex.len() >= 6 {
        PdfColor::new(parse(0), parse(2), parse(4), alpha)
    } else {
        PdfColor::new(0, 0, 0, alpha)
    }
}

fn apply_annotation(document: &PdfDocument, annotation: &Annotation) -> PdfResult<()> {
    let pages = document.pages();
    let mut page = pages
        .get(annotation.page_index as i32)
        .map_err(|_| PdfError::PageOutOfRange(annotation.page_index))?;
    let page_height = page.height().value;

    let alpha = (annotation.opacity.clamp(0.0, 1.0) * 255.0).round() as u8;

    for rect in &annotation.rects {
        // For underline/strikethrough we draw a thin bar rather than the full
        // glyph box; redaction fully covers the region with an opaque fill.
        let draw_rect = match annotation.kind {
            AnnotationType::Underline => Rect {
                x: rect.x,
                y: rect.y + rect.height * 0.92,
                width: rect.width,
                height: (rect.height * 0.06).max(0.6),
            },
            AnnotationType::Strikethrough => Rect {
                x: rect.x,
                y: rect.y + rect.height * 0.45,
                width: rect.width,
                height: (rect.height * 0.06).max(0.6),
            },
            _ => *rect,
        };

        let fill = match annotation.kind {
            AnnotationType::Redaction => PdfColor::new(0, 0, 0, 255),
            AnnotationType::Comment => parse_color(&annotation.color, 255),
            _ => parse_color(&annotation.color, alpha),
        };

        let pdf_rect = to_pdf_rect(&draw_rect, page_height);
        let object = PdfPagePathObject::new_rect(document, pdf_rect, None, None, Some(fill))?;
        page.objects_mut().add_path_object(object)?;
    }

    Ok(())
}

fn apply_edit(document: &mut PdfDocument, edit: &TextEdit) -> PdfResult<()> {
    // Acquire the standard font token FIRST. `fonts_mut()` takes a mutable
    // borrow of the document; getting the token here lets that borrow end
    // before we take the immutable `pages()` borrow below.
    let font = document.fonts_mut().helvetica();

    let pages = document.pages();
    let mut page = pages
        .get(edit.page_index as i32)
        .map_err(|_| PdfError::PageOutOfRange(edit.page_index))?;
    let page_height = page.height().value;

    // 1. White-out the original text region.
    let cover_rect = to_pdf_rect(&edit.original_bounds, page_height);
    let white = PdfColor::new(255, 255, 255, 255);
    let cover = PdfPagePathObject::new_rect(document, cover_rect, None, None, Some(white))?;
    page.objects_mut().add_path_object(cover)?;

    // 2. Stamp the replacement text at the original baseline & size, using a
    // standard font (Helvetica). True embedded-font reuse is out of scope; this
    // matches the practical fidelity ceiling for editing arbitrary PDFs.
    if !edit.new_text.trim().is_empty() {
        let mut text_object = PdfPageTextObject::new(
            document,
            &edit.new_text,
            font,
            PdfPoints::new(edit.font_size.max(1.0)),
        )?;
        text_object.set_fill_color(parse_color(&edit.color, 255))?;

        // Position at the lower-left of the original box (text baseline).
        let x = edit.original_bounds.x;
        let baseline_y = page_height - (edit.original_bounds.y + edit.original_bounds.height);
        text_object.translate(PdfPoints::new(x), PdfPoints::new(baseline_y))?;

        page.objects_mut().add_text_object(text_object)?;
    }

    Ok(())
}
