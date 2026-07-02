/**
 * Open-document state: the loaded PDF, viewport (page/zoom/fit), per-page text
 * layers, and the async lifecycle around opening/closing.
 *
 * Rendered rasters are NOT held here — they're owned by the page components,
 * which create and revoke their object URLs on mount/unmount to keep memory
 * bounded for large documents. This store holds only lightweight metadata and
 * the cached text layers (which are small and reused for selection/search).
 */
import { create } from "zustand";
import type { DocumentMeta, PageTextLayer } from "@/types/pdf";
import { useAnnotationStore } from "@/stores/annotation-store";
import { toast } from "@/hooks/use-toast";
import {
  openPdf as openPdfCmd,
  openPdfBytes as openPdfBytesCmd,
  closePdf as closePdfCmd,
  getPageText,
  transformPages,
  type PageOp,
  type SearchHit,
} from "@/lib/tauri";

export type FitMode = "width" | "page" | "custom";

/** Min/max user zoom expressed as scale (cssPixels per PDF point). */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 6;

/**
 * Listeners run SYNCHRONOUSLY before a structural page operation is
 * dispatched to the engine, so stores holding index-based state (the form
 * store's widget indices) can invalidate BEFORE the indices shift. A plain
 * registry (rather than importing those stores here) keeps the dependency
 * direction acyclic: dependent stores import this module, never the reverse.
 */
const pageOpListeners = new Set<() => void>();
export function onBeforePageOp(listener: () => void): void {
  pageOpListeners.add(listener);
}

interface DocumentState {
  meta: DocumentMeta | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;

  /** 0-based index of the page currently centered in the viewport. */
  currentPage: number;
  scale: number;
  fitMode: FitMode;

  /**
   * Set when navigation (thumbnail / page input / keyboard) requests the
   * viewport scroll to a page. The viewer consumes and clears it. This keeps
   * scroll-driven `currentPage` updates decoupled from programmatic navigation,
   * avoiding feedback loops.
   */
  pendingScrollPage: number | null;

  /** Cached text layers by page index (lazily fetched). */
  textLayers: Record<number, PageTextLayer | undefined>;

  /**
   * Per-page repaint counters, bumped when the engine's in-memory document
   * bytes change WITHOUT the page structure changing (e.g. a form-field
   * fill). Page components include their own page's counter in their
   * raster-fetch dependencies, so only the affected pages repaint while text
   * layers and scroll state stay untouched.
   */
  pageRevisions: Record<number, number>;
  bumpPageRevisions: (pageIndexes: number[]) => void;

  /** Whether the one-time "recognized with OCR" notice was shown for this doc. */
  ocrNoticeShown: boolean;

  /** The search hit currently navigated to (highlighted on its page). */
  activeSearchHit: SearchHit | null;
  setActiveSearchHit: (hit: SearchHit | null) => void;

  openFromPath: (path: string) => Promise<void>;
  openFromBytes: (bytes: Uint8Array, name: string) => Promise<void>;
  close: () => Promise<void>;

  setCurrentPage: (pageIndex: number) => void;
  /** Request the viewport scroll to a page (and set it current). */
  requestScrollToPage: (pageIndex: number) => void;
  /** Called by the viewer once it has handled a scroll request. */
  clearPendingScroll: () => void;
  setScale: (scale: number, fitMode?: FitMode) => void;
  setFitMode: (mode: FitMode) => void;
  zoomIn: () => void;
  zoomOut: () => void;

  /** Fetch (and cache) the text layer for a page. */
  ensureTextLayer: (pageIndex: number) => Promise<PageTextLayer | null>;

  /**
   * Apply a structural page operation in the engine and refresh the metadata.
   * Cached text layers are invalidated (page indices/geometry changed); the
   * new `meta` identity makes pages and thumbnails re-render themselves.
   * Throws on failure so callers can surface the error.
   */
  applyPageOp: (op: PageOp) => Promise<void>;
}

