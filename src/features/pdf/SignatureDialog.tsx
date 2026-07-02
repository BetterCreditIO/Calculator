/**
 * The signature capture dialog: DRAW with pointer/pen/touch, or TYPE a name
 * rendered in a script font. Either path produces a transparent PNG, trimmed
 * to the ink's bounding box, which the viewer then places on a page with a
 * click and the backend bakes into the PDF as a real image XObject on save.
 *
 * Drawing renders at devicePixelRatio for crisp ink, with quadratic midpoint
 * smoothing (each segment curves through the midpoint of successive samples —
 * the standard technique for natural-looking strokes from coarse events).
 */
import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Logical (CSS pixel) size of the drawing surface. */
const PAD_W = 480;
const PAD_H = 180;
/** Transparent padding preserved around the trimmed ink. */
const TRIM_MARGIN = 6;

const INK_COLORS = [
  { name: "Black", value: "#111827" },
  { name: "Blue", value: "#1d4ed8" },
] as const;

const SCRIPT_FONTS = [
  { name: "Elegant", css: '"Segoe Script", "Brush Script MT", cursive' },
  { name: "Classic", css: '"Lucida Handwriting", "Brush Script MT", cursive' },
  { name: "Casual", css: '"Comic Sans MS", "Segoe Print", cursive' },
] as const;

export interface CapturedSignature {
  /** PNG bytes, base64 (no data: prefix), transparent background. */
  pngBase64: string;
  /** width / height of the trimmed image. */
  aspect: number;
}

interface SignatureDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCapture: (signature: CapturedSignature) => void;
}

