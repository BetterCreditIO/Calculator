/**
 * Renders markup annotations over a page and handles creation for the
 * pointer-driven tools (redaction drag, comment placement). Text-flow markup
 * (highlight / underline / strikethrough) is created from the text selection in
 * {@link PdfPage}, which is why those are not handled here.
 */
import { useState } from "react";
import { MessageSquare, Trash2 } from "lucide-react";
import type { Annotation, Rect } from "@/types/pdf";
import { useAnnotationStore } from "@/stores/annotation-store";
import { useUiStore } from "@/stores/ui-store";
import { uid } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverAnchor,
} from "@/components/ui/popover";

interface AnnotationLayerProps {
  pageIndex: number;
  scale: number;
  widthPx: number;
  heightPx: number;
}

export function AnnotationLayer({
  pageIndex,
  scale,
  widthPx,
  heightPx,
}: AnnotationLayerProps) {
  const annotations = useAnnotationStore((s) => s.annotations);
  const addAnnotation = useAnnotationStore((s) => s.addAnnotation);
  const activeTool = useUiStore((s) => s.activeTool);
  const markupColor = useUiStore((s) => s.markupColor);

  const [drag, setDrag] = useState<null | { x: number; y: number; w: number; h: number }>(
    null,
  );

  const pageAnnotations = annotations.filter((a) => a.pageIndex === pageIndex);
  const isRedacting = activeTool === "redaction";
  const isCommenting = activeTool === "comment";
  const interactive = isRedacting || isCommenting;

  function localPoint(e: React.PointerEvent): { x: number; y: number } {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!isRedacting) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = localPoint(e);
    setDrag({ x: p.x, y: p.y, w: 0, h: 0 });
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!drag || !isRedacting) return;
    const p = localPoint(e);
    setDrag({ x: drag.x, y: drag.y, w: p.x - drag.x, h: p.y - drag.y });
  }

  function onPointerUp() {
    if (!drag || !isRedacting) return;
    const norm = normalizeRect(drag);
    setDrag(null);
    if (norm.width < 6 || norm.height < 6) return; // ignore tiny drags
    addAnnotation({
      id: uid("anno"),
      type: "redaction",
      pageIndex,
      rects: [pxRectToPoint(norm, scale)],
      color: "#000000",
      opacity: 1,
      createdAt: new Date().toISOString(),
    });
  }

  function onClickPlaceComment(e: React.PointerEvent) {
    if (!isCommenting) return;
    const p = localPoint(e);
    addAnnotation({
      id: uid("anno"),
      type: "comment",
      pageIndex,
      rects: [pxRectToPoint({ x: p.x, y: p.y, width: 22, height: 22 }, scale)],
      color: markupColor,
      opacity: 1,
      note: "",
      createdAt: new Date().toISOString(),
    });
  }

  return (
    <div
      className="absolute inset-0"
      style={{
        width: widthPx,
        height: heightPx,
        pointerEvents: interactive ? "auto" : "none",
        cursor: isRedacting ? "crosshair" : isCommenting ? "copy" : "default",
      }}
      onPointerDown={(e) => {
        onPointerDown(e);
        if (isCommenting) onClickPlaceComment(e);
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {pageAnnotations.map((a) => (
        <AnnotationView key={a.id} annotation={a} scale={scale} />
      ))}

      {drag && (
        <div
          className="absolute border-2 border-dashed border-foreground/70 bg-foreground/20"
          style={normalizeRect(drag)}
        />
      )}
    </div>
  );
}

function AnnotationView({
  annotation,
  scale,
}: {
  annotation: Annotation;
  scale: number;
}) {
  const removeAnnotation = useAnnotationStore((s) => s.removeAnnotation);
  const updateAnnotation = useAnnotationStore((s) => s.updateAnnotation);
  const [open, setOpen] = useState(false);

  if (annotation.type === "comment") {
    const r = annotation.rects[0];
    if (!r) return null;
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <button
            className="group absolute flex h-6 w-6 items-center justify-center rounded-full bg-amber-400 text-amber-950 shadow-md ring-2 ring-white/70 transition-smooth hover:scale-110"
            style={{
              left: r.x * scale,
              top: r.y * scale,
              pointerEvents: "auto",
            }}
            onClick={() => setOpen(true)}
            title="Comment"
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </button>
        </PopoverAnchor>
        <PopoverContent>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground">Comment</p>
            <textarea
              autoFocus
              value={annotation.note ?? ""}
              onChange={(e) =>
                updateAnnotation(annotation.id, { note: e.target.value })
              }
              placeholder="Type a note…"
              className="h-24 w-full resize-none rounded-md border border-input bg-background p-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex justify-end">
              <button
                onClick={() => {
                  removeAnnotation(annotation.id);
                  setOpen(false);
                }}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-destructive transition-smooth hover:bg-destructive/10"
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    );
  }

  // Rectangular markups (highlight / underline / strikethrough / redaction).
  return (
    <>
      {annotation.rects.map((r, i) => (
        <div
          key={i}
          className="group absolute"
          style={{
            left: r.x * scale,
            top: r.y * scale,
            width: r.width * scale,
            height: r.height * scale,
            pointerEvents: "auto",
          }}
        >
          <div
            className="absolute inset-0"
            style={markupStyle(annotation)}
          />
          {i === 0 && (
            <button
              onClick={() => removeAnnotation(annotation.id)}
              className="absolute -right-2 -top-2 hidden h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow group-hover:flex"
              title="Remove"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
      ))}
    </>
  );
}

function markupStyle(a: Annotation): React.CSSProperties {
  switch (a.type) {
    case "highlight":
      return { backgroundColor: a.color, opacity: a.opacity, mixBlendMode: "multiply" };
    case "underline":
      return {
        borderBottom: `2px solid ${a.color}`,
        opacity: a.opacity,
      };
    case "strikethrough":
      return {
        boxShadow: `inset 0 0 0 0 transparent`,
        backgroundImage: `linear-gradient(${a.color}, ${a.color})`,
        backgroundSize: "100% 2px",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
        opacity: a.opacity,
      };
    case "redaction":
      return { backgroundColor: "#000", opacity: 1 };
    default:
      return {};
  }
}

function normalizeRect(d: { x: number; y: number; w: number; h: number }) {
  return {
    left: Math.min(d.x, d.x + d.w),
    top: Math.min(d.y, d.y + d.h),
    width: Math.abs(d.w),
    height: Math.abs(d.h),
  };
}

function pxRectToPoint(
  r: { x?: number; y?: number; left?: number; top?: number; width: number; height: number },
  scale: number,
): Rect {
  const x = r.x ?? r.left ?? 0;
  const y = r.y ?? r.top ?? 0;
  return {
    x: x / scale,
    y: y / scale,
    width: r.width / scale,
    height: r.height / scale,
  };
}
