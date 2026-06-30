/**
 * The selectable / editable text overlay.
 *
 * Each text span from the backend is rendered as an absolutely-positioned,
 * transparent element placed exactly over the rendered glyphs (geometry comes
 * from Pdfium, converted once to top-left point space, then multiplied by the
 * current scale here). This gives:
 *   • accurate text selection and copy over the raster, and
 *   • a precise anchor for in-place editing.
 *
 * When the Edit tool is active, double-clicking a span turns it into an inline
 * editor. A committed edit is stored as a {@link TextEdit} and previewed in
 * place (white-out + new text) — the same transformation the backend bakes in
 * on save, so what you see is what you get.
 */
import { useEffect, useRef, useState } from "react";
import type { TextSpan, TextEdit } from "@/types/pdf";
import { useAnnotationStore } from "@/stores/annotation-store";
import { uid } from "@/lib/utils";

interface TextLayerProps {
  pageIndex: number;
  spans: TextSpan[];
  scale: number;
  editable: boolean;
}

export function TextLayer({ pageIndex, spans, scale, editable }: TextLayerProps) {
  const edits = useAnnotationStore((s) => s.edits);
  const editsBySpan = new Map<number, TextEdit>();
  for (const e of edits) {
    if (e.pageIndex === pageIndex) editsBySpan.set(e.spanIndex, e);
  }

  return (
    <div
      className={
        "absolute inset-0 " + (editable ? "" : "select-text")
      }
      // The text itself is transparent; only selection + edit previews show.
      style={{ lineHeight: 1 }}
    >
      {spans.map((span) => (
        <SpanView
          key={span.index}
          span={span}
          scale={scale}
          editable={editable}
          pageIndex={pageIndex}
          pendingEdit={editsBySpan.get(span.index)}
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
}

function SpanView({
  span,
  scale,
  editable,
  pageIndex,
  pendingEdit,
}: SpanViewProps) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const upsertEdit = useAnnotationStore((s) => s.upsertEdit);
  const removeEdit = useAnnotationStore((s) => s.removeEdit);

  const left = span.bounds.x * scale;
  const top = span.bounds.y * scale;
  const width = span.bounds.width * scale;
  const height = span.bounds.height * scale;
  const fontSize = span.fontSize * scale;

  // Focus + select all when entering edit mode.
  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      const range = document.createRange();
      range.selectNodeContents(ref.current);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [editing]);

  const hasEdit = !!pendingEdit;
  const displayText = pendingEdit?.newText ?? span.text;

  function commit(newText: string) {
    setEditing(false);
    const trimmed = newText;
    if (trimmed === span.text) {
      if (pendingEdit) removeEdit(pendingEdit.id);
      return;
    }
    const edit: TextEdit = {
      id: pendingEdit?.id ?? uid("edit"),
      pageIndex,
      spanIndex: span.index,
      originalBounds: span.bounds,
      originalText: span.text,
      newText: trimmed,
      fontSize: span.fontSize,
      fontName: span.fontName,
      color: span.color ?? "#111827",
    };
    upsertEdit(edit);
  }

  const baseStyle: React.CSSProperties = {
    position: "absolute",
    left,
    top,
    height,
    minWidth: width,
    fontSize,
    fontFamily: "Inter, system-ui, sans-serif",
    whiteSpace: "pre",
    transformOrigin: "left top",
    cursor: editable ? "text" : "auto",
  };

  // Active inline editor.
  if (editing) {
    return (
      <div
        ref={ref}
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
        className="z-20 rounded-sm bg-white text-black outline outline-2 outline-primary"
        style={{ ...baseStyle, color: "#000", display: "flex", alignItems: "center" }}
      >
        {displayText}
      </div>
    );
  }

  // Committed-edit preview: white-out the original and show the new text.
  if (hasEdit) {
    return (
      <div
        onDoubleClick={() => editable && setEditing(true)}
        className="z-10 bg-white text-black"
        style={{ ...baseStyle, color: "#111827", display: "flex", alignItems: "center" }}
        title="Edited — double-click to change"
      >
        {displayText}
      </div>
    );
  }

  // Normal selectable (transparent) span.
  return (
    <div
      onDoubleClick={() => editable && setEditing(true)}
      className="selectable"
      style={{ ...baseStyle, color: "transparent" }}
    >
      {span.text}
    </div>
  );
}
