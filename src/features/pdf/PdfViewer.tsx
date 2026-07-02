/**
 * The scrolling page container.
 *
 * Responsibilities:
 *   • compute the effective render scale for fit-to-width / fit-to-page modes,
 *     recomputing on container resize;
 *   • lay out every page in a vertical column (lazy-rendered by {@link PdfPage});
 *   • a scroll-spy that reports the centered page as `currentPage`; and
 *   • consume programmatic scroll requests (thumbnail / page input / keyboard).
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import type { PageSize } from "@/types/pdf";
import { useDocumentStore, MIN_SCALE, MAX_SCALE } from "@/stores/document-store";
import { useFormStore } from "@/stores/form-store";
import { PdfPage } from "./PdfPage";

const PAGE_GAP = 24; // px between pages
const VIEWPORT_PADDING = 32; // px around the page column

export function PdfViewer() {
  const meta = useDocumentStore((s) => s.meta);
  const scale = useDocumentStore((s) => s.scale);
  const fitMode = useDocumentStore((s) => s.fitMode);
  const setScale = useDocumentStore((s) => s.setScale);
  const setCurrentPage = useDocumentStore((s) => s.setCurrentPage);
  const pendingScrollPage = useDocumentStore((s) => s.pendingScrollPage);
  const clearPendingScroll = useDocumentStore((s) => s.clearPendingScroll);

  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  /**
   * Pending zoom anchor: keeps the point under the cursor fixed on zoom.
   * Offsets are pre-split into a FIXED part (padding + inter-page gaps, which
   * do not scale with zoom) and a SCALABLE part (page pixels); only the
   * scalable part is multiplied by the zoom ratio, so the anchor stays exact
   * even deep into a long document.
   */
  const anchorRef = useRef<null | {
    cursorX: number;
    cursorY: number;
    fixedY: number;
    scalableY: number;
    contentX: number;
    ratio: number;
  }>(null);

  const maxPageWidth = meta
    ? Math.max(...meta.pages.map((p) => p.width), 1)
    : 1;
  const maxPageHeight = meta
    ? Math.max(...meta.pages.map((p) => p.height), 1)
    : 1;

  // Recompute fit scale on mount, document change, fit-mode change, and resize.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !meta || fitMode === "custom") return;

    function computeFit() {
      const node = scrollRef.current;
      if (!node) return;
      const availW = node.clientWidth - VIEWPORT_PADDING * 2;
      const availH = node.clientHeight - VIEWPORT_PADDING * 2;
      let next = 1;
      if (fitMode === "width") {
        next = availW / maxPageWidth;
      } else if (fitMode === "page") {
        next = Math.min(availW / maxPageWidth, availH / maxPageHeight);
      }
      // Preserve the fit mode while updating the numeric scale.
      setScale(next, fitMode);
    }

    computeFit();
    const observer = new ResizeObserver(computeFit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [meta, fitMode, maxPageWidth, maxPageHeight, setScale]);

  // Enumerate form fields whenever the document or its page structure
  // changes. Keyed on the meta OBJECT (not just the id): page operations
  // return a fresh meta for the same id, and widget indices shift with them.
  useEffect(() => {
    const formStore = useFormStore.getState();
    if (meta) {
      void formStore.load(meta.id);
    } else {
      formStore.reset();
    }
  }, [meta]);

  // Scroll-spy: report the most-centered page as current.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !meta) return;

    function onScroll() {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const node = scrollRef.current;
        if (!node) return;
        const center = node.scrollTop + node.clientHeight / 2;
        const children = node.querySelectorAll<HTMLElement>("[data-page-wrap]");
        let best = 0;
        let bestDist = Infinity;
        children.forEach((child) => {
          const top = child.offsetTop;
          const mid = top + child.offsetHeight / 2;
          const dist = Math.abs(mid - center);
          if (dist < bestDist) {
            bestDist = dist;
            best = Number(child.dataset.pageWrap);
          }
        });
        setCurrentPage(best);
      });
    }

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [meta, setCurrentPage]);

  // Ctrl+wheel zoom, anchored to the cursor (the standard reader interaction).
  // Attached natively with passive:false so preventDefault stops page scroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !meta) return;

    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const node = scrollRef.current;
      if (!node) return;

      const state = useDocumentStore.getState();
      // Exponential factor gives smooth, device-independent zoom steps.
      const factor = Math.exp(-e.deltaY * 0.0015);
      const next = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, state.scale * factor),
      );
      if (next === state.scale) return;

      const rect = node.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;
      const contentY = node.scrollTop + cursorY;
      const pages = state.meta?.pages ?? [];
      const { fixed, scalable } = splitFixedY(contentY, pages, state.scale);
      anchorRef.current = {
        cursorX,
        cursorY,
        fixedY: fixed,
        scalableY: scalable,
        contentX: node.scrollLeft + cursorX,
        ratio: next / state.scale,
      };
      state.setScale(next);
    }

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [meta]);

  // Apply the zoom anchor after the layout has re-scaled.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    anchorRef.current = null;
    const node = scrollRef.current;
    if (!node) return;
    // Horizontal: only the page pixels beyond the padding scale.
    const scalableX = Math.max(0, anchor.contentX - VIEWPORT_PADDING);
    const fixedX = anchor.contentX - scalableX;
    node.scrollLeft = fixedX + scalableX * anchor.ratio - anchor.cursorX;
    node.scrollTop =
      anchor.fixedY + anchor.scalableY * anchor.ratio - anchor.cursorY;
  }, [scale]);

  // Consume programmatic scroll requests.
  useEffect(() => {
    if (pendingScrollPage == null) return;
    const node = scrollRef.current;
    if (!node) return;
    const target = node.querySelector<HTMLElement>(
      `[data-page-wrap="${pendingScrollPage}"]`,
    );
    if (target) {
      node.scrollTo({ top: target.offsetTop - VIEWPORT_PADDING, behavior: "smooth" });
    }
    clearPendingScroll();
  }, [pendingScrollPage, clearPendingScroll]);

  if (!meta) return null;

  return (
    <div
      ref={scrollRef}
      className="page-canvas-bg scroll-thin h-full w-full overflow-auto"
    >
      <div
        className="mx-auto flex w-fit flex-col items-center"
        style={{ padding: VIEWPORT_PADDING, gap: PAGE_GAP }}
      >
        {meta.pages.map((page) => (
          <div key={page.pageIndex} data-page-wrap={page.pageIndex}>
            <PdfPage size={page} scale={scale} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Split a vertical scroll offset into its FIXED component (top padding and the
 * constant inter-page gaps) and its SCALABLE component (page pixels, which
 * multiply with zoom). Walking the page list at the CURRENT scale exactly
 * mirrors the flex column layout above.
 */
function splitFixedY(
  contentY: number,
  pages: PageSize[],
  scale: number,
): { fixed: number; scalable: number } {
  let fixed = Math.min(contentY, VIEWPORT_PADDING);
  let scalable = 0;
  let cursor = VIEWPORT_PADDING;

  for (let i = 0; i < pages.length; i++) {
    if (contentY <= cursor) break;
    const pageHeight = (pages[i]?.height ?? 0) * scale;

    // Portion of this page above the anchor point.
    const withinPage = Math.min(Math.max(contentY - cursor, 0), pageHeight);
    scalable += withinPage;
    cursor += pageHeight;
    if (contentY <= cursor) return { fixed, scalable };

    // Portion of the gap after this page above the anchor point.
    const withinGap = Math.min(Math.max(contentY - cursor, 0), PAGE_GAP);
    fixed += withinGap;
    cursor += PAGE_GAP;
  }

  // Below the last page (bottom padding region): remaining offset is fixed.
  if (contentY > cursor) fixed += contentY - cursor;
  return { fixed, scalable };
}
