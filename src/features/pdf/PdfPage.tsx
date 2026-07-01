/**
 * A single rendered page: the Pdfium raster, the selectable/editable text
 * overlay, and the annotation overlay — all sized from one source of truth
 * (page points × scale) so the layers stay pixel-aligned.
 *
 * Pages render lazily: the raster and text layer are only fetched when the page
 * approaches the viewport ({@link useInView}). Off-screen pages still reserve
 * their exact layout box so scrolling and the scrollbar remain accurate, and
 * the high-DPI raster keeps text crisp on any display.
 */
import { useEffect, useState } from "react";
import type { PageSize, Rect } from "@/types/pdf";
import { useDocumentStore } from "@/stores/document-store";
import { useAnnotationStore } from "@/stores/annotation-store";
import { useUiStore, type Tool } from "@/stores/ui-store";
import { renderPage } from "@/lib/tauri";
import { useInView } from "@/hooks/use-in-view";
import { TextLayer } from "./TextLayer";
import { AnnotationLayer } from "./AnnotationLayer";
import { cn, uid } from "@/lib/utils";

interface PdfPageProps {
  size: PageSize;
  scale: number;
}

const TEXT_MARKUP_TOOLS: Tool[] = ["highlight", "underline", "strikethrough"];

export function PdfPage({ size, scale }: PdfPageProps) {
  const [containerRef, inView] = useInView<HTMLDivElement>("1000px");
  const meta = useDocumentStore((s) => s.meta);
  const ensureTextLayer = useDocumentStore((s) => s.ensureTextLayer);
  const textLayer = useDocumentStore((s) => s.textLayers[size.pageIndex]);

  const activeTool = useUiStore((s) => s.activeTool);
  const markupColor = useUiStore((s) => s.markupColor);
  const addAnnotation = useAnnotationStore((s) => s.addAnnotation);

  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [errored, setErrored] = useState(false);

  const widthPx = Math.round(size.width * scale);
  const heightPx = Math.round(size.height * scale);

  // The raster is fetched at a DEBOUNCED scale: during continuous zoom
  // (Ctrl+wheel) the layout rescales instantly (the browser stretches the
  // current raster, momentarily soft) and the crisp re-render lands once the
  // zoom settles. This keeps zooming perfectly smooth on large documents.
  const [rasterScale, setRasterScale] = useState(scale);
  useEffect(() => {
    if (rasterScale === scale) return;
    const t = setTimeout(() => setRasterScale(scale), 160);
    return () => clearTimeout(t);
  }, [scale, rasterScale]);

  // Fetch the high-DPI raster when the page is near the viewport / the settled
  // zoom level changes.
  useEffect(() => {
    if (!meta || !inView) return;
    let cancelled = false;
    const dpr = window.devicePixelRatio || 1;
    const renderScale = rasterScale * dpr;

    setLoading(true);
    setErrored(false);
    renderPage(meta.id, size.pageIndex, renderScale)
      .then((url) => {
        if (cancelled) return;
        setImageUrl(url);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setErrored(true);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [meta, inView, rasterScale, size.pageIndex]);

  // Lazily load the text layer for selection / editing.
  useEffect(() => {
    if (inView && meta && !textLayer) {
      void ensureTextLayer(size.pageIndex);
    }
  }, [inView, meta, textLayer, ensureTextLayer, size.pageIndex]);

  /** Convert the current text selection into a markup annotation. */
  function handleMouseUp() {
    if (!TEXT_MARKUP_TOOLS.includes(activeTool)) return;
    const sel = window.getSelection();
    const node = containerRef.current;
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !node) return;

    const pageBox = node.getBoundingClientRect();
    const rects: Rect[] = [];
    for (const cr of Array.from(sel.getRangeAt(0).getClientRects())) {
      // Keep only rects that fall on this page.
      const cy = (cr.top + cr.bottom) / 2;
      if (cy < pageBox.top || cy > pageBox.bottom) continue;
      const x = (cr.left - pageBox.left) / scale;
      const y = (cr.top - pageBox.top) / scale;
      const w = cr.width / scale;
      const h = cr.height / scale;
      if (w < 1 || h < 1) continue;
      rects.push({ x, y, width: w, height: h });
    }
    if (rects.length === 0) return;

    addAnnotation({
      id: uid("anno"),
      type: activeTool as "highlight" | "underline" | "strikethrough",
      pageIndex: size.pageIndex,
      rects,
      color: markupColor,
      opacity: activeTool === "highlight" ? 0.4 : 1,
      createdAt: new Date().toISOString(),
    });
    sel.removeAllRanges();
  }

  return (
    <div
      ref={containerRef}
      data-page-index={size.pageIndex}
      onMouseUp={handleMouseUp}
      className="group relative shrink-0 overflow-hidden rounded-sm bg-white shadow-[0_2px_12px_rgba(0,0,0,0.18)] ring-1 ring-black/5"
      style={{ width: widthPx, height: heightPx }}
    >
      {/* Raster layer */}
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={`Page ${size.pageIndex + 1}`}
          draggable={false}
          className={cn(
            "absolute inset-0 h-full w-full select-none transition-opacity duration-200",
            loading ? "opacity-70" : "opacity-100",
          )}
          width={widthPx}
          height={heightPx}
        />
      ) : (
        <div className="absolute inset-0 overflow-hidden bg-white">
          <div className="h-full w-full animate-pulse bg-gradient-to-b from-slate-50 to-slate-100" />
        </div>
      )}

      {errored && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/90 text-sm text-destructive">
          Failed to render this page.
        </div>
      )}

      {/* Text + annotation overlays */}
      {textLayer && (
        <TextLayer
          pageIndex={size.pageIndex}
          spans={textLayer.spans}
          scale={scale}
          editable={activeTool === "edit"}
        />
      )}
      <AnnotationLayer
        pageIndex={size.pageIndex}
        scale={scale}
        widthPx={widthPx}
        heightPx={heightPx}
      />

      {/* Page number chip */}
      <div className="pointer-events-none absolute bottom-2 right-2 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100">
        {size.pageIndex + 1}
      </div>
    </div>
  );
}
