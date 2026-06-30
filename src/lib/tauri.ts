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
 * Render a page to a PNG at the given scale (cssPixels per PDF point) and
 * return an object URL for the decoded image. The backend streams raw PNG
 * bytes over IPC as an ArrayBuffer (no base64 bloat); we wrap them in a Blob.
 *
 * The caller owns the returned URL and MUST `URL.revokeObjectURL` it when the
 * page is unmounted or re-rendered to avoid leaking blobs.
 */
export async function renderPage(
  id: string,
  pageIndex: number,
  scale: number,
): Promise<string> {
  const bytes = await invoke<ArrayBuffer>("render_page", {
    id,
    pageIndex,
    scale,
  });
  const blob = new Blob([bytes], { type: "image/png" });
  return URL.createObjectURL(blob);
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

/** Write a UTF-8 text file to a user-chosen path (mortgage-estimate export). */
export function writeTextFile(path: string, contents: string): Promise<void> {
  return invoke<void>("write_text_file", { path, contents });
}

/**
 * Persist all pending edits and annotations to a new PDF at `outputPath`.
 *
 * The backend applies text edits by redacting the original glyph region and
 * re-stamping replacement text at the recorded geometry/size, then bakes in
 * the markup annotations. See `src-tauri/src/pdf/engine.rs` for the fidelity
 * strategy.
 */
export function saveDocument(args: {
  id: string;
  outputPath: string;
  edits: TextEdit[];
  annotations: Annotation[];
}): Promise<void> {
  return invoke<void>("save_document", args);
}
