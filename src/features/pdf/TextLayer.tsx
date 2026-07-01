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
import type { TextSpan, TextEdit } from "@/types/pdf";
import { useAnnotationStore } from "@/stores/annotation-store";
import { useDocumentStore } from "@/stores/document-store";
import { uid } from "@/lib/utils";
import {
  matchFontStyle,
  cssFont,
  horizontalScale,
  type FontStyle,
} from "./lib/text-metrics";

interface TextLayerProps {
  pageIndex: number;
  spans: TextSpan[];
  scale: number;
  editable: boolean;
}

export function TextLayer({ pageIndex, spans, scale, editable }: TextLayerProps) {
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
}

function SpanView({
  span,
  scale,
  editable,
  pageIndex,
  pendingEdit,
  isSearchHit,
}: SpanViewProps) {
  const [editing, setEditing] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const upsertEdit = useAnnotationStore((s) => s.upsertEdit);
  const removeEdit = useAnnotationStore((s) => s.removeEdit);

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
    if (newText === span.text) {
      // Back to the original — clear any pending edit for this span.
      if (pendingEdit) removeEdit(pendingEdit.id);
      return;
    }
    if (pendingEdit && newText === pendingEdit.newText) {
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
  // and size make it read like the document.
  if (editing) {
    return (
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
        className="z-20 rounded-[2px] bg-white outline outline-2 outline-primary"
        style={{ ...baseStyle, minWidth: width, color: span.color ?? "#111827" }}
      >
        {displayText}
      </div>
    );
  }

  // Committed-edit preview: white-out the original glyphs and show the
  // replacement in matched typography — the same output the save produces.
  if (pendingEdit) {
    return (
      <div
        key="edited"
        onDoubleClick={() => editable && setEditing(true)}
        className="z-10 bg-white"
        style={{
          ...baseStyle,
          minWidth: width,
          color: pendingEdit.color,
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
      onDoubleClick={() => editable && setEditing(true)}
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
