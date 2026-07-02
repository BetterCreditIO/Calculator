/**
 * Shared PDF domain types.
 *
 * These mirror the serde-serialized structs returned by the Rust backend
 * (see `src-tauri/src/pdf/models.rs`). Keep the two in lockstep: the field
 * names here use camelCase and the Rust side uses `#[serde(rename_all =
 * "camelCase")]` so the wire format matches exactly.
 *
 * COORDINATE SYSTEM
 * -----------------
 * PDFium's native coordinate space is points (1/72") with the origin at the
 * bottom-left of the page. That is awkward for the DOM, whose origin is
 * top-left in CSS pixels. To keep the frontend simple and the text overlay
 * pixel-accurate, the Rust backend converts every geometry value into a
 * normalized, top-left, point-based space BEFORE serialization:
 *
 *   - `x`, `y` are measured from the TOP-LEFT of the page, in PDF points.
 *   - `width`, `height` are in PDF points.
 *
 * The frontend then multiplies by `scale` (cssPixels / point) to place the
 * overlay over the rendered raster. This single conversion point is the key
 * to high text-positioning fidelity.
 */

/** Axis-aligned rectangle in top-left, point-based page space. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Document-level metadata extracted from the PDF. */
export interface DocumentMeta {
  /** Opaque handle assigned by the backend for subsequent calls. */
  id: string;
  /** Absolute file-system path the document was loaded from (if any). */
  path: string | null;
  /** Suggested display name (file stem or document title). */
  title: string;
  author: string | null;
  subject: string | null;
  /** Producer/creator application strings, when present. */
  producer: string | null;
  creator: string | null;
  pageCount: number;
  /** Per-page intrinsic size in PDF points (width × height). */
  pages: PageSize[];
  /** Whether the document is encrypted / password protected. */
  encrypted: boolean;
  /** Bytes on disk, for the UI status bar. */
  fileSizeBytes: number | null;
}

/** Intrinsic page dimensions in PDF points. */
export interface PageSize {
  pageIndex: number;
  width: number;
  height: number;
  /** Page rotation in degrees (0, 90, 180, 270) as authored in the PDF. */
  rotation: number;
}

/**
 * A run of text with a tight bounding box. Spans are the unit of the
 * selectable/editable text overlay. The backend groups characters into spans
 * that share a line and styling so the overlay stays light-weight while
 * remaining positionally accurate.
 */
export interface TextSpan {
  /** Stable index within the page's span list. */
  index: number;
  text: string;
  /** Tight bounding box of the run in top-left point space. */
  bounds: Rect;
  /**
   * Real font size in points as reported by the PDF (not glyph height), when
   * available; otherwise derived from the glyph box.
   */
  fontSize: number;
  /** Reported font family/name from the PDF (subset prefix stripped). */
  fontName: string | null;
  /** Style flags from the font's weight / name. */
  bold: boolean;
  italic: boolean;
  /** Text fill color as #rrggbb, when the PDF reports one. */
  color: string | null;
  /**
   * Baseline-relative rotation in degrees. 0 for normal horizontal text.
   * Non-zero values let the overlay rotate the editable box to match.
   */
  rotation: number;
  /**
   * Y of the text baseline in top-left point space. Re-stamped edits are
   * positioned on this exact baseline, which is what keeps replacement text
   * vertically locked to the original line.
   */
  baseline: number;
}

/** The selectable/editable text layer for a single page. */
export interface PageTextLayer {
  pageIndex: number;
  /** Page size used to compute the layout (for scale derivation). */
  size: PageSize;
  spans: TextSpan[];
  /**
   * True when the spans were produced by OCR because the page has no embedded
   * text (scans, "print to PDF" rasters). Selection/search/editing all work;
   * edits re-stamp in a matched font via the standard Tier-2 path.
   */
  ocr: boolean;
}

/**
 * A rendered raster of a page. The pixel data is delivered out-of-band as an
 * object URL created from the raw bytes returned over IPC; this struct carries
 * only the geometry so the component can size the canvas before paint.
 */
export interface RenderedPage {
  pageIndex: number;
  /** Raster width/height in device pixels. */
  pixelWidth: number;
  pixelHeight: number;
  /** The scale (cssPixels / point) the raster was produced at. */
  scale: number;
  /** Object URL pointing at the decoded PNG blob. Revoke when replaced. */
  objectUrl: string;
}

