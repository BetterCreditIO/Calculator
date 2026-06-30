/**
 * The editor toolbar: tool selection, markup color, zoom, page navigation,
 * undo/redo, and save. Grouped into logical sections with tooltips and
 * keyboard-shortcut hints for a professional, discoverable feel.
 */
import {
  MousePointer2,
  Pencil,
  Highlighter,
  Underline,
  Strikethrough,
  MessageSquarePlus,
  EyeOff,
  ZoomIn,
  ZoomOut,
  ChevronUp,
  ChevronDown,
  Undo2,
  Redo2,
  Save,
  PanelLeft,
  MoveHorizontal,
  Maximize2,
} from "lucide-react";
import { useUiStore, type Tool } from "@/stores/ui-store";
import { useDocumentStore, MIN_SCALE, MAX_SCALE } from "@/stores/document-store";
import { useAnnotationStore } from "@/stores/annotation-store";
import { useSaveDocument } from "./use-pdf-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const TOOLS: { tool: Tool; icon: typeof MousePointer2; label: string; hint?: string }[] =
  [
    { tool: "select", icon: MousePointer2, label: "Select", hint: "V" },
    { tool: "edit", icon: Pencil, label: "Edit text", hint: "E" },
    { tool: "highlight", icon: Highlighter, label: "Highlight", hint: "H" },
    { tool: "underline", icon: Underline, label: "Underline", hint: "U" },
    { tool: "strikethrough", icon: Strikethrough, label: "Strikethrough" },
    { tool: "comment", icon: MessageSquarePlus, label: "Comment", hint: "C" },
    { tool: "redaction", icon: EyeOff, label: "Redact", hint: "R" },
  ];

const SWATCHES = [
  "#fde047", // yellow
  "#86efac", // green
  "#7dd3fc", // blue
  "#fca5a5", // red
  "#f0abfc", // pink
  "#fdba74", // orange
];

