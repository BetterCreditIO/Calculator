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
import {
  openPdf as openPdfCmd,
  openPdfBytes as openPdfBytesCmd,
  closePdf as closePdfCmd,
  getPageText,
} from "@/lib/tauri";

export type FitMode = "width" | "page" | "custom";

/** Min/max user zoom expressed as scale (cssPixels per PDF point). */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 6;

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

  ensureTextLayer: async (pageIndex) => {
    const { meta, textLayers } = get();
    if (!meta) return null;
    const cached = textLayers[pageIndex];
    if (cached) return cached;
    try {
      const layer = await getPageText(meta.id, pageIndex);
      set((s) => ({ textLayers: { ...s.textLayers, [pageIndex]: layer } }));
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
  set({ status: "loading", error: null, textLayers: {} });
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
