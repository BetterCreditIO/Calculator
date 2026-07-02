/**
 * Placed-signature overlay: shows each stamp as a positioned <img> (the exact
 * pixels the backend embeds on save) and, with the Select tool, lets the user
 * drag to move, drag the corner handle to resize (aspect locked), and delete.
 *
 * Drags mutate LOCAL state per frame for smoothness and commit one store
 * update (one undo step) on release. Geometry is stored in display point
 * space; pointer deltas divide by `scale` to convert from CSS pixels.
 */
import { useState } from "react";
import { X } from "lucide-react";
import type { ImageStamp, PageSize, Rect } from "@/types/pdf";
import { useAnnotationStore } from "@/stores/annotation-store";
import { useUiStore } from "@/stores/ui-store";
import { cn } from "@/lib/utils";

const MIN_WIDTH_PTS = 24;

interface SignatureLayerProps {
  size: PageSize;
  scale: number;
}

export function SignatureLayer({ size, scale }: SignatureLayerProps) {
  const stamps = useAnnotationStore((s) => s.stamps);
  const activeTool = useUiStore((s) => s.activeTool);
  const pageStamps = stamps.filter((s) => s.pageIndex === size.pageIndex);
  if (pageStamps.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0">
      {pageStamps.map((stamp) => (
        <StampView
          key={stamp.id}
          stamp={stamp}
          size={size}
          scale={scale}
          interactive={activeTool === "select"}
        />
      ))}
    </div>
  );
}

type DragState =
  | { mode: "move"; startX: number; startY: number; origin: Rect }
  | { mode: "resize"; startX: number; startY: number; origin: Rect };

function StampView({
  stamp,
  size,
  scale,
  interactive,
}: {
  stamp: ImageStamp;
  size: PageSize;
  scale: number;
  interactive: boolean;
}) {
  const updateStamp = useAnnotationStore((s) => s.updateStamp);
  const removeStamp = useAnnotationStore((s) => s.removeStamp);
  const [drag, setDrag] = useState<DragState | null>(null);
  // Live rect during a drag; falls back to the committed rect.
  const [liveRect, setLiveRect] = useState<Rect | null>(null);
  const rect = liveRect ?? stamp.rect;

  function clampRect(r: Rect): Rect {
    const x = Math.min(Math.max(0, r.x), Math.max(0, size.width - r.width));
    const y = Math.min(Math.max(0, r.y), Math.max(0, size.height - r.height));
    return { ...r, x, y };
  }

  function beginDrag(
    e: React.PointerEvent<HTMLElement>,
    mode: DragState["mode"],
  ) {
    if (!interactive) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ mode, startX: e.clientX, startY: e.clientY, origin: stamp.rect });
    setLiveRect(stamp.rect);
  }

  function onPointerMove(e: React.PointerEvent<HTMLElement>) {
    if (!drag) return;
    const dx = (e.clientX - drag.startX) / scale;
    const dy = (e.clientY - drag.startY) / scale;
    if (drag.mode === "move") {
      setLiveRect(
        clampRect({ ...drag.origin, x: drag.origin.x + dx, y: drag.origin.y + dy }),
      );
    } else {
      const aspect = drag.origin.width / Math.max(drag.origin.height, 1e-6);
      const maxWidth = Math.min(
        size.width - drag.origin.x,
        (size.height - drag.origin.y) * aspect,
      );
      const width = Math.min(
        Math.max(MIN_WIDTH_PTS, drag.origin.width + dx),
        Math.max(MIN_WIDTH_PTS, maxWidth),
      );
      setLiveRect({ ...drag.origin, width, height: width / aspect });
    }
  }

  function endDrag() {
    if (!drag) return;
    // Only a real change commits — a bare click must not push an undo entry
    // or mark the document dirty.
    const r = liveRect;
    const o = stamp.rect;
    if (
      r &&
      (r.x !== o.x || r.y !== o.y || r.width !== o.width || r.height !== o.height)
    ) {
      updateStamp(stamp.id, r);
    }
    setDrag(null);
    setLiveRect(null);
  }

  return (
    <div
      className={cn(
        "group/stamp absolute",
        interactive && "pointer-events-auto cursor-move",
        drag && "opacity-90",
      )}
      style={{
        left: rect.x * scale,
        top: rect.y * scale,
        width: rect.width * scale,
        height: rect.height * scale,
      }}
      onPointerDown={(e) => beginDrag(e, "move")}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      role={interactive ? "button" : undefined}
      aria-label="Placed signature"
    >
      <img
        src={`data:image/png;base64,${stamp.pngBase64}`}
        alt="Signature"
        draggable={false}
        className="h-full w-full select-none"
      />
      {interactive && (
        <>
          {/* Selection chrome on hover / during drag */}
          <div
            className={cn(
              "pointer-events-none absolute -inset-1 rounded-sm ring-2 ring-primary/70 transition-opacity",
              drag ? "opacity-100" : "opacity-0 group-hover/stamp:opacity-100",
            )}
          />
          {/* Delete */}
          <button
            aria-label="Remove signature"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              removeStamp(stamp.id);
            }}
            className="absolute -right-2.5 -top-2.5 hidden h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-sm group-hover/stamp:flex"
          >
            <X className="h-3 w-3" />
          </button>
          {/* Resize handle (aspect-locked) */}
          <div
            aria-label="Resize signature"
            onPointerDown={(e) => beginDrag(e, "resize")}
            className="absolute -bottom-1.5 -right-1.5 hidden h-3 w-3 cursor-nwse-resize rounded-sm border border-primary bg-background shadow-sm group-hover/stamp:block"
          />
        </>
      )}
    </div>
  );
}
