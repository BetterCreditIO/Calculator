/**
 * The selectable / editable text overlay.
 *
 * Each text span from the backend is rendered as an absolutely-positioned
 * element placed exactly over the rendered glyphs. Fidelity comes from three
 * things working together (see lib/text-metrics.ts for the full rationale):
 *
 *  1. GEOMETRY — span boxes arrive in top-left point space from PDFium and are
 *     multiplied by the current scale, so positions are exact by construction.
 *  2. FONT MATCHING — the PDF font name is classified into a local
 *     serif/sans/mono stack with bold/italic, so the overlay's glyph shapes and
 *     relative advances start close to the original.
 *  3. METRIC CALIBRATION — the run is measured with the matched font and
 *     stretched with `scaleX` so its total advance equals the painted run's
 *     width exactly. Selection and caret positions then track the raster to
 *     within a fraction of a glyph (the same technique PDF.js uses).
 *
 * With the Edit tool, double-clicking a span opens an inline editor. A
 * committed edit is previewed in place — white-out plus replacement text in the
 * matched font, size, and color — which mirrors what the backend bakes into the
 * saved PDF, so the preview is honest about the output.
 */
import { useMemo, useEffect, useRef, useState } from "react";
import { Pipette } from "lucide-react";
import type { TextSpan, TextEdit } from "@/types/pdf";
import { useAnnotationStore } from "@/stores/annotation-store";
import { useDocumentStore } from "@/stores/document-store";
import { cn, uid } from "@/lib/utils";
import {
  matchFontStyle,
  cssFont,
  horizontalScale,
  type FontStyle,
} from "./lib/text-metrics";
import { sampleBackground, getEyeDropper } from "./lib/edit-background";

/**
 * The editor's background choice: match the sampled page background, paint
 * nothing, or paint an explicit color.
 */
type BgChoice = "auto" | "none" | { color: string };

interface TextLayerProps {
  pageIndex: number;
  spans: TextSpan[];
  scale: number;
  editable: boolean;
  /** Rendered page raster (data URL) — the background-sampling source. */
  rasterUrl: string | null;
  /** Page width in PDF points (maps raster pixels back to point space). */
  pageWidthPts: number;
  /** Page height in PDF points (keeps the editor toolbar on the page). */
  pageHeightPts: number;
}

export function TextLayer({
  pageIndex,
  spans,
  scale,
  editable,
  rasterUrl,
  pageWidthPts,
  pageHeightPts,
}: TextLayerProps) {
  const edits = useAnnotationStore((s) => s.edits);
  const activeSearchHit = useDocumentStore((s) => s.activeSearchHit);

  const editsBySpan = useMemo(() => {
    const map = new Map<number, TextEdit>();
    for (const e of edits) {
      if (e.pageIndex === pageIndex) map.set(e.spanIndex, e);
    }
    return map;
  }, [edits, pageIndex]);

  const hitSpanIndex =
    activeSearchHit && activeSearchHit.pageIndex === pageIndex
      ? activeSearchHit.spanIndex
      : null;

  return (
    <div className={"absolute inset-0 " + (editable ? "" : "select-text")}>
      {spans.map((span) => (
        <SpanView
          key={span.index}
          span={span}
          scale={scale}
          editable={editable}
          pageIndex={pageIndex}
          pendingEdit={editsBySpan.get(span.index)}
          isSearchHit={span.index === hitSpanIndex}
          rasterUrl={rasterUrl}
          pageWidthPts={pageWidthPts}
          pageHeightPts={pageHeightPts}
        />
      ))}
    </div>
  );
}

interface SpanViewProps {
  span: TextSpan;
  scale: number;
  editable: boolean;
  pageIndex: number;
  pendingEdit: TextEdit | undefined;
  isSearchHit: boolean;
  rasterUrl: string | null;
  pageWidthPts: number;
  pageHeightPts: number;
}