export function SignatureDialog({
  open,
  onOpenChange,
  onCapture,
}: SignatureDialogProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [hasInk, setHasInk] = useState(false);
  const [ink, setInk] = useState<string>(INK_COLORS[0].value);
  const [tab, setTab] = useState<"draw" | "type">("draw");
  const [typedName, setTypedName] = useState("");
  const [font, setFont] = useState<string>(SCRIPT_FONTS[0].css);

  // (Re)initialize the canvas backing store each time the dialog opens.
  // NOT keyed on `tab`: peeking at the Type tab must not erase drawn ink
  // (the draw pane stays mounted via forceMount below).
  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = PAD_W * dpr;
    canvas.height = PAD_H * dpr;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, PAD_W, PAD_H);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    }
    setHasInk(false);
    lastPointRef.current = null;
  }, [open]);

  function pointFromEvent(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * PAD_W,
      y: ((e.clientY - rect.top) / rect.height) * PAD_H,
    };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    const point = pointFromEvent(e);
    lastPointRef.current = point;
    // Ink a dot immediately so taps without movement mark the page —
    // the dots on i's and periods of a real signature.
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) {
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 1.2, 0, Math.PI * 2);
      ctx.fill();
      setHasInk(true);
    }
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    const last = lastPointRef.current;
    if (!ctx || !last) return;
    const point = pointFromEvent(e);
    // Curve through the midpoint for smooth ink.
    const mid = { x: (last.x + point.x) / 2, y: (last.y + point.y) / 2 };
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.quadraticCurveTo(last.x, last.y, mid.x, mid.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    lastPointRef.current = point;
    setHasInk(true);
  }

  function handlePointerUp() {
    drawingRef.current = false;
    lastPointRef.current = null;
  }

  function clearPad() {
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) ctx.clearRect(0, 0, PAD_W, PAD_H);
    setHasInk(false);
  }

  function captureDrawn() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const result = trimmedPng(canvas);
    if (result) {
      onCapture(result);
      onOpenChange(false);
    }
  }

  function captureTyped() {
    const name = typedName.trim();
    if (!name) return;
    // Render the name to an offscreen canvas at 3× for smooth glyph edges.
    const scale = 3;
    const fontSize = 56;
    const measure = document.createElement("canvas").getContext("2d");
    if (!measure) return;
    measure.font = `${fontSize}px ${font}`;
    const textWidth = Math.ceil(measure.measureText(name).width);
    const canvas = document.createElement("canvas");
    canvas.width = (textWidth + 40) * scale;
    canvas.height = fontSize * 2 * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.font = `${fontSize}px ${font}`;
    ctx.fillStyle = ink;
    ctx.textBaseline = "middle";
    ctx.fillText(name, 20, fontSize);
    const result = trimmedPng(canvas);
    if (result) {
      onCapture(result);
      onOpenChange(false);
    }
  }

  const canUse = tab === "draw" ? hasInk : typedName.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Add your signature</DialogTitle>
          <DialogDescription>
            Draw or type a signature, then click anywhere on the document to
            place it. It is embedded into the PDF when you save.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as "draw" | "type")}>
          <div className="flex items-center justify-between">
            <TabsList>
              <TabsTrigger value="draw">Draw</TabsTrigger>
              <TabsTrigger value="type">Type</TabsTrigger>
            </TabsList>
            {/* Ink color, shared by both modes. */}
            <div className="flex items-center gap-1.5">
              {INK_COLORS.map((c) => (
                <button
                  key={c.value}
                  onClick={() => setInk(c.value)}
                  aria-label={`${c.name} ink`}
                  className={cn(
                    "h-5 w-5 rounded-full ring-1 ring-black/15 transition-transform hover:scale-110",
                    ink === c.value && "ring-2 ring-primary ring-offset-1",
                  )}
                  style={{ backgroundColor: c.value }}
                />
              ))}
            </div>
          </div>

          <TabsContent
            value="draw"
            forceMount
            className="mt-3 data-[state=inactive]:hidden"
          >
            <div className="relative overflow-hidden rounded-lg border bg-white">
              <canvas
                ref={canvasRef}
                style={{ width: "100%", height: PAD_H, touchAction: "none" }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerLeave={handlePointerUp}
                aria-label="Signature drawing pad"
              />
              {/* Baseline guide */}
              <div className="pointer-events-none absolute inset-x-8 bottom-10 border-b border-dashed border-slate-300" />
              {!hasInk && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-slate-400">
                  Sign here
                </div>
              )}
            </div>
            <div className="mt-2 flex justify-end">
              <Button variant="ghost" size="sm" onClick={clearPad} disabled={!hasInk}>
                Clear
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="type" className="mt-3 space-y-3">
            <Input
              placeholder="Type your name"
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              aria-label="Typed signature name"
            />
            <div className="grid grid-cols-3 gap-2">
              {SCRIPT_FONTS.map((f) => (
                <button
                  key={f.name}
                  onClick={() => setFont(f.css)}
                  className={cn(
                    "flex h-16 items-center justify-center overflow-hidden rounded-lg border bg-white px-2 text-xl",
                    font === f.css
                      ? "border-primary ring-1 ring-primary"
                      : "hover:border-slate-300",
                  )}
                  style={{ fontFamily: f.css, color: ink }}
                >
                  {typedName.trim() || "Signature"}
                </button>
              ))}
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={tab === "draw" ? captureDrawn : captureTyped}
            disabled={!canUse}
          >
            Use signature
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Crop a canvas to its non-transparent bounding box (plus a small margin) and
 * return the PNG base64 + aspect ratio. Returns null for a blank canvas.
 */
function trimmedPng(canvas: HTMLCanvasElement): CapturedSignature | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null; // blank

  minX = Math.max(0, minX - TRIM_MARGIN);
  minY = Math.max(0, minY - TRIM_MARGIN);
  maxX = Math.min(width - 1, maxX + TRIM_MARGIN);
  maxY = Math.min(height - 1, maxY + TRIM_MARGIN);
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const outCtx = out.getContext("2d");
  if (!outCtx) return null;
  outCtx.drawImage(canvas, minX, minY, w, h, 0, 0, w, h);

  const dataUrl = out.toDataURL("image/png");
  return {
    pngBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
    aspect: w / h,
  };
}
