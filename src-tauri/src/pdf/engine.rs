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
    Annotation, AnnotationType, DocumentMeta, PageOp, PageSize, PageTextLayer, Rect, SearchHit,
    TextEdit, TextSpan,
};
use crate::pdf::ocr::{self, OcrWordBox};

/// A document held open by the engine. The raw bytes are the SOURCE OF TRUTH:
/// structural page operations replace them in place (persisted to disk only on
/// the user's next Save), and every render/text/search re-parses them — which
/// sidesteps the lifetime coupling between `PdfDocument` and `Pdfium`.
struct LoadedDoc {
    bytes: Vec<u8>,
    /// Original file path/name, kept so metadata rebuilt after a page
    /// operation carries the same identity.
    path: Option<String>,
    name: String,
    /// Recognized (OCR) text layers, cached per page for pages that have no
    /// embedded text. Recognition costs hundreds of milliseconds per page, so
    /// results are reused by both the text layer and full-document search.
    /// Cleared whenever the document bytes change (page operations).
    ocr_layers: HashMap<usize, Vec<TextSpan>>,
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
    Transform {
        id: String,
        op: PageOp,
        reply: Sender<PdfResult<DocumentMeta>>,
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

    pub fn transform(&self, id: String, op: PageOp) -> PdfResult<DocumentMeta> {
        self.dispatch(|reply| EngineRequest::Transform { id, op, reply })
    }
}

// ===========================================================================
// Worker thread
// ===========================================================================

fn run_worker(rx: Receiver<EngineRequest>, lib_dir: Option<PathBuf>) {
    // The OCR fallback uses WinRT APIs, which require runtime initialization
    // on the calling thread (no-op on other platforms).
    ocr::platform::init_thread();

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
                        docs.insert(
                            id.clone(),
                            LoadedDoc {
                                bytes,
                                path,
                                name,
                                ocr_layers: HashMap::new(),
                            },
                        );
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
                        // Take the OCR cache out so the doc entry can be
                        // borrowed immutably for parsing while the cache is
                        // read/written locally; put it back afterwards.
                        let doc = docs.get_mut(&id).ok_or(PdfError::DocumentNotFound)?;
                        let mut cache = std::mem::take(&mut doc.ocr_layers);
                        let outcome =
                            text_layer_with_ocr(pdfium, &doc.bytes, page_index, &mut cache);
                        doc.ocr_layers = cache;
                        outcome
                    })
                });
                let _ = reply.send(result);
            }
            EngineRequest::Search { id, query, reply } => {
                let result = guard(|| {
                    with_pdfium(&pdfium, |pdfium| {
                        let doc = docs.get_mut(&id).ok_or(PdfError::DocumentNotFound)?;
                        let mut cache = std::mem::take(&mut doc.ocr_layers);
                        let outcome = search_document(pdfium, &doc.bytes, &query, &mut cache);
                        doc.ocr_layers = cache;
                        outcome
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
            EngineRequest::Transform { id, op, reply } => {
                let result = guard(|| {
                    with_pdfium(&pdfium, |pdfium| {
                        let doc = docs.get_mut(&id).ok_or(PdfError::DocumentNotFound)?;
                        // Apply the op; a mutating op returns the replacement
                        // bytes, which become the new source of truth. Cached
                        // OCR layers are keyed by the old page structure.
                        if let Some(new_bytes) = apply_page_op(pdfium, &doc.bytes, &op)? {
                            doc.bytes = new_bytes;
                            doc.ocr_layers.clear();
                        }
                        build_meta(pdfium, &id, &doc.bytes, doc.path.clone(), &doc.name)
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

    let size = PageSize {
        page_index,
        width: page.width().value,
        height: page.height().value,
        rotation: rotation_degrees(&page),
    };
    let geometry = PageGeometry::from_page(&page);

    let text = page.text()?;
    let spans = build_spans(&text, &geometry);

    Ok(PageTextLayer {
        page_index,
        size,
        spans,
        ocr: false,
    })
}

/// Produce the text layer for a page, falling back to OCR (with a per-doc
/// cache) when the page has no embedded text — the "Microsoft Print to PDF" /
/// scanned-document case, where the page is images or vector outlines only.
fn text_layer_with_ocr(
    pdfium: &Pdfium,
    bytes: &[u8],
    page_index: usize,
    cache: &mut HashMap<usize, Vec<TextSpan>>,
) -> PdfResult<PageTextLayer> {
    let layer = page_text_layer(pdfium, bytes, page_index)?;
    if !layer.spans.is_empty() {
        return Ok(layer);
    }

    let spans = match cache.get(&page_index) {
        Some(cached) => cached.clone(),
        None => {
            let document = pdfium.load_pdf_from_byte_slice(bytes, None)?;
            let pages = document.pages();
            let page = pages
                .get(page_index as i32)
                .map_err(|_| PdfError::PageOutOfRange(page_index))?;
            // A recognition failure must not take down the whole text layer:
            // degrade to "no text" (the pre-OCR behavior) and cache it so the
            // expensive render isn't retried on every scroll.
            let spans = ocr_spans_for_page(&page).unwrap_or_else(|e| {
                log::warn!("page {}: OCR failed: {e}", page_index + 1);
                Vec::new()
            });
            log::info!(
                "page {}: no embedded text; OCR recognized {} span(s)",
                page_index + 1,
                spans.len()
            );
            cache.insert(page_index, spans.clone());
            spans
        }
    };

    Ok(PageTextLayer {
        ocr: !spans.is_empty(),
        spans,
        ..layer
    })
}

/// Render a page and recognize its text with the platform OCR engine,
/// producing display-space spans. Returns an empty list when OCR is
/// unavailable (non-Windows, or no language pack).
fn ocr_spans_for_page(page: &PdfPage) -> PdfResult<Vec<TextSpan>> {
    // Skip the expensive high-resolution render entirely when recognition is
    // unavailable (non-Windows, or no OCR language pack installed).
    if !ocr::platform::available() {
        return Ok(Vec::new());
    }

    let display_w = page.width().value;
    let display_h = page.height().value;
    if display_w <= 0.0 || display_h <= 0.0 {
        return Ok(Vec::new());
    }

    // Render as large as the OCR engine allows (quality), staying safely
    // inside its dimension cap on BOTH axes: both maximum width and height
    // are clamped in the render config, and pdfium preserves aspect ratio
    // when a constraint binds — so px_per_point derived from the actual
    // rendered width stays exact even for extreme banner/plotter pages.
    let max_dim = (ocr::platform::max_dimension().min(4000) as f32) - 8.0;
    let target_long_side = 2200.0_f32.min(max_dim);
    let scale = (target_long_side / display_w.max(display_h)).clamp(0.5, 6.0);

    let config = PdfRenderConfig::new()
        .set_target_width((display_w * scale).round() as i32)
        .set_maximum_width(max_dim as i32)
        .set_maximum_height(max_dim as i32);
    let bitmap = page.render_with_config(&config)?;
    let rgba = bitmap.as_rgba_bytes();
    let px_w = bitmap.width() as i32;
    let px_h = bitmap.height() as i32;
    if px_w <= 0 || px_h <= 0 {
        return Ok(Vec::new());
    }
    // Actual pixels-per-point (robust to any rounding by the renderer).
    let px_per_point = px_w as f32 / display_w;

    // The recognizer wants BGRA8; Pdfium hands back RGBA.
    let mut bgra = rgba.clone();
    for px in bgra.chunks_exact_mut(4) {
        px.swap(0, 2);
    }

    let Some(words) = ocr::platform::recognize_words(&bgra, px_w, px_h)? else {
        return Ok(Vec::new());
    };

    Ok(ocr_words_to_spans(words, &rgba, px_w, px_h, px_per_point))
}

/// Group recognized words into line-level runs and convert to display-space
/// [`TextSpan`]s, estimating each run's ink color from the rendered pixels so
/// re-stamped edits keep the original text color.
fn ocr_words_to_spans(
    words: Vec<OcrWordBox>,
    rgba: &[u8],
    px_w: i32,
    px_h: i32,
    px_per_point: f32,
) -> Vec<TextSpan> {
    // 1. Cluster words into visual lines by vertical-center proximity.
    struct Line {
        words: Vec<OcrWordBox>,
        center_sum: f32,
        height_sum: f32,
    }
    let mut lines: Vec<Line> = Vec::new();
    'words: for word in words {
        let center = word.y + word.height / 2.0;
        for line in lines.iter_mut() {
            let line_center = line.center_sum / line.words.len() as f32;
            let line_height = line.height_sum / line.words.len() as f32;
            if (center - line_center).abs() <= line_height.max(1.0) * 0.6 {
                line.center_sum += center;
                line.height_sum += word.height;
                line.words.push(word);
                continue 'words;
            }
        }
        lines.push(Line {
            center_sum: center,
            height_sum: word.height,
            words: vec![word],
        });
    }

    // 2. Within each line (left-to-right), split into runs on column-sized
    //    gaps — the same rule the embedded-text extractor uses, which keeps
    //    table cells (the Excel case) individually editable.
    let mut spans: Vec<TextSpan> = Vec::new();
    for mut line in lines {
        line.words
            .sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));

        let mut run: Vec<&OcrWordBox> = Vec::new();
        let flush = |run: &mut Vec<&OcrWordBox>, spans: &mut Vec<TextSpan>| {
            if run.is_empty() {
                return;
            }
            let x0 = run.iter().map(|w| w.x).fold(f32::MAX, f32::min);
            let y0 = run.iter().map(|w| w.y).fold(f32::MAX, f32::min);
            let x1 = run.iter().map(|w| w.x + w.width).fold(f32::MIN, f32::max);
            let y1 = run.iter().map(|w| w.y + w.height).fold(f32::MIN, f32::max);
            let text = run
                .iter()
                .map(|w| w.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");

            let height_pt = (y1 - y0) / px_per_point;
            let bounds = Rect {
                x: x0 / px_per_point,
                y: y0 / px_per_point,
                width: (x1 - x0) / px_per_point,
                height: height_pt,
            };
            spans.push(TextSpan {
                index: 0,
                text,
                bounds,
                // Word boxes hug cap-height/ascenders; the em size is a bit
                // larger than the visual box.
                font_size: (height_pt * 1.05).max(1.0),
                font_name: None,
                bold: false,
                italic: false,
                color: estimate_ink_color(rgba, px_w, px_h, x0, y0, x1, y1),
                rotation: 0.0,
                baseline: bounds.y + height_pt * 0.85,
            });
            run.clear();
        };

        for i in 0..line.words.len() {
            if let Some(previous) = line.words.get(i.wrapping_sub(1)) {
                let word = &line.words[i];
                let gap = word.x - (previous.x + previous.width);
                if gap > word.height.max(previous.height) * 2.0 {
                    flush(&mut run, &mut spans);
                }
            }
            run.push(&line.words[i]);
        }
        flush(&mut run, &mut spans);
    }

    // Stable indices, reading order (top-to-bottom, then left-to-right).
    spans.sort_by(|a, b| {
        (a.bounds.y, a.bounds.x)
            .partial_cmp(&(b.bounds.y, b.bounds.x))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    for (i, s) in spans.iter_mut().enumerate() {
        s.index = i;
    }
    spans
}

/// Estimate the dominant ink (text) color inside a pixel rect: average the
/// pixels darker than the local midpoint luminance. Returns None for regions
/// with no discernible ink.
fn estimate_ink_color(
    rgba: &[u8],
    px_w: i32,
    px_h: i32,
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
) -> Option<String> {
    let left = (x0.floor() as i32).clamp(0, px_w - 1);
    let right = (x1.ceil() as i32).clamp(0, px_w - 1);
    let top = (y0.floor() as i32).clamp(0, px_h - 1);
    let bottom = (y1.ceil() as i32).clamp(0, px_h - 1);
    if right <= left || bottom <= top {
        return None;
    }

    // Sample at most ~4k pixels for speed.
    let area = ((right - left + 1) as i64) * ((bottom - top + 1) as i64);
    let step = (((area / 4096) as f64).sqrt().ceil() as i32).max(1);

    let luma =
        |r: u8, g: u8, b: u8| -> f32 { 0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32 };

    let mut min_l = f32::MAX;
    let mut max_l = f32::MIN;
    let mut samples: Vec<(u8, u8, u8, f32)> = Vec::new();
    let mut y = top;
    while y <= bottom {
        let mut x = left;
        while x <= right {
            let i = ((y * px_w + x) * 4) as usize;
            if i + 2 < rgba.len() {
                let (r, g, b) = (rgba[i], rgba[i + 1], rgba[i + 2]);
                let l = luma(r, g, b);
                min_l = min_l.min(l);
                max_l = max_l.max(l);
                samples.push((r, g, b, l));
            }
            x += step;
        }
        y += step;
    }
    if samples.is_empty() || max_l - min_l < 32.0 {
        return None; // flat region — no ink to measure
    }

    let threshold = (min_l + max_l) / 2.0;
    let mut count = 0u32;
    let (mut sr, mut sg, mut sb) = (0u32, 0u32, 0u32);
    for (r, g, b, l) in samples {
        if l < threshold {
            sr += r as u32;
            sg += g as u32;
            sb += b as u32;
            count += 1;
        }
    }
    if count < 4 {
        return None;
    }
    Some(format!(
        "#{:02x}{:02x}{:02x}",
        (sr / count) as u8,
        (sg / count) as u8,
        (sb / count) as u8
    ))
}

/// Per-page coordinate mapper between PDFium's UNROTATED page space (points,
/// origin bottom-left) and the normalized DISPLAY space the frontend uses
/// (points, origin top-left, matching the rendered raster).
///
/// PDFium's `/Rotate`-aware split is subtle and verified against its source:
/// `FPDF_GetPageWidth/Height` return ROTATED (display) dimensions, while text
/// char boxes and origins (`FPDFText_GetCharBox` / `GetCharOrigin`) are in
/// UNROTATED page space. This struct owns the round-trip so every extraction
/// site maps page→display and every save site maps display→page, making the
/// text overlay and all edits correct on rotated pages.
#[derive(Debug, Clone, Copy)]
struct PageGeometry {
    /// Intrinsic clockwise display rotation: 0, 90, 180 or 270.
    rotation: i32,
    /// UNROTATED page dimensions in points.
    page_w: f32,
    page_h: f32,
}

impl PageGeometry {
    fn from_page(page: &PdfPage) -> Self {
        let rotation = rotation_degrees(page);
        let display_w = page.width().value;
        let display_h = page.height().value;
        // width()/height() are post-rotation; un-swap for 90/270.
        let (page_w, page_h) = if rotation == 90 || rotation == 270 {
            (display_h, display_w)
        } else {
            (display_w, display_h)
        };
        Self {
            rotation,
            page_w,
            page_h,
        }
    }

    /// Page-space point (bottom-left origin) → display point (top-left).
    fn page_to_display(&self, x: f32, y: f32) -> (f32, f32) {
        match self.rotation {
            90 => (y, x),
            180 => (self.page_w - x, y),
            270 => (self.page_h - y, self.page_w - x),
            _ => (x, self.page_h - y),
        }
    }

    /// Display point (top-left origin) → page-space point (bottom-left).
    fn display_to_page(&self, xd: f32, yd: f32) -> (f32, f32) {
        match self.rotation {
            90 => (yd, xd),
            180 => (self.page_w - xd, yd),
            270 => (self.page_w - yd, self.page_h - xd),
            _ => (xd, self.page_h - yd),
        }
    }

    /// Pdfium rect (page space) → display rect.
    fn rect_to_display(&self, r: &PdfRect) -> Rect {
        let (x0, y0) = self.page_to_display(r.left().value, r.bottom().value);
        let (x1, y1) = self.page_to_display(r.right().value, r.top().value);
        Rect {
            x: x0.min(x1),
            y: y0.min(y1),
            width: (x1 - x0).abs(),
            height: (y1 - y0).abs(),
        }
    }

    /// Display rect → Pdfium rect (page space).
    fn rect_to_page(&self, r: &Rect) -> PdfRect {
        let (x0, y0) = self.display_to_page(r.x, r.y);
        let (x1, y1) = self.display_to_page(r.x + r.width, r.y + r.height);
        PdfRect::new(
            PdfPoints::new(y0.min(y1)),
            PdfPoints::new(x0.min(x1)),
            PdfPoints::new(y0.max(y1)),
            PdfPoints::new(x0.max(x1)),
        )
    }

    /// The 2×2 rotation matrix (a, b, c, d) that pre-rotates page-space
    /// content counter-clockwise by `rotation`, so it displays upright after
    /// the page's clockwise display rotation. Used when stamping replacement
    /// text onto rotated pages.
    fn upright_text_matrix(&self) -> (f32, f32, f32, f32) {
        match self.rotation {
            90 => (0.0, 1.0, -1.0, 0.0),
            180 => (-1.0, 0.0, 0.0, -1.0),
            270 => (0.0, -1.0, 1.0, 0.0),
            _ => (1.0, 0.0, 0.0, 1.0),
        }
    }
}

/// Convert a Pdfium rect (bottom-left origin, points) into our normalized
/// top-left, point-based rect. The documented rotation-0 reference transform;
/// production code goes through [`PageGeometry`], tests exercise this directly.
#[cfg_attr(not(test), allow(dead_code))]
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

/// Style attributes shared by every character in a span. Runs split whenever
/// any of these change, so each span is a single styled, editable unit — the
/// resolution the overlay needs for faithful font matching and edit previews.
#[derive(Clone, PartialEq)]
struct CharStyle {
    font_name: Option<String>,
    /// Matrix-scaled font size in points (0.0 when Pdfium reports none).
    font_size: f32,
    bold: bool,
    italic: bool,
    /// Fill color as "#rrggbb", when reported.
    color: Option<String>,
}

/// Classify a Pdfium font weight as bold (CSS convention: >= 600).
fn is_bold_weight(weight: &PdfFontWeight) -> bool {
    match weight {
        PdfFontWeight::Weight600
        | PdfFontWeight::Weight700Bold
        | PdfFontWeight::Weight800
        | PdfFontWeight::Weight900 => true,
        PdfFontWeight::Custom(value) => *value >= 600,
        _ => false,
    }
}

fn color_to_hex(color: &PdfColor) -> String {
    format!(
        "#{:02x}{:02x}{:02x}",
        color.red(),
        color.green(),
        color.blue()
    )
}

/// Read the style of one character. Font names keep their subset prefix
/// ("ABCDEF+…") — the save path uses it to detect subsetted embedded fonts.
fn read_char_style(ch: &PdfPageTextChar) -> CharStyle {
    let raw_name = ch.font_name();
    let font_name = if raw_name.trim().is_empty() {
        None
    } else {
        Some(raw_name.trim().to_string())
    };
    let name_lower = font_name.as_deref().unwrap_or("").to_lowercase();

    // Weight is unreliable for built-in fonts, so the name is a co-signal.
    let bold = ch
        .font_weight()
        .as_ref()
        .map(is_bold_weight)
        .unwrap_or(false)
        || name_lower.contains("bold")
        || name_lower.contains("black")
        || name_lower.contains("heavy");
    let italic =
        ch.font_is_italic() || name_lower.contains("italic") || name_lower.contains("oblique");

    let mut font_size = ch.scaled_font_size().value;
    if !font_size.is_finite() || font_size <= 0.0 {
        font_size = 0.0; // finish() falls back to the glyph-box height
    }

    CharStyle {
        font_name,
        font_size,
        bold,
        italic,
        color: ch.fill_color().ok().map(|c| color_to_hex(&c)),
    }
}

/// Accumulates consecutive same-style characters into a single text span.
struct SpanBuilder {
    text: String,
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
    line_height: f32,
    line_center: f32,
    style: CharStyle,
    /// Baseline Y (top-left space) captured from the first character.
    baseline: f32,
}

impl SpanBuilder {
    fn start(c: char, rect: &Rect, style: CharStyle, baseline: f32) -> Self {
        Self {
            text: c.to_string(),
            x0: rect.x,
            y0: rect.y,
            x1: rect.x + rect.width,
            y1: rect.y + rect.height,
            line_height: rect.height,
            line_center: rect.y + rect.height / 2.0,
            style,
            baseline,
        }
    }

    /// Whether the next glyph belongs to this run: same line, no column-sized
    /// horizontal gap, and (for non-whitespace) the same style. Whitespace
    /// characters often carry arbitrary font records, so they never split a
    /// run on style alone; likewise, a run that so far contains only
    /// whitespace adopts the first styled character's style in `push`.
    fn accepts(&self, c: char, rect: &Rect, style: &CharStyle) -> bool {
        let center = rect.y + rect.height / 2.0;
        let same_line = (center - self.line_center).abs() <= self.line_height * 0.6;
        let gap = rect.x - self.x1;
        let close_enough = gap <= self.line_height * 2.0;
        if !(same_line && close_enough) {
            return false;
        }
        if c.is_whitespace() || self.text.trim().is_empty() {
            return true;
        }
        self.style_compatible(style)
    }

    fn style_compatible(&self, style: &CharStyle) -> bool {
        let size_ok = (self.style.font_size - style.font_size).abs() <= 0.5
            || self.style.font_size == 0.0
            || style.font_size == 0.0;
        self.style.font_name == style.font_name
            && self.style.bold == style.bold
            && self.style.italic == style.italic
            && self.style.color == style.color
            && size_ok
    }

    fn push(&mut self, c: char, rect: &Rect, style: &CharStyle, baseline: f32) {
        // A run that started with whitespace carries that whitespace's junk
        // font record; adopt the first styled character's style instead.
        if !c.is_whitespace() && self.text.trim().is_empty() {
            self.style = style.clone();
            self.baseline = baseline;
        }
        self.text.push(c);
        self.x0 = self.x0.min(rect.x);
        self.y0 = self.y0.min(rect.y);
        self.x1 = self.x1.max(rect.x + rect.width);
        self.y1 = self.y1.max(rect.y + rect.height);
        self.line_height = self.line_height.max(rect.height);
        self.line_center = (self.line_center + (rect.y + rect.height / 2.0)) / 2.0;
    }

    fn finish(self, index: usize) -> TextSpan {
        let font_size = if self.style.font_size > 0.0 {
            self.style.font_size
        } else {
            (self.y1 - self.y0).max(1.0)
        };
        TextSpan {
            index,
            text: self.text,
            bounds: Rect {
                x: self.x0,
                y: self.y0,
                width: (self.x1 - self.x0).max(0.0),
                height: (self.y1 - self.y0).max(0.0),
            },
            font_size,
            font_name: self.style.font_name,
            bold: self.style.bold,
            italic: self.style.italic,
            color: self.style.color,
            rotation: 0.0,
            baseline: self.baseline,
        }
    }
}

/// Group a page's characters into style-aware, line-level spans. All geometry
/// is emitted in DISPLAY space via [`PageGeometry`], so spans are correct on
/// rotated pages too.
fn build_spans(text: &PdfPageText, geometry: &PageGeometry) -> Vec<TextSpan> {
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
        let rect = geometry.rect_to_display(&bounds);
        let style = read_char_style(&ch);
        // Baseline from the char origin mapped into display space; fall back
        // to ~80% of the glyph box (a typical ascent fraction) when Pdfium
        // can't report one.
        let baseline = ch
            .origin()
            .ok()
            .map(|(x, y)| geometry.page_to_display(x.value, y.value).1)
            .unwrap_or(rect.y + rect.height * 0.8);

        match current.as_mut() {
            Some(b) if b.accepts(c, &rect, &style) => b.push(c, &rect, &style, baseline),
            _ => {
                if let Some(b) = current.take() {
                    spans.push(b.finish(0));
                }
                current = Some(SpanBuilder::start(c, &rect, style, baseline));
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

/// Case-insensitive full-text search across the whole document. Pages without
/// embedded text are recognized via OCR (cached), so scans are searchable too.
fn search_document(
    pdfium: &Pdfium,
    bytes: &[u8],
    query: &str,
    ocr_cache: &mut HashMap<usize, Vec<TextSpan>>,
) -> PdfResult<Vec<SearchHit>> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }

    let document = pdfium.load_pdf_from_byte_slice(bytes, None)?;
    let mut hits = Vec::new();

    for (page_index, page) in document.pages().iter().enumerate() {
        let geometry = PageGeometry::from_page(&page);
        let Ok(text) = page.text() else { continue };
        let mut spans = build_spans(&text, &geometry);
        if spans.is_empty() {
            spans = match ocr_cache.get(&page_index) {
                Some(cached) => cached.clone(),
                None => {
                    let recognized = ocr_spans_for_page(&page).unwrap_or_default();
                    ocr_cache.insert(page_index, recognized.clone());
                    recognized
                }
            };
        }

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
// TEXT-EDIT FIDELITY STRATEGY (two tiers, best-first):
//
//   Tier 1 — TRUE IN-PLACE EDIT. Find the page's text object that draws the
//   edited run (bounds overlap + text match) and rewrite its string with
//   FPDFText_SetText. The object keeps its ORIGINAL font, size, matrix, color,
//   and render mode — the same mechanism Acrobat uses for same-font edits.
//   Guard: if the original font is a subsetted embed ("ABCDEF+…") it may lack
//   glyphs for characters not already used somewhere in that object, so the
//   in-place path is only taken when every replacement character is covered.
//   NOTE: set_text does NOT mark page content dirty in pdfium-render 0.9, so
//   `page.regenerate_content()` is called explicitly after in-place edits.
//
//   Tier 2 — WHITE-OUT + RE-STAMP (fallback). Cover the original glyph region,
//   then stamp the replacement as a new text object on the ORIGINAL BASELINE at
//   the extracted font size and fill color, using the closest PDF standard font
//   (Helvetica/Times/Courier × bold/italic) matched from the original font
//   name. This is the practical ceiling when the original font can't be reused.
//
// Markup (highlight / underline / strikethrough / redaction) is baked in as
// filled rectangle path objects at the recorded geometry.

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

    // Group edits per page so content regeneration happens once per page.
    let mut pages_with_edits: Vec<usize> = edits.iter().map(|e| e.page_index).collect();
    pages_with_edits.sort_unstable();
    pages_with_edits.dedup();

    for page_index in pages_with_edits {
        let page_edits: Vec<&TextEdit> = edits
            .iter()
            .filter(|e| e.page_index == page_index)
            .collect();
        apply_page_edits(&mut document, page_index, &page_edits)?;
    }

    document.save_to_file(output_path)?;
    Ok(())
}

// ===========================================================================
// Structural page operations
// ===========================================================================

/// Apply a structural page operation to the document bytes. Returns the
/// replacement bytes for mutating ops, or `None` for ops that leave the
/// document unchanged (extract, no-op move).
fn apply_page_op(pdfium: &Pdfium, bytes: &[u8], op: &PageOp) -> PdfResult<Option<Vec<u8>>> {
    match op {
        PageOp::Rotate {
            page_index,
            clockwise,
        } => {
            let document = pdfium.load_pdf_from_byte_slice(bytes, None)?;
            {
                let pages = document.pages();
                let mut page = pages
                    .get(*page_index as i32)
                    .map_err(|_| PdfError::PageOutOfRange(*page_index))?;
                let current = rotation_degrees(&page);
                let next = if *clockwise {
                    current + 90
                } else {
                    current + 270
                };
                // set_rotation is a page-dictionary change; it persists on
                // save without content regeneration.
                page.set_rotation(rotation_from_degrees(next));
            }
            Ok(Some(document.save_to_bytes()?))
        }

        PageOp::Delete { page_index } => {
            let document = pdfium.load_pdf_from_byte_slice(bytes, None)?;
            if document.pages().len() <= 1 {
                return Err(PdfError::InvalidOperation(
                    "A document must keep at least one page.".into(),
                ));
            }
            let pages = document.pages();
            pages
                .get(*page_index as i32)
                .map_err(|_| PdfError::PageOutOfRange(*page_index))?
                .delete()?;
            Ok(Some(document.save_to_bytes()?))
        }

        PageOp::Move { from, to } => {
            let mut document = pdfium.load_pdf_from_byte_slice(bytes, None)?;
            let len = document.pages().len() as usize;
            if *from >= len {
                return Err(PdfError::PageOutOfRange(*from));
            }
            if *to >= len {
                return Err(PdfError::PageOutOfRange(*to));
            }
            if from == to {
                return Ok(None);
            }
            // Pdfium has no in-document reorder, and rebuilding into a fresh
            // document via FPDF_ImportPages would silently drop document-level
            // objects (Info dictionary, bookmarks/outline, AcroForm fields).
            // Instead, mutate the ORIGINAL document: import a copy of the
            // moved page from an identical twin document at the target slot,
            // then delete the original instance.
            let twin = pdfium.load_pdf_from_byte_slice(bytes, None)?;
            let (insert_at, delete_at) = if to < from {
                (*to, *from + 1) // insertion above shifts the original down
            } else {
                (*to + 1, *from)
            };
            document
                .pages_mut()
                .copy_page_from_document(&twin, *from as i32, insert_at as i32)?;
            {
                let pages = document.pages();
                pages
                    .get(delete_at as i32)
                    .map_err(|_| PdfError::PageOutOfRange(delete_at))?
                    .delete()?;
            }
            Ok(Some(document.save_to_bytes()?))
        }

        PageOp::InsertBlank { after_index } => {
            let mut document = pdfium.load_pdf_from_byte_slice(bytes, None)?;
            let len = document.pages().len() as usize;
            if *after_index >= len {
                return Err(PdfError::PageOutOfRange(*after_index));
            }
            // Size the blank page like its reference neighbor (display dims —
            // the new page has rotation 0, so page dims == display dims).
            let (width, height) = {
                let pages = document.pages();
                let page = pages
                    .get(*after_index as i32)
                    .map_err(|_| PdfError::PageOutOfRange(*after_index))?;
                (page.width(), page.height())
            };
            document.pages_mut().create_page_at_index(
                PdfPagePaperSize::Custom(width, height),
                (*after_index + 1) as i32,
            )?;
            Ok(Some(document.save_to_bytes()?))
        }

        PageOp::AppendPdf { path } => {
            let other_bytes = std::fs::read(path).map_err(PdfError::from)?;
            let mut document = pdfium.load_pdf_from_byte_slice(bytes, None)?;
            let other = pdfium.load_pdf_from_byte_slice(&other_bytes, None)?;
            document.pages_mut().append(&other)?;
            Ok(Some(document.save_to_bytes()?))
        }

        PageOp::ExtractPage {
            page_index,
            output_path,
        } => {
            let source = pdfium.load_pdf_from_byte_slice(bytes, None)?;
            let len = source.pages().len() as usize;
            if *page_index >= len {
                return Err(PdfError::PageOutOfRange(*page_index));
            }
            let mut out = pdfium.create_new_pdf()?;
            out.pages_mut()
                .copy_page_from_document(&source, *page_index as i32, 0)?;
            out.save_to_file(output_path)?;
            Ok(None)
        }
    }
}

fn rotation_from_degrees(degrees: i32) -> PdfPageRenderRotation {
    match degrees.rem_euclid(360) {
        90 => PdfPageRenderRotation::Degrees90,
        180 => PdfPageRenderRotation::Degrees180,
        270 => PdfPageRenderRotation::Degrees270,
        _ => PdfPageRenderRotation::None,
    }
}

/// Apply all edits for one page: try the in-place tier first, then fall back
/// to white-out + re-stamp for whatever couldn't be edited in place.
fn apply_page_edits(
    document: &mut PdfDocument,
    page_index: usize,
    edits: &[&TextEdit],
) -> PdfResult<()> {
    let mut fallback: Vec<&TextEdit> = Vec::new();

    // Tier 1 (immutable document borrow; page objects mutate via handles).
    {
        let pages = document.pages();
        let mut page = pages
            .get(page_index as i32)
            .map_err(|_| PdfError::PageOutOfRange(page_index))?;
        let mut mutated = false;

        for edit in edits {
            if try_set_text_in_place(&mut page, edit)? {
                log::info!(
                    "edit {}: in-place text-object edit (original font preserved)",
                    edit.id
                );
                mutated = true;
            } else {
                fallback.push(edit);
            }
        }

        // set_text does not trip pdfium-render's content-dirty flag; without
        // this call the rewritten text would silently not survive the save.
        if mutated {
            page.regenerate_content()?;
        }
    }

    // Tier 2 (needs &mut document for fonts_mut).
    for edit in fallback {
        log::info!(
            "edit {}: fallback white-out + matched-font re-stamp",
            edit.id
        );
        apply_edit_fallback(document, edit)?;
    }

    Ok(())
}

/// Attempt a true in-place edit: locate the text object drawing the edited
/// run and rewrite its string. Returns Ok(false) when no safe match exists.
fn try_set_text_in_place(page: &mut PdfPage, edit: &TextEdit) -> PdfResult<bool> {
    let original = edit.original_text.trim();
    if original.is_empty() {
        return Ok(false);
    }
    let geometry = PageGeometry::from_page(page);
    let target = geometry.rect_to_page(&edit.original_bounds);
    // Unknown font names are treated as subsetted: we cannot prove the font
    // carries glyphs for new characters, so require coverage conservatively.
    let subsetted = edit.font_name.is_none() || is_subset_font_name(edit.font_name.as_deref());

    for mut object in page.objects().iter() {
        let Some(text_object) = object.as_text_object_mut() else {
            continue;
        };
        let Ok(quad) = text_object.bounds() else {
            continue;
        };
        let obj_rect = quad.to_rect();
        // The edited run must lie (mostly) inside this object's box…
        if overlap_fraction(&obj_rect, &target) < 0.5 {
            continue;
        }
        // …and the object must be line-shaped relative to the run. A page-
        // covering object (watermark, rotated header) whose text happens to
        // contain the edited string must not win the match. The line's
        // THICKNESS axis depends on the page rotation: display-horizontal
        // text runs along ±y in page space on 90/270 pages, so thickness is
        // page-space WIDTH there and HEIGHT otherwise.
        let vertical_advance = geometry.rotation == 90 || geometry.rotation == 270;
        let (obj_thickness, target_thickness) = if vertical_advance {
            (
                obj_rect.right().value - obj_rect.left().value,
                target.right().value - target.left().value,
            )
        } else {
            (
                obj_rect.top().value - obj_rect.bottom().value,
                target.top().value - target.bottom().value,
            )
        };
        if obj_thickness > target_thickness.max(1.0) * 4.0 {
            continue;
        }

        let existing = text_object.text();
        if existing.trim().is_empty() {
            continue; // empty text object overlapping the run — keep looking
        }

        let updated = if existing == original {
            edit.new_text.clone()
        } else if existing.contains(original) {
            // The run may occur several times in this object ("100 … 100").
            // Pick the occurrence whose position matches the edit's offset
            // along the TEXT ADVANCE axis, which rotates with the page.
            let fraction = advance_fraction(geometry.rotation, &obj_rect, &target);
            match replace_occurrence_near(&existing, original, &edit.new_text, fraction) {
                Some(updated) => updated,
                None => continue,
            }
        } else {
            // Geometric match but different text (whitespace synthesis in the
            // text page, or an earlier overlapping edit) — try the next object.
            continue;
        };

        // Subsetted embedded fonts only carry glyphs for characters the
        // document originally used; introducing new ones would render blank.
        if subsetted && !replacement_chars_covered(&edit.new_text, &existing) {
            return Ok(false);
        }

        text_object
            .set_text(updated.as_str())
            .map_err(PdfError::from)?;
        return Ok(true);
    }

    Ok(false)
}

/// Replace the occurrence of `pattern` in `text` whose byte offset is closest
/// to `expected_fraction` (0..1) of the text's length — a positional proxy for
/// "the occurrence the user actually edited".
fn replace_occurrence_near(
    text: &str,
    pattern: &str,
    replacement: &str,
    expected_fraction: f32,
) -> Option<String> {
    if pattern.is_empty() {
        return None;
    }
    let target = expected_fraction.clamp(0.0, 1.0) * text.len() as f32;
    let mut best: Option<usize> = None;
    let mut best_distance = f32::MAX;
    let mut from = 0usize;
    while let Some(found) = text[from..].find(pattern) {
        let index = from + found;
        let distance = (index as f32 - target).abs();
        if distance < best_distance {
            best_distance = distance;
            best = Some(index);
        }
        from = index + pattern.len();
        if from >= text.len() {
            break;
        }
    }
    best.map(|index| {
        let mut out = String::with_capacity(text.len() + replacement.len());
        out.push_str(&text[..index]);
        out.push_str(replacement);
        out.push_str(&text[index + pattern.len()..]);
        out
    })
}

/// Fraction (0..1) of the target run's start along the TEXT ADVANCE axis of a
/// text object, in rotated page space. Display-horizontal text advances along
/// page +x on unrotated pages, +y on /Rotate 90, −x on 180, and −y on 270.
fn advance_fraction(rotation: i32, obj: &PdfRect, target: &PdfRect) -> f32 {
    let width = (obj.right().value - obj.left().value).max(1.0);
    let height = (obj.top().value - obj.bottom().value).max(1.0);
    let fraction = match rotation {
        90 => (target.bottom().value - obj.bottom().value) / height,
        180 => (obj.right().value - target.right().value) / width,
        270 => (obj.top().value - target.top().value) / height,
        _ => (target.left().value - obj.left().value) / width,
    };
    fraction.clamp(0.0, 1.0)
}

/// True when a PDF font name carries the "ABCDEF+" subset-embedding prefix.
fn is_subset_font_name(name: Option<&str>) -> bool {
    match name {
        Some(name) if name.len() > 7 => {
            let bytes = name.as_bytes();
            bytes[6] == b'+' && bytes[..6].iter().all(|b| b.is_ascii_uppercase())
        }
        _ => false,
    }
}

/// Every non-whitespace replacement character must already occur in the text
/// the object draws today (a conservative proxy for subset glyph coverage).
fn replacement_chars_covered(new_text: &str, existing: &str) -> bool {
    let available: std::collections::HashSet<char> = existing.chars().collect();
    new_text
        .chars()
        .filter(|c| !c.is_whitespace())
        .all(|c| available.contains(&c))
}

/// Fraction of `target`'s area covered by `outer` (both bottom-left space).
fn overlap_fraction(outer: &PdfRect, target: &PdfRect) -> f32 {
    let ix = (outer.right().value.min(target.right().value)
        - outer.left().value.max(target.left().value))
    .max(0.0);
    let iy = (outer.top().value.min(target.top().value)
        - outer.bottom().value.max(target.bottom().value))
    .max(0.0);
    let target_area = (target.right().value - target.left().value).max(0.0)
        * (target.top().value - target.bottom().value).max(0.0);
    if target_area <= 0.0 {
        0.0
    } else {
        (ix * iy) / target_area
    }
}

/// Convert our top-left point rect back into a Pdfium bottom-left `PdfRect`.
/// Rotation-0 reference inverse of [`to_top_left_rect`]; production code goes
/// through [`PageGeometry`], tests exercise this directly.
#[cfg_attr(not(test), allow(dead_code))]
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
    let geometry = PageGeometry::from_page(&page);

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

        let pdf_rect = geometry.rect_to_page(&draw_rect);
        let object = PdfPagePathObject::new_rect(document, pdf_rect, None, None, Some(fill))?;
        page.objects_mut().add_path_object(object)?;
    }

    Ok(())
}

/// Classified font family used to select a PDF standard-14 substitute.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FontClass {
    Serif,
    Sans,
    Mono,
}

/// Classify a PDF font name into a family class (mirrors the frontend's
/// matchFontStyle so the saved output agrees with the on-screen preview).
fn classify_font_name(name: Option<&str>) -> FontClass {
    let name = name.unwrap_or("").to_lowercase();
    let is_mono = ["courier", "consol", "mono", "menlo", "typewriter"]
        .iter()
        .any(|m| name.contains(m));
    if is_mono {
        return FontClass::Mono;
    }
    let is_serif = [
        "times",
        "georgia",
        "garamond",
        "book",
        "palatino",
        "cambria",
        "century",
        "minion",
        "caslon",
        "baskerville",
        "serif",
    ]
    .iter()
    .any(|m| name.contains(m))
        // "Century Gothic" and friends are sans faces despite the keyword hit.
        && !name.contains("sans")
        && !name.contains("gothic");
    if is_serif {
        FontClass::Serif
    } else {
        FontClass::Sans
    }
}

/// Resolve the closest PDF standard-14 font for a name + style flags.
fn match_standard_font(
    fonts: &mut PdfFonts,
    name: Option<&str>,
    bold: bool,
    italic: bool,
) -> PdfFontToken {
    match (classify_font_name(name), bold, italic) {
        (FontClass::Serif, false, false) => fonts.times_roman(),
        (FontClass::Serif, true, false) => fonts.times_bold(),
        (FontClass::Serif, false, true) => fonts.times_italic(),
        (FontClass::Serif, true, true) => fonts.times_bold_italic(),
        (FontClass::Mono, false, false) => fonts.courier(),
        (FontClass::Mono, true, false) => fonts.courier_bold(),
        (FontClass::Mono, false, true) => fonts.courier_oblique(),
        (FontClass::Mono, true, true) => fonts.courier_bold_oblique(),
        (FontClass::Sans, false, false) => fonts.helvetica(),
        (FontClass::Sans, true, false) => fonts.helvetica_bold(),
        (FontClass::Sans, false, true) => fonts.helvetica_oblique(),
        (FontClass::Sans, true, true) => fonts.helvetica_bold_oblique(),
    }
}

/// Tier-2 fallback: white-out the original glyphs and stamp the replacement on
/// the ORIGINAL BASELINE at the extracted size/color with a matched font.
fn apply_edit_fallback(document: &mut PdfDocument, edit: &TextEdit) -> PdfResult<()> {
    // Acquire the font token FIRST: `fonts_mut()` mutably borrows the document
    // and must end before the `pages()` borrow below begins.
    let font = match_standard_font(
        document.fonts_mut(),
        edit.font_name.as_deref(),
        edit.bold,
        edit.italic,
    );

    let pages = document.pages();
    let mut page = pages
        .get(edit.page_index as i32)
        .map_err(|_| PdfError::PageOutOfRange(edit.page_index))?;
    let geometry = PageGeometry::from_page(&page);

    // 1. White-out the original text region.
    let cover_rect = geometry.rect_to_page(&edit.original_bounds);
    let white = PdfColor::new(255, 255, 255, 255);
    let cover = PdfPagePathObject::new_rect(document, cover_rect, None, None, Some(white))?;
    page.objects_mut().add_path_object(cover)?;

    // 2. Stamp the replacement text on the original baseline.
    if !edit.new_text.trim().is_empty() {
        let mut text_object = PdfPageTextObject::new(
            document,
            &edit.new_text,
            font,
            PdfPoints::new(edit.font_size.max(1.0)),
        )?;
        text_object.set_fill_color(parse_color(&edit.color, 255))?;

        // Baseline START in display space; prefer the extracted baseline and
        // fall back to the box bottom for edits recorded without one.
        let baseline_display_y = if edit.baseline.is_finite() && edit.baseline > 0.0 {
            edit.baseline
        } else {
            edit.original_bounds.y + edit.original_bounds.height
        };
        let (px, py) = geometry.display_to_page(edit.original_bounds.x, baseline_display_y);

        // Pre-rotate the glyphs counter-clockwise by the page rotation so they
        // display upright, then place them on the mapped baseline point.
        let (a, b, c, d) = geometry.upright_text_matrix();
        text_object.transform(a, b, c, d, px, py)?;

        page.objects_mut().add_text_object(text_object)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn top_left_and_pdf_rect_conversions_round_trip() {
        let page_height = 792.0;
        let original = PdfRect::new_from_values(700.0, 72.0, 720.0, 300.0);
        let top_left = to_top_left_rect(&original, page_height);
        assert!((top_left.x - 72.0).abs() < 1e-4);
        assert!((top_left.y - 72.0).abs() < 1e-4); // 792 - 720
        assert!((top_left.width - 228.0).abs() < 1e-4);
        assert!((top_left.height - 20.0).abs() < 1e-4);

        let back = to_pdf_rect(&top_left, page_height);
        assert!((back.left().value - original.left().value).abs() < 1e-4);
        assert!((back.right().value - original.right().value).abs() < 1e-4);
        assert!((back.top().value - original.top().value).abs() < 1e-4);
        assert!((back.bottom().value - original.bottom().value).abs() < 1e-4);
    }

    #[test]
    fn subset_font_names_are_detected() {
        assert!(is_subset_font_name(Some("ABCDEF+TimesNewRomanPSMT")));
        assert!(!is_subset_font_name(Some("TimesNewRomanPSMT")));
        assert!(!is_subset_font_name(Some("abcdef+Times"))); // lowercase tag
        assert!(!is_subset_font_name(Some("AB+Times"))); // wrong tag length
        assert!(!is_subset_font_name(None));
    }

    #[test]
    fn replacement_coverage_is_conservative() {
        assert!(replacement_chars_covered("cat", "the cast"));
        assert!(replacement_chars_covered("  cat  ", "the cast")); // ws ignored
        assert!(!replacement_chars_covered("catz", "the cast"));
        assert!(replacement_chars_covered("", "anything"));
    }

    #[test]
    fn font_classification_matches_families() {
        assert_eq!(
            classify_font_name(Some("ABCDEF+TimesNewRomanPS-BoldMT")),
            FontClass::Serif
        );
        assert_eq!(classify_font_name(Some("CourierNewPSMT")), FontClass::Mono);
        assert_eq!(classify_font_name(Some("Arial-ItalicMT")), FontClass::Sans);
        assert_eq!(classify_font_name(Some("PT Sans-Serif")), FontClass::Sans);
        assert_eq!(classify_font_name(Some("CenturyGothic")), FontClass::Sans);
        assert_eq!(
            classify_font_name(Some("CenturySchoolbook")),
            FontClass::Serif
        );
        assert_eq!(classify_font_name(None), FontClass::Sans);
    }

    #[test]
    fn occurrence_replacement_picks_the_nearest_match() {
        // Two occurrences of "100": bytes 7 and 15 in a 18-byte string.
        let text = "Total: 100 and 100";
        // An edit near the start should hit the first occurrence…
        assert_eq!(
            replace_occurrence_near(text, "100", "999", 0.3).as_deref(),
            Some("Total: 999 and 100")
        );
        // …and one near the end should hit the second.
        assert_eq!(
            replace_occurrence_near(text, "100", "999", 0.9).as_deref(),
            Some("Total: 100 and 999")
        );
        // Absent pattern → None; empty pattern → None.
        assert_eq!(replace_occurrence_near(text, "200", "x", 0.5), None);
        assert_eq!(replace_occurrence_near(text, "", "x", 0.5), None);
        // Replacement longer/shorter than the pattern keeps surroundings.
        assert_eq!(
            replace_occurrence_near("abc", "b", "BBB", 0.0).as_deref(),
            Some("aBBBc")
        );
    }

    #[test]
    fn bold_weights_classify_correctly() {
        assert!(is_bold_weight(&PdfFontWeight::Weight700Bold));
        assert!(is_bold_weight(&PdfFontWeight::Weight600));
        assert!(is_bold_weight(&PdfFontWeight::Custom(650)));
        assert!(!is_bold_weight(&PdfFontWeight::Weight400Normal));
        assert!(!is_bold_weight(&PdfFontWeight::Custom(300)));
    }

    #[test]
    fn page_geometry_points_round_trip_for_all_rotations() {
        for &rotation in &[0, 90, 180, 270] {
            let g = PageGeometry {
                rotation,
                page_w: 612.0,
                page_h: 792.0,
            };
            let (display_w, display_h) = if rotation == 90 || rotation == 270 {
                (792.0, 612.0)
            } else {
                (612.0, 792.0)
            };
            for &(x, y) in &[
                (0.0_f32, 0.0_f32),
                (612.0, 792.0),
                (100.0, 200.0),
                (50.5, 700.25),
            ] {
                let (xd, yd) = g.page_to_display(x, y);
                // Display points stay within the rotated display box.
                assert!(
                    xd >= -1e-3 && xd <= display_w + 1e-3,
                    "rot {rotation}: xd {xd} outside 0..{display_w}"
                );
                assert!(
                    yd >= -1e-3 && yd <= display_h + 1e-3,
                    "rot {rotation}: yd {yd} outside 0..{display_h}"
                );
                // And the mapping inverts exactly.
                let (x2, y2) = g.display_to_page(xd, yd);
                assert!(
                    (x - x2).abs() < 1e-3 && (y - y2).abs() < 1e-3,
                    "rot {rotation}: ({x},{y}) -> ({xd},{yd}) -> ({x2},{y2})"
                );
            }
        }
    }

    #[test]
    fn page_geometry_orients_known_corners() {
        // A 612x792 portrait page rotated 90° clockwise displays 792x612.
        let g = PageGeometry {
            rotation: 90,
            page_w: 612.0,
            page_h: 792.0,
        };
        // Page bottom-left lands at display top-left.
        assert_eq!(g.page_to_display(0.0, 0.0), (0.0, 0.0));
        // Page top-left lands at display top-right.
        assert_eq!(g.page_to_display(0.0, 792.0), (792.0, 0.0));
        // Page bottom-right lands at display bottom-left.
        assert_eq!(g.page_to_display(612.0, 0.0), (0.0, 612.0));
    }

    #[test]
    fn page_geometry_rects_round_trip_for_all_rotations() {
        for &rotation in &[0, 90, 180, 270] {
            let g = PageGeometry {
                rotation,
                page_w: 612.0,
                page_h: 792.0,
            };
            let original = PdfRect::new_from_values(100.0, 72.0, 120.0, 300.0);
            let display = g.rect_to_display(&original);
            assert!(display.width > 0.0 && display.height > 0.0);
            let back = g.rect_to_page(&display);
            for (a, b) in [
                (back.left().value, original.left().value),
                (back.right().value, original.right().value),
                (back.top().value, original.top().value),
                (back.bottom().value, original.bottom().value),
            ] {
                assert!((a - b).abs() < 1e-3, "rot {rotation}: {a} != {b}");
            }
        }
    }

    #[test]
    fn move_insert_delete_indices_produce_the_right_permutation() {
        // Simulate insert-copy-then-delete on a Vec to prove the index math
        // matches the intended remove(from)+insert(to) permutation.
        fn simulate(len: usize, from: usize, to: usize) -> Vec<usize> {
            let (insert_at, delete_at) = if to < from {
                (to, from + 1)
            } else {
                (to + 1, from)
            };
            let mut pages: Vec<usize> = (0..len).collect();
            pages.insert(insert_at, pages[from]);
            pages.remove(delete_at);
            pages
        }
        fn expected(len: usize, from: usize, to: usize) -> Vec<usize> {
            let mut pages: Vec<usize> = (0..len).collect();
            let page = pages.remove(from);
            pages.insert(to, page);
            pages
        }
        for len in 1..=6 {
            for from in 0..len {
                for to in 0..len {
                    if from == to {
                        continue;
                    }
                    assert_eq!(
                        simulate(len, from, to),
                        expected(len, from, to),
                        "len {len} from {from} to {to}"
                    );
                }
            }
        }
    }

    #[test]
    fn advance_fraction_follows_the_rotated_text_axis() {
        // Object occupying x 0..100, y 0..20 (page space) for rot 0/180, and
        // x 0..20, y 0..100 for rot 90/270 (display-horizontal text becomes a
        // vertical strip in page space).
        let obj_h = PdfRect::new_from_values(0.0, 0.0, 20.0, 100.0);
        let obj_v = PdfRect::new_from_values(0.0, 0.0, 100.0, 20.0);

        // rot 0: a run starting at x=75 sits at fraction 0.75.
        let t0 = PdfRect::new_from_values(0.0, 75.0, 20.0, 95.0);
        assert!((advance_fraction(0, &obj_h, &t0) - 0.75).abs() < 1e-4);

        // rot 180: advance is −x, so a run whose RIGHT edge is at x=25 is 75%
        // of the way along the reading order.
        let t180 = PdfRect::new_from_values(0.0, 5.0, 20.0, 25.0);
        assert!((advance_fraction(180, &obj_h, &t180) - 0.75).abs() < 1e-4);

        // rot 90: advance is +y; run starting at y=75 → 0.75.
        let t90 = PdfRect::new_from_values(75.0, 0.0, 95.0, 20.0);
        assert!((advance_fraction(90, &obj_v, &t90) - 0.75).abs() < 1e-4);

        // rot 270: advance is −y; run whose TOP is at y=25 → 0.75.
        let t270 = PdfRect::new_from_values(5.0, 0.0, 25.0, 20.0);
        assert!((advance_fraction(270, &obj_v, &t270) - 0.75).abs() < 1e-4);
    }

    #[test]
    fn rotation_degree_helpers_cycle() {
        assert!(matches!(
            rotation_from_degrees(90),
            PdfPageRenderRotation::Degrees90
        ));
        assert!(matches!(
            rotation_from_degrees(360),
            PdfPageRenderRotation::None
        ));
        assert!(matches!(
            rotation_from_degrees(270 + 90),
            PdfPageRenderRotation::None
        ));
        assert!(matches!(
            rotation_from_degrees(0 + 270),
            PdfPageRenderRotation::Degrees270
        ));
    }

    #[test]
    fn overlap_fraction_measures_target_coverage() {
        let outer = PdfRect::new_from_values(0.0, 0.0, 100.0, 200.0);
        let inside = PdfRect::new_from_values(10.0, 10.0, 50.0, 100.0);
        assert!((overlap_fraction(&outer, &inside) - 1.0).abs() < 1e-5);

        let half = PdfRect::new_from_values(0.0, 150.0, 100.0, 250.0);
        assert!((overlap_fraction(&outer, &half) - 0.5).abs() < 1e-5);

        let outside = PdfRect::new_from_values(0.0, 300.0, 100.0, 400.0);
        assert!(overlap_fraction(&outer, &outside) < 1e-5);
    }
}
