/**
 * Page-thumbnail sidebar. Each thumbnail lazily renders a small raster via the
 * same backend path as the main viewer (only when scrolled into view) and
 * highlights the current page. Clicking navigates the main viewport.
 */
import { useEffect, useState } from "react";
import type { PageSize } from "@/types/pdf";
import { useDocumentStore } from "@/stores/document-store";
import { renderPage } from "@/lib/tauri";
import { useInView } from "@/hooks/use-in-view";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

const THUMB_WIDTH = 132; // px

export function Thumbnails() {
  const meta = useDocumentStore((s) => s.meta);
  const currentPage = useDocumentStore((s) => s.currentPage);
  const requestScrollToPage = useDocumentStore((s) => s.requestScrollToPage);

  if (!meta) return null;

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col items-center gap-3 p-3">
        {meta.pages.map((page) => (
          <Thumbnail
            key={page.pageIndex}
            size={page}
            active={page.pageIndex === currentPage}
            onClick={() => requestScrollToPage(page.pageIndex)}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

function Thumbnail({
  size,
  active,
  onClick,
}: {
  size: PageSize;
  active: boolean;
  onClick: () => void;
}) {
  const meta = useDocumentStore((s) => s.meta);
  const [ref, inView] = useInView<HTMLButtonElement>("400px");
  const [url, setUrl] = useState<string | null>(null);

  const aspect = size.height / size.width;
  const thumbHeight = Math.round(THUMB_WIDTH * aspect);
  const thumbScale = THUMB_WIDTH / size.width;

  // Reset the cached raster when the document changes, so a thumbnail reused
  // (by page index) across a document switch doesn't show the previous PDF.
  useEffect(() => {
    setUrl(null);
  }, [meta?.id]);

  useEffect(() => {
    if (!meta || !inView) return;
    let cancelled = false;
    renderPage(meta.id, size.pageIndex, thumbScale)
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [meta, inView, size.pageIndex, thumbScale]);

  return (
    <button
      ref={ref}
      onClick={onClick}
      className="group flex flex-col items-center gap-1.5 focus:outline-none"
      aria-label={`Go to page ${size.pageIndex + 1}`}
      aria-current={active}
    >
      <div
        className={cn(
          "overflow-hidden rounded-md bg-white shadow-sm ring-1 transition-smooth",
          active
            ? "ring-2 ring-primary"
            : "ring-black/10 group-hover:ring-primary/50",
        )}
        style={{ width: THUMB_WIDTH, height: thumbHeight }}
      >
        {url ? (
          <img
            src={url}
            alt=""
            className="h-full w-full"
            width={THUMB_WIDTH}
            height={thumbHeight}
          />
        ) : (
          <div className="h-full w-full animate-pulse bg-slate-100" />
        )}
      </div>
      <span
        className={cn(
          "text-xs tabular-nums",
          active ? "font-semibold text-primary" : "text-muted-foreground",
        )}
      >
        {size.pageIndex + 1}
      </span>
    </button>
  );
}
