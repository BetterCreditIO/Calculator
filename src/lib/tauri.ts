/**
 * Typed bridge to the Rust backend.
 *
 * Every Tauri command the frontend can call is wrapped here in exactly one
 * typed function. Keeping the IPC surface in a single module means:
 *   - the command names ("open_pdf", …) live in one place and can't drift,
 *   - argument/return types are checked at every call site,
 *   - errors are normalized into a single {@link BackendError} shape, and
 *   - the app degrades gracefully when run outside a Tauri window (tests,
 *     storybook, plain `vite` preview) instead of throwing opaquely.
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type {
  DocumentMeta,
  PageTextLayer,
  TextEdit,
  Annotation,
  FormField,
  FormFieldValue,
  ImageStamp,
} from "@/types/pdf";

/** True when running inside a Tauri webview (vs. a plain browser tab). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Normalized error surfaced from any backend command. */
export class BackendError extends Error {
  readonly command: string;
  readonly cause: unknown;
  constructor(command: string, cause: unknown) {
    super(
      typeof cause === "string"
        ? cause
        : cause instanceof Error
          ? cause.message
          : `The "${command}" operation failed.`,
    );
    this.name = "BackendError";
    this.command = command;
    this.cause = cause;
  }
}

/** Thin wrapper that adds command context to any failure. */
async function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauri()) {
    throw new BackendError(
      command,
      "This action requires the desktop app (the backend is unavailable in a browser).",
    );
  }
  try {
    return await tauriInvoke<T>(command, args);
  } catch (cause) {
    throw new BackendError(command, cause);
  }
}

// ---------------------------------------------------------------------------
// Document lifecycle
// ---------------------------------------------------------------------------

/** Open a PDF from an absolute file path; returns its metadata. */
export function openPdf(path: string): Promise<DocumentMeta> {
  return invoke<DocumentMeta>("open_pdf", { path });
}

/**
 * Open a PDF supplied as raw bytes (e.g. drag-and-drop), giving it a display
 * name. The backend keeps the bytes in memory under the returned id.
 */
export function openPdfBytes(
  bytes: Uint8Array,
  name: string,
): Promise<DocumentMeta> {
  return invoke<DocumentMeta>("open_pdf_bytes", {
    bytes: Array.from(bytes),
    name,
  });
}

/** Release all backend resources held for a document. */
export function closePdf(id: string): Promise<void> {
  return invoke<void>("close_pdf", { id });
}

// ---------------------------------------------------------------------------
// Rendering & text
// ---------------------------------------------------------------------------

/**
 * Render a page at the given scale (cssPixels per PDF point) and return a ready
 * `data:image/png;base64,…` URL suitable for an `<img src>`. The backend
 * base64-encodes the PNG; data URLs need no lifecycle management (no
 * `revokeObjectURL`) and are permitted by the app's `img-src data:` CSP.
 */
export async function renderPage(
  id: string,
  pageIndex: number,
  scale: number,
): Promise<string> {
  const base64 = await invoke<string>("render_page", { id, pageIndex, scale });
  return `data:image/png;base64,${base64}`;
}

/** Extract the selectable/editable text layer for a single page. */
export function getPageText(
  id: string,
  pageIndex: number,
): Promise<PageTextLayer> {
  return invoke<PageTextLayer>("get_page_text", { id, pageIndex });
}

/** A single full-text search hit. */
export interface SearchHit {
  pageIndex: number;
  spanIndex: number;
  text: string;
  /** Character offset of the match within the page's text. */
  charStart: number;
  charEnd: number;
}

/** Search the whole document for `query`; case-insensitive. */
export function searchText(id: string, query: string): Promise<SearchHit[]> {
  return invoke<SearchHit[]>("search_text", { id, query });
}

// ---------------------------------------------------------------------------
// Editing & export
// ---------------------------------------------------------------------------

/**
 * A structural page operation. Mirrors the Rust `PageOp` enum (serde
 * internally-tagged with camelCase variants). Ops mutate the engine's cached
 * document in memory; the file on disk changes only on the next Save.
 */
export type PageOp =
  | { type: "rotate"; pageIndex: number; clockwise: boolean }
  | { type: "delete"; pageIndex: number }
  | { type: "move"; from: number; to: number }
  | { type: "insertBlank"; afterIndex: number }
  | { type: "appendPdf"; path: string }
  | { type: "extractPage"; pageIndex: number; outputPath: string };

/** Apply a page operation; returns the document's refreshed metadata. */
export function transformPages(id: string, op: PageOp): Promise<DocumentMeta> {
  return invoke<DocumentMeta>("transform_pages", { id, op });
}

/**
 * List the document's interactive form-field widgets (empty when the PDF has
 * no AcroForm).
 */
export function listFormFields(id: string): Promise<FormField[]> {
  return invoke<FormField[]>("list_form_fields", { id });
}

/**
 * Apply form-field values through pdfium's form-fill machinery and return the
 * authoritative post-fill field state (a radio selection clears its group
 * siblings, text may be truncated to the field's MaxLen, etc.). Mutates the
 * engine's in-memory document; the file on disk changes on the next Save.
 */
export function fillFormFields(
  id: string,
  values: FormFieldValue[],
): Promise<FormField[]> {
  return invoke<FormField[]>("fill_form_fields", { id, values });
}

/**
 * A batch operation over many PDF files. Mirrors the Rust `BatchOp` enum
 * (serde internally-tagged, camelCase variants).
 */
export type BatchOp =
  | { type: "rotate"; clockwiseTurns: number; outputDir: string }
  | { type: "merge"; outputPath: string };

/** One input a batch could not process (the rest of the batch continued). */
export interface BatchFailure {
  path: string;
  error: string;
}

/** Outcome of a batch run. */
export interface BatchReport {
  processed: number;
  outputs: string[];
  failures: BatchFailure[];
}

/**
 * Run a batch operation (rotate copies / merge into one packet) across many
 * PDF files. Outputs are always NEW files — a batch never overwrites.
 */
export function batchProcess(
  inputs: string[],
  op: BatchOp,
): Promise<BatchReport> {
  return invoke<BatchReport>("batch_process", { inputs, op });
}

/** Write a UTF-8 text file to a user-chosen path (mortgage-estimate export). */
export function writeTextFile(path: string, contents: string): Promise<void> {
  return invoke<void>("write_text_file", { path, contents });
}

/** Write a binary file (base64-encoded) to a user-chosen path (.docx export). */
export function writeBinaryFile(
  path: string,
  contentsBase64: string,
): Promise<void> {
  return invoke<void>("write_binary_file", { path, contentsBase64 });
}

/**
 * Persist all pending edits, annotations, and signature stamps to a new PDF
 * at `outputPath`.
 *
 * The backend applies text edits by redacting the original glyph region and
 * re-stamping replacement text at the recorded geometry/size, bakes in the
 * markup annotations, and embeds signature stamps as real image XObjects. See
 * `src-tauri/src/pdf/engine.rs` for the fidelity strategy.
 */
export function saveDocument(args: {
  id: string;
  outputPath: string;
  edits: TextEdit[];
  annotations: Annotation[];
  stamps: ImageStamp[];
}): Promise<void> {
  return invoke<void>("save_document", args);
}
