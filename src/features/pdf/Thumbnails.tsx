/**
 * Page-thumbnail sidebar + page organizer.
 *
 * Each tile lazily renders a HiDPI raster and highlights the current page;
 * clicking navigates. A hover (or right-click) menu exposes the structural
 * page operations — rotate, move, insert blank, extract, delete — and the
 * footer offers "Append PDF". Ops run in the engine (in-memory until Save);
 * annotations and pending edits are remapped to follow their pages.
 */
import { useEffect, useState } from "react";
import {
  MoreHorizontal,
  RotateCw,
  RotateCcw,
  ArrowUp,
  ArrowDown,
  FilePlus2,
  FileOutput,
  Trash2,
  FileStack,
} from "lucide-react";
import { ask, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { PageSize } from "@/types/pdf";
import { useDocumentStore } from "@/stores/document-store";
import { useAnnotationStore } from "@/stores/annotation-store";
import { renderPage, type PageOp } from "@/lib/tauri";
import type { PageRemap } from "./lib/page-remap";
import { useInView } from "@/hooks/use-in-view";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const THUMB_WIDTH = 132; // px

export function Thumbnails() {
  const meta = useDocumentStore((s) => s.meta);
  const currentPage = useDocumentStore((s) => s.currentPage);
  const requestScrollToPage = useDocumentStore((s) => s.requestScrollToPage);

  if (!meta) return null;

  return (
    <div className="flex h-full flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col items-center gap-3 p-3">
          {meta.pages.map((page) => (
            <Thumbnail
              key={page.pageIndex}
              size={page}
              pageCount={meta.pageCount}
              active={page.pageIndex === currentPage}
              onClick={() => requestScrollToPage(page.pageIndex)}
            />
          ))}
        </div>
      </ScrollArea>
      <AppendPdfButton />
    </div>
  );
}

/**
 * Serialize page operations: op parameters and remap descriptors are captured
 * from the CLICK-time document state, so a second op must not start until the
 * first completes (indices/dimensions would describe the wrong structure).
 */
let pageOpInFlight = false;

/** Run a page op, follow with the store remap, and surface errors. */
async function runPageOp(
  op: PageOp,
  remap: PageRemap | null,
  successMessage?: string,
): Promise<void> {
  if (pageOpInFlight) {
    toast.show("One moment", "Another page operation is still running.");
    return;
  }
  pageOpInFlight = true;
  try {
    await useDocumentStore.getState().applyPageOp(op);
    if (remap) useAnnotationStore.getState().applyPageRemap(remap);
    if (successMessage) toast.success(successMessage);
  } catch (err) {
    toast.error(
      "Page operation failed",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    pageOpInFlight = false;
  }
}

function Thumbnail({
  size,
  pageCount,
  active,
  onClick,
}: {
  size: PageSize;
  pageCount: number;
  active: boolean;
  onClick: () => void;
}) {
  const meta = useDocumentStore((s) => s.meta);
  const revision = useDocumentStore((s) => s.pageRevisions[size.pageIndex] ?? 0);
  const [ref, inView] = useInView<HTMLButtonElement>("400px");
  const [url, setUrl] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const aspect = size.height / size.width;
  const thumbHeight = Math.round(THUMB_WIDTH * aspect);
  const thumbScale = THUMB_WIDTH / size.width;

  // Reset the cached raster when the document changes or this page's geometry
  // does (rotation swaps dimensions), so the tile refetches.
  useEffect(() => {
    setUrl(null);
  }, [meta, size.width, size.height]);

  useEffect(() => {
    if (!meta || !inView) return;
    let cancelled = false;
    // Render at device-pixel density so thumbnails stay crisp on HiDPI.
    const dpr = window.devicePixelRatio || 1;
    renderPage(meta.id, size.pageIndex, thumbScale * dpr)
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // `revision` bumps when the in-memory document changes without a page
    // restructure (form fills), so tiles repaint with the new content.
  }, [meta, inView, size.pageIndex, thumbScale, revision]);

  return (
    <div
      className="group relative flex flex-col items-center gap-1.5"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
    >
      <button
        ref={ref}
        onClick={onClick}
        className="flex flex-col items-center focus:outline-none"
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
      </button>

      <span
        className={cn(
          "text-xs tabular-nums",
          active ? "font-semibold text-primary" : "text-muted-foreground",
        )}
      >
        {size.pageIndex + 1}
      </span>

      <PageMenu
        size={size}
        pageCount={pageCount}
        open={menuOpen}
        onOpenChange={setMenuOpen}
      />
    </div>
  );
}

function PageMenu({
  size,
  pageCount,
  open,
  onOpenChange,
}: {
  size: PageSize;
  pageCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const pageIndex = size.pageIndex;
  const edits = useAnnotationStore((s) => s.edits);
  const pageHasEdits = edits.some((e) => e.pageIndex === pageIndex);

  function rotate(clockwise: boolean) {
    if (pageHasEdits) {
      toast.error(
        "Save edits before rotating",
        "This page has pending text edits; save or undo them first.",
      );
      return;
    }
    void runPageOp(
      { type: "rotate", pageIndex, clockwise },
      {
        kind: "rotate",
        pageIndex,
        clockwise,
        displayWidth: size.width,
        displayHeight: size.height,
      },
    );
  }

  function move(delta: -1 | 1) {
    const to = pageIndex + delta;
    if (to < 0 || to >= pageCount) return;
    void runPageOp(
      { type: "move", from: pageIndex, to },
      { kind: "move", from: pageIndex, to },
    );
  }

  async function extractPage() {
    const outputPath = await saveDialog({
      defaultPath: `page-${pageIndex + 1}.pdf`,
      filters: [{ name: "PDF Document", extensions: ["pdf"] }],
      title: "Extract Page As",
    });
    if (!outputPath) return;
    await runPageOp(
      { type: "extractPage", pageIndex, outputPath },
      null,
      `Extracted page ${pageIndex + 1}.`,
    );
  }

  async function deletePage() {
    if (pageCount <= 1) {
      toast.error("Can't delete", "A document must keep at least one page.");
      return;
    }
    const confirmed = await ask(
      `Delete page ${pageIndex + 1}? Markup on this page is removed too. This can't be undone.`,
      { title: "Delete page", kind: "warning" },
    );
    if (!confirmed) return;
    await runPageOp(
      { type: "delete", pageIndex },
      { kind: "delete", pageIndex },
      `Deleted page ${pageIndex + 1}.`,
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            "absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-md bg-background/90 text-muted-foreground shadow-sm ring-1 ring-border transition-smooth hover:text-foreground",
            open ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
          aria-label={`Page ${pageIndex + 1} actions`}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right">
        <DropdownMenuItem onClick={() => rotate(true)}>
          <RotateCw className="h-4 w-4" /> Rotate right
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => rotate(false)}>
          <RotateCcw className="h-4 w-4" /> Rotate left
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={pageIndex === 0} onClick={() => move(-1)}>
          <ArrowUp className="h-4 w-4" /> Move up
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={pageIndex >= pageCount - 1}
          onClick={() => move(1)}
        >
          <ArrowDown className="h-4 w-4" /> Move down
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() =>
            void runPageOp(
              { type: "insertBlank", afterIndex: pageIndex },
              { kind: "insert", afterIndex: pageIndex },
            )
          }
        >
          <FilePlus2 className="h-4 w-4" /> Insert blank page below
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void extractPage()}>
          <FileOutput className="h-4 w-4" /> Extract page…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onClick={() => void deletePage()}
        >
          <Trash2 className="h-4 w-4" /> Delete page
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Footer action: append every page of another PDF to this document. */
function AppendPdfButton() {
  async function appendPdf() {
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "PDF Document", extensions: ["pdf"] }],
      title: "Append PDF",
    });
    if (typeof selected !== "string") return;
    await runPageOp(
      { type: "appendPdf", path: selected },
      null, // existing page indices are unchanged by an append
      "Pages appended.",
    );
  }

  return (
    <div className="border-t p-2">
      <button
        onClick={() => void appendPdf()}
        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed py-2 text-xs text-muted-foreground transition-smooth hover:border-primary/50 hover:text-foreground"
      >
        <FileStack className="h-3.5 w-3.5" />
        Append PDF…
      </button>
    </div>
  );
}