export function PdfToolbar() {
  const activeTool = useUiStore((s) => s.activeTool);
  const setActiveTool = useUiStore((s) => s.setActiveTool);
  const markupColor = useUiStore((s) => s.markupColor);
  const setMarkupColor = useUiStore((s) => s.setMarkupColor);
  const toggleThumbnails = useUiStore((s) => s.toggleThumbnails);

  const meta = useDocumentStore((s) => s.meta);
  const currentPage = useDocumentStore((s) => s.currentPage);
  const scale = useDocumentStore((s) => s.scale);
  const fitMode = useDocumentStore((s) => s.fitMode);
  const zoomIn = useDocumentStore((s) => s.zoomIn);
  const zoomOut = useDocumentStore((s) => s.zoomOut);
  const setFitMode = useDocumentStore((s) => s.setFitMode);
  const requestScrollToPage = useDocumentStore((s) => s.requestScrollToPage);

  const undo = useAnnotationStore((s) => s.undo);
  const redo = useAnnotationStore((s) => s.redo);
  const canUndo = useAnnotationStore((s) => s.past.length > 0);
  const canRedo = useAnnotationStore((s) => s.future.length > 0);
  const dirty = useAnnotationStore((s) => s.dirty);

  const save = useSaveDocument();

  if (!meta) return null;

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-12 items-center gap-1 border-b bg-card px-2">
        <IconButton label="Toggle thumbnails" onClick={toggleThumbnails}>
          <PanelLeft className="h-4 w-4" />
        </IconButton>

        <Separator orientation="vertical" className="mx-1 h-6" />

        {/* Tools */}
        <div className="flex items-center gap-0.5">
          {TOOLS.map(({ tool, icon: Icon, label, hint }) => (
            <Tooltip key={tool}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setActiveTool(tool)}
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-md transition-smooth",
                    activeTool === tool
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                  aria-pressed={activeTool === tool}
                >
                  <Icon className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {label}
                {hint && <span className="ml-1.5 opacity-60">{hint}</span>}
              </TooltipContent>
            </Tooltip>
          ))}

          {/* Markup color */}
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <button
                    className="ml-0.5 flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent"
                    aria-label="Markup color"
                  >
                    <span
                      className="h-4 w-4 rounded-full ring-1 ring-black/15"
                      style={{ backgroundColor: markupColor }}
                    />
                  </button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>Markup color</TooltipContent>
            </Tooltip>
            <PopoverContent className="w-auto p-2">
              <div className="flex gap-1.5">
                {SWATCHES.map((c) => (
                  <button
                    key={c}
                    onClick={() => setMarkupColor(c)}
                    className={cn(
                      "h-6 w-6 rounded-full ring-1 ring-black/15 transition-transform hover:scale-110",
                      markupColor === c && "ring-2 ring-primary ring-offset-1",
                    )}
                    style={{ backgroundColor: c }}
                    aria-label={`Color ${c}`}
                  />
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>

        <Separator orientation="vertical" className="mx-1 h-6" />

        {/* Undo / redo */}
        <IconButton label="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo}>
          <Undo2 className="h-4 w-4" />
        </IconButton>
        <IconButton label="Redo (Ctrl+Y)" onClick={redo} disabled={!canRedo}>
          <Redo2 className="h-4 w-4" />
        </IconButton>

        <div className="flex-1" />

        {/* Page navigation */}
        <div className="flex items-center gap-0.5">
          <IconButton
            label="Previous page"
            onClick={() => requestScrollToPage(currentPage - 1)}
            disabled={currentPage <= 0}
          >
            <ChevronUp className="h-4 w-4" />
          </IconButton>
          <div className="flex items-center gap-1 text-sm text-muted-foreground">
            <Input
              className="h-7 w-12 text-center tabular-nums"
              value={currentPage + 1}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (!Number.isNaN(n)) requestScrollToPage(n - 1);
              }}
              aria-label="Current page"
            />
            <span className="tabular-nums">/ {meta.pageCount}</span>
          </div>
          <IconButton
            label="Next page"
            onClick={() => requestScrollToPage(currentPage + 1)}
            disabled={currentPage >= meta.pageCount - 1}
          >
            <ChevronDown className="h-4 w-4" />
          </IconButton>
        </div>

        <Separator orientation="vertical" className="mx-1 h-6" />

        {/* Zoom */}
        <div className="flex items-center gap-0.5">
          <IconButton
            label="Zoom out"
            onClick={zoomOut}
            disabled={scale <= MIN_SCALE}
          >
            <ZoomOut className="h-4 w-4" />
          </IconButton>
          <span className="w-12 text-center text-xs tabular-nums text-muted-foreground">
            {Math.round(scale * 100)}%
          </span>
          <IconButton
            label="Zoom in"
            onClick={zoomIn}
            disabled={scale >= MAX_SCALE}
          >
            <ZoomIn className="h-4 w-4" />
          </IconButton>
          <IconButton
            label="Fit width"
            onClick={() => setFitMode("width")}
            active={fitMode === "width"}
          >
            <MoveHorizontal className="h-4 w-4" />
          </IconButton>
          <IconButton
            label="Fit page"
            onClick={() => setFitMode("page")}
            active={fitMode === "page"}
          >
            <Maximize2 className="h-4 w-4" />
          </IconButton>
        </div>

        <Separator orientation="vertical" className="mx-1 h-6" />

        <Button size="sm" onClick={() => void save()} className="gap-1.5">
          <Save className="h-4 w-4" />
          Save
          {dirty && (
            <span className="ml-0.5 h-1.5 w-1.5 rounded-full bg-primary-foreground/80" />
          )}
        </Button>
      </div>
    </TooltipProvider>
  );
}

function IconButton({
  label,
  children,
  onClick,
  disabled,
  active,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          disabled={disabled}
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-md transition-smooth disabled:pointer-events-none disabled:opacity-40",
            active
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