export const useDocumentStore = create<DocumentState>((set, get) => ({
  meta: null,
  status: "idle",
  error: null,
  currentPage: 0,
  scale: 1,
  fitMode: "width",
  pendingScrollPage: null,
  textLayers: {},
  pageRevisions: {},
  bumpPageRevisions: (pageIndexes) =>
    set((s) => {
      const next = { ...s.pageRevisions };
      for (const i of pageIndexes) next[i] = (next[i] ?? 0) + 1;
      return { pageRevisions: next };
    }),
  ocrNoticeShown: false,
  activeSearchHit: null,
  setActiveSearchHit: (activeSearchHit) => set({ activeSearchHit }),

  openFromPath: async (path) => {
    await loadDocument(set, get, () => openPdfCmd(path));
  },

  openFromBytes: async (bytes, name) => {
    await loadDocument(set, get, () => openPdfBytesCmd(bytes, name));
  },

  close: async () => {
    const { meta } = get();
    if (meta) {
      try {
        await closePdfCmd(meta.id);
      } catch {
        // Closing is best-effort; the backend GCs on document replacement too.
      }
    }
    set({
      meta: null,
      status: "idle",
      error: null,
      currentPage: 0,
      pendingScrollPage: null,
      textLayers: {},
      pageRevisions: {},
      activeSearchHit: null,
    });
  },

  setCurrentPage: (pageIndex) => {
    const { meta } = get();
    if (!meta) return;
    const clamped = Math.min(Math.max(0, pageIndex), meta.pageCount - 1);
    set({ currentPage: clamped });
  },

  requestScrollToPage: (pageIndex) => {
    const { meta } = get();
    if (!meta) return;
    const clamped = Math.min(Math.max(0, pageIndex), meta.pageCount - 1);
    set({ currentPage: clamped, pendingScrollPage: clamped });
  },

  clearPendingScroll: () => set({ pendingScrollPage: null }),

  setScale: (scale, fitMode = "custom") => {
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    set({ scale: clamped, fitMode });
  },

  setFitMode: (fitMode) => set({ fitMode }),

  zoomIn: () => get().setScale(roundScale(get().scale * 1.2)),
  zoomOut: () => get().setScale(roundScale(get().scale / 1.2)),

  applyPageOp: async (op) => {
    const { meta, currentPage } = get();
    if (!meta) return;
    // Invalidate index-based state BEFORE the engine request is dispatched:
    // a form commit already queued behind this op must not pass its epoch
    // check and write to shifted widget indices.
    pageOpListeners.forEach((listener) => listener());
    const newMeta = await transformPages(meta.id, op);
    set({
      meta: newMeta,
      textLayers: {},
      activeSearchHit: null,
      currentPage: Math.min(currentPage, Math.max(0, newMeta.pageCount - 1)),
    });
    // Every op except extraction mutates the in-memory document, so there is
    // now unsaved state regardless of whether any markup remap follows.
    if (op.type !== "extractPage") {
      useAnnotationStore.getState().markDirty();
    }
  },

  ensureTextLayer: async (pageIndex) => {
    const { meta, textLayers } = get();
    if (!meta) return null;
    const cached = textLayers[pageIndex];
    if (cached) return cached;
    try {
      const layer = await getPageText(meta.id, pageIndex);
      set((s) => ({ textLayers: { ...s.textLayers, [pageIndex]: layer } }));
      // Tell the user once per document when text had to be recognized.
      if (layer.ocr && !get().ocrNoticeShown) {
        set({ ocrNoticeShown: true });
        toast.show(
          "Text recognized with OCR",
          "This page has no embedded text, so GoodBoyPdf recognized it from the image. You can select, search, and edit — edits are re-stamped in a matched font.",
        );
      }
      return layer;
    } catch {
      return null;
    }
  },
}));

/** Shared open/replace flow for both path- and byte-based loads. */
async function loadDocument(
  set: (partial: Partial<DocumentState>) => void,
  get: () => DocumentState,
  loader: () => Promise<DocumentMeta>,
): Promise<void> {
  // Release any previously open document first.
  const prev = get().meta;
  if (prev) {
    try {
      await closePdfCmd(prev.id);
    } catch {
      /* ignore */
    }
  }
  set({
    status: "loading",
    error: null,
    textLayers: {},
    pageRevisions: {},
    activeSearchHit: null,
    ocrNoticeShown: false,
  });
  try {
    const meta = await loader();
    set({ meta, status: "ready", currentPage: 0, error: null });
  } catch (err) {
    set({
      status: "error",
      error: err instanceof Error ? err.message : "Failed to open the document.",
      meta: null,
    });
  }
}

function roundScale(scale: number): number {
  return Math.round(scale * 100) / 100;
}