function SpanView({
  span,
  scale,
  editable,
  pageIndex,
  pendingEdit,
  isSearchHit,
  rasterUrl,
  pageWidthPts,
  pageHeightPts,
}: SpanViewProps) {
  const [editing, setEditing] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const upsertEdit = useAnnotationStore((s) => s.upsertEdit);
  const removeEdit = useAnnotationStore((s) => s.removeEdit);

  // Background matching. `sampled` is the auto-detected page color around
  // this run; `bgChoice` is what the user selected in the editor toolbar.
  const [sampled, setSampled] = useState<string | null>(null);
  const [bgChoice, setBgChoice] = useState<BgChoice>("auto");

  // Sample when the editor opens (the raster is already decoded in memory,
  // so this settles in a few milliseconds).
  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    void sampleBackground(rasterUrl, pageWidthPts, span.bounds).then((hex) => {
      if (!cancelled && hex) setSampled(hex);
    });
    return () => {
      cancelled = true;
    };
  }, [editing, rasterUrl, pageWidthPts, span.bounds]);

  /** The color the current choice resolves to; null = paint nothing. */
  function resolveBackground(choice: BgChoice): string | null {
    if (choice === "auto") return sampled ?? "#ffffff";
    if (choice === "none") return null;
    return choice.color;
  }

  const left = span.bounds.x * scale;
  const top = span.bounds.y * scale;
  const width = span.bounds.width * scale;
  const height = span.bounds.height * scale;
  const fontSizePx = span.fontSize * scale;

  // Matched font + calibrated horizontal scale (memoized per zoom level).
  const style: FontStyle = useMemo(
    () => matchFontStyle(span.fontName, span.bold, span.italic),
    [span.fontName, span.bold, span.italic],
  );
  const scaleX = useMemo(
    () => horizontalScale(span.text, cssFont(style, fontSizePx), width),
    [span.text, style, fontSizePx, width],
  );

  // Re-opening an edited span restores its committed background choice.
  function openEditor() {
    if (pendingEdit) {
      setBgChoice(
        pendingEdit.backgroundExplicit && pendingEdit.background
          ? { color: pendingEdit.background }
          : pendingEdit.background === null
            ? "none"
            : "auto",
      );
    } else {
      setBgChoice("auto");
    }
    setEditing(true);
  }

  // Focus + select-all when entering edit mode.
  useEffect(() => {
    if (editing && editorRef.current) {
      editorRef.current.focus();
      const range = document.createRange();
      range.selectNodeContents(editorRef.current);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [editing]);

  const displayText = pendingEdit?.newText ?? span.text;

  function commit(newText: string) {
    setEditing(false);
    const background = resolveBackground(bgChoice);
    const backgroundExplicit = bgChoice !== "auto" && bgChoice !== "none";
    if (newText === span.text && !backgroundExplicit) {
      // Back to the original — clear any pending edit for this span.
      if (pendingEdit) removeEdit(pendingEdit.id);
      return;
    }
    if (
      pendingEdit &&
      newText === pendingEdit.newText &&
      background === pendingEdit.background &&
      backgroundExplicit === pendingEdit.backgroundExplicit
    ) {
      return; // unchanged — don't push a redundant undo entry
    }
    upsertEdit({
      id: pendingEdit?.id ?? uid("edit"),
      pageIndex,
      spanIndex: span.index,
      originalBounds: span.bounds,
      originalText: span.text,
      newText,
      fontSize: span.fontSize,
      fontName: span.fontName,
      bold: style.bold,
      italic: style.italic,
      color: span.color ?? "#111827",
      baseline: span.baseline,
      background,
      backgroundExplicit,
    });
  }

  const typography: React.CSSProperties = {
    fontFamily: style.family,
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? "italic" : "normal",
    fontSize: fontSizePx,
  };

  const baseStyle: React.CSSProperties = {
    position: "absolute",
    left,
    top,
    height,
    lineHeight: `${height}px`,
    whiteSpace: "pre",
    cursor: editable ? "text" : "auto",
    ...typography,
  };

  // The three render states below carry distinct `key`s so React REMOUNTS the
  // element on state change instead of reusing it. contentEditable text lives
  // outside React's control; without a remount, text typed and then abandoned
  // via Escape would survive in the reused DOM node.

  // Active inline editor — unscaled for comfortable typing; the matched font
  // and size make it read like the document. The box previews the CHOSEN
  // background (the sampled page color while typing when "no fill" is
  // selected, purely for legibility over the original glyphs).
  if (editing) {
    const chosen = resolveBackground(bgChoice);
    return (
      <>
        <div
          key="editor"
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          onBlur={(e) => commit(e.currentTarget.textContent ?? "")}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit(e.currentTarget.textContent ?? "");
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
          className="z-20 rounded-[2px] outline outline-2 outline-primary"
          style={{
            ...baseStyle,
            minWidth: width,
            color: span.color ?? "#111827",
            backgroundColor: chosen ?? sampled ?? "#ffffff",
          }}
        >
          {displayText}
        </div>
        <BackgroundToolbar
          left={left}
          // The page box clips overflow, so flip above the edit near the
          // page bottom (the toolbar is ~34px tall).
          top={
            top + height + 44 > pageHeightPts * scale
              ? top - 40
              : top + height
          }
          sampled={sampled}
          choice={bgChoice}
          onChoose={setBgChoice}
          refocus={() => editorRef.current?.focus()}
        />
      </>
    );
  }

  // Committed-edit preview: cover the original glyphs in the edit's own
  // background (or none) and show the replacement in matched typography —
  // the same output the save produces.
  if (pendingEdit) {
    return (
      <div
        key="edited"
        onDoubleClick={() => editable && openEditor()}
        className="z-10"
        style={{
          ...baseStyle,
          minWidth: width,
          color: pendingEdit.color,
          backgroundColor: pendingEdit.background ?? "transparent",
        }}
        title="Edited — double-click to change"
      >
        {displayText}
      </div>
    );
  }

  // Normal selectable span: transparent glyphs, width-calibrated via scaleX so
  // selection geometry matches the raster.
  return (
    <div
      key="plain"
      onDoubleClick={() => editable && openEditor()}
      className={
        "selectable" +
        (isSearchHit
          ? " rounded-[2px] outline outline-2 outline-amber-400 bg-amber-300/30"
          : "")
      }
      style={{
        ...baseStyle,
        color: "transparent",
        transform: `scaleX(${scaleX})`,
        transformOrigin: "0 0",
      }}
    >
      {span.text}
    </div>
  );
}

/**
 * Floating color control under the active text editor: match the sampled
 * page background (default), plain white, no fill (transparent), a custom
 * color, or pick any pixel on screen with the OS eyedropper. All buttons
 * preventDefault on mousedown so the contentEditable never loses focus —
 * choosing a color must not commit the edit.
 */
function BackgroundToolbar({
  left,
  top,
  sampled,
  choice,
  onChoose,
  refocus,
}: {
  left: number;
  top: number;
  sampled: string | null;
  choice: BgChoice;
  onChoose: (choice: BgChoice) => void;
  refocus: () => void;
}) {
  const eyeDropperCtor = getEyeDropper();
  const customColor = typeof choice === "object" ? choice.color : "#ffffff";

  async function pickFromScreen() {
    if (!eyeDropperCtor) return;
    try {
      const result = await new eyeDropperCtor().open();
      onChoose({ color: result.sRGBHex });
    } catch {
      // Cancelled with Escape — keep the current choice.
    }
    refocus();
  }

  const swatch = (active: boolean) =>
    cn(
      "h-5 w-5 shrink-0 rounded-full ring-1 ring-black/20 transition-transform hover:scale-110",
      active && "ring-2 ring-primary ring-offset-1",
    );

  return (
    <div
      className="absolute z-30 flex items-center gap-1.5 rounded-md border bg-card px-2 py-1.5 shadow-lg"
      style={{ left, top: top + 6 }}
      onMouseDown={(e) => e.preventDefault()}
      role="toolbar"
      aria-label="Edit background color"
    >
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Fill
      </span>
      <button
        type="button"
        title="Match page background (sampled from the document)"
        aria-label="Match page background"
        onClick={() => onChoose("auto")}
        className={swatch(choice === "auto")}
        style={{ backgroundColor: sampled ?? "#ffffff" }}
      />
      <button
        type="button"
        title="White"
        aria-label="White fill"
        onClick={() => onChoose({ color: "#ffffff" })}
        className={cn(
          swatch(typeof choice === "object" && choice.color === "#ffffff"),
          "bg-white",
        )}
      />
      <button
        type="button"
        title="No fill (transparent)"
        aria-label="No fill"
        onClick={() => onChoose("none")}
        className={cn(swatch(choice === "none"), "relative overflow-hidden bg-white")}
      >
        <span className="absolute left-1/2 top-1/2 h-[1.5px] w-6 -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-red-500" />
      </button>
      <label
        title="Custom color"
        className={cn(
          swatch(
            typeof choice === "object" && choice.color !== "#ffffff",
          ),
          "relative cursor-pointer",
        )}
        style={{
          backgroundColor:
            typeof choice === "object" && choice.color !== "#ffffff"
              ? choice.color
              : undefined,
          backgroundImage:
            typeof choice === "object" && choice.color !== "#ffffff"
              ? undefined
              : "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)",
        }}
      >
        <input
          type="color"
          value={customColor}
          onChange={(e) => onChoose({ color: e.target.value })}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          aria-label="Custom fill color"
        />
      </label>
      {eyeDropperCtor && (
        <button
          type="button"
          title="Pick a color from the screen"
          aria-label="Pick a color from the screen"
          onClick={() => void pickFromScreen()}
          className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <Pipette className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