/** Supported annotation kinds for the markup tools. */
export type AnnotationType =
  | "highlight"
  | "underline"
  | "strikethrough"
  | "comment"
  | "redaction";

/** A markup annotation anchored to a page region. */
export interface Annotation {
  id: string;
  type: AnnotationType;
  pageIndex: number;
  /** One or more rects (multi-line selections span several rects). */
  rects: Rect[];
  color: string;
  opacity: number;
  /** Free-text note body for comment annotations. */
  note?: string;
  /** ISO timestamp the annotation was created. */
  createdAt: string;
  author?: string;
}

/**
 * A placed signature (or other image) stamp. Lives in the session like an
 * annotation — movable, resizable, undoable — and is baked into the page as a
 * real image XObject on save.
 */
export interface ImageStamp {
  id: string;
  pageIndex: number;
  /** Placement in display (top-left origin) point space. */
  rect: Rect;
  /** PNG bytes, base64-encoded (no `data:` prefix). Transparent background. */
  pngBase64: string;
}

/** Kinds of interactive AcroForm field widgets surfaced by the backend. */
export type FormFieldKind =
  | "text"
  | "checkbox"
  | "radioButton"
  | "comboBox"
  | "listBox"
  | "signature";

/**
 * One interactive form-field widget on a page. Identity is positional —
 * `(pageIndex, annotIndex)` names the widget annotation within its page — and
 * stays stable across re-parses of the same document bytes.
 */
export interface FormField {
  pageIndex: number;
  /** Index of the widget annotation within its page's annotation array. */
  annotIndex: number;
  kind: FormFieldKind;
  /** Fully-qualified field name (widgets of one radio group share a name). */
  name: string | null;
  /** Widget bounds in display (top-left origin) point space. */
  bounds: Rect;
  /**
   * Current textual value (text / combo box / list box), if any. For choice
   * fields this is the EXPORT value (`/V`), which need not equal any display
   * label — selection identity travels via `selectedIndex`.
   */
  value: string | null;
  /** Current checked state (checkbox / radio button), if any. */
  checked: boolean | null;
  /** Choice options in PDF order (combo box / list box), display labels. */
  options: string[];
  /** Index of the currently selected option (combo box / list box). */
  selectedIndex: number | null;
  readOnly: boolean;
  multiline: boolean;
  password: boolean;
  /** Whether the combo box also accepts free text (an "editable" combo). */
  editable: boolean;
}

/**
 * A single form-field mutation. Mirrors the Rust `FormFieldValue` enum (serde
 * internally-tagged with camelCase variants). Applied through pdfium's
 * form-fill machinery so widget appearance streams regenerate correctly.
 */
export type FormFieldValue =
  | { kind: "text"; pageIndex: number; annotIndex: number; value: string }
  | { kind: "checkbox"; pageIndex: number; annotIndex: number; checked: boolean }
  | { kind: "radio"; pageIndex: number; annotIndex: number }
  | { kind: "choice"; pageIndex: number; annotIndex: number; optionIndex: number };

/**
 * A pending in-place text edit. The original span is recorded so the backend
 * can redact it and re-stamp the replacement text at the same geometry on save.
 */
export interface TextEdit {
  id: string;
  pageIndex: number;
  /** Index of the span being replaced (from the page's text layer). */
  spanIndex: number;
  /** Geometry of the original run (point space, top-left origin). */
  originalBounds: Rect;
  originalText: string;
  newText: string;
  fontSize: number;
  fontName: string | null;
  bold: boolean;
  italic: boolean;
  color: string;
  /** Baseline Y (top-left point space) the replacement text is stamped on. */
  baseline: number;
  /**
   * Fill painted behind the replacement when the edit is re-stamped
   * (#rrggbb): sampled from the page raster around the original run
   * ("auto-match"), or user-chosen. `null` paints nothing — a fully
   * transparent edit.
   */
  background: string | null;
  /**
   * True when the user explicitly chose the background. Explicit choices
   * force the paint-behind save path, so the color is really applied even
   * where an in-place (no-paint) edit would have succeeded.
   */
  backgroundExplicit: boolean;
}
