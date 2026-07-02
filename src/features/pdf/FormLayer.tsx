/**
 * The interactive form (AcroForm) overlay.
 *
 * Each fillable widget is an absolutely-positioned native control placed
 * exactly over pdfium's rendering of the field. The DIVISION OF LABOR is the
 * key design decision:
 *
 *   - pdfium is the source of truth for how a field LOOKS. After every commit
 *     the backend regenerates the widget's appearance stream and the page
 *     raster repaints, so values display with the field's authored font,
 *     size, and alignment — in this app and in Adobe/Chrome/print.
 *   - the DOM control only hosts the INTERACTION: while a text field is
 *     unfocused its glyphs are transparent (the raster underneath shows the
 *     value); on focus it becomes an ordinary opaque input with a caret.
 *
 * Commits happen per field — on blur/Enter for text, immediately for toggles
 * and choices — and a failed commit keeps the user's draft and reports why.
 * Fields are interactive with the default Select tool only, so the markup
 * tools can still drag-select text across a form.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormField, FormFieldValue } from "@/types/pdf";
import { useFormStore } from "@/stores/form-store";
import { useUiStore } from "@/stores/ui-store";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface FormLayerProps {
  pageIndex: number;
  scale: number;
}

export function FormLayer({ pageIndex, scale }: FormLayerProps) {
  const allFields = useFormStore((s) => s.fields);
  const highlight = useFormStore((s) => s.highlight);
  const epoch = useFormStore((s) => s.epoch);
  const activeTool = useUiStore((s) => s.activeTool);

  const fields = useMemo(
    () => allFields.filter((f) => f.pageIndex === pageIndex),
    [allFields, pageIndex],
  );
  if (fields.length === 0) return null;

  // Fields are fillable with the default Select tool; markup tools keep the
  // page's text selectable underneath.
  const interactive = activeTool === "select";

  return (
    <div className="pointer-events-none absolute inset-0">
      {fields.map((field) => (
        <FieldWidget
          // Epoch in the key: after a page operation re-enumerates the
          // fields, widgets remount and any stale draft is discarded rather
          // than committed against shifted indices.
          key={`${epoch}-${field.pageIndex}-${field.annotIndex}`}
          field={field}
          scale={scale}
          highlight={highlight}
          interactive={interactive && !field.readOnly}
        />
      ))}
    </div>
  );
}

interface WidgetProps {
  field: FormField;
  scale: number;
  highlight: boolean;
  interactive: boolean;
}

/** Positioning + highlight chrome shared by all widget kinds. */
function widgetFrame(field: FormField, scale: number, highlight: boolean) {
  const style: React.CSSProperties = {
    position: "absolute",
    left: field.bounds.x * scale,
    top: field.bounds.y * scale,
    width: field.bounds.width * scale,
    height: field.bounds.height * scale,
  };
  const frame = cn(
    "rounded-[2px] transition-colors",
    highlight &&
      (field.kind === "signature"
        ? "bg-amber-400/15 ring-1 ring-amber-400/50"
        : "bg-indigo-400/15 ring-1 ring-indigo-400/40"),
  );
  return { style, frame };
}

function FieldWidget({ field, scale, highlight, interactive }: WidgetProps) {
  switch (field.kind) {
    case "text":
      return (
        <TextWidget
          field={field}
          scale={scale}
          highlight={highlight}
          interactive={interactive}
        />
      );
    case "checkbox":
    case "radioButton":
      return (
        <ToggleWidget
          field={field}
          scale={scale}
          highlight={highlight}
          interactive={interactive}
        />
      );
    case "comboBox":
    case "listBox":
      return field.editable ? (
        <TextWidget
          field={field}
          scale={scale}
          highlight={highlight}
          interactive={interactive}
        />
      ) : (
        <ChoiceWidget
          field={field}
          scale={scale}
          highlight={highlight}
          interactive={interactive}
        />
      );
    case "signature": {
      const { style, frame } = widgetFrame(field, scale, highlight);
      return (
        <div
          style={style}
          className={cn(frame, highlight && "border border-dashed border-amber-500/60")}
          title={field.name ? `Signature field: ${field.name}` : "Signature field"}
        />
      );
    }
    default:
      return null;
  }
}

/** Report a failed commit without losing the user's input. */
function reportCommitError(err: unknown) {
  toast.error(
    "Couldn't fill the field",
    err instanceof Error ? err.message : "The form field rejected the value.",
  );
}

function TextWidget({ field, scale, highlight, interactive }: WidgetProps) {
  const commit = useFormStore((s) => s.commit);
  // `draft` is the user's uncommitted typing; null = mirroring the document.
  const [draft, setDraft] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  // Set by Escape so the imminent blur discards instead of committing (the
  // DOM node still holds the abandoned text when blur fires).
  const cancelledRef = useRef(false);

  const committedValue = field.value ?? "";
  const shown = draft ?? committedValue;
  // While unfocused with nothing pending, glyphs are transparent — the raster
  // beneath displays the value in the field's real (PDF-authored) font.
  const showNative = focused || draft !== null;

  const { style, frame } = widgetFrame(field, scale, highlight);
  const fontSizePx =
    Math.min(Math.max(field.bounds.height * 0.62, 6), 13) * scale;

  async function commitDraft(value: string) {
    if (value === committedValue) {
      setDraft(null);
      return;
    }
    try {
      await commit({
        kind: "text",
        pageIndex: field.pageIndex,
        annotIndex: field.annotIndex,
        value,
      });
      setDraft(null);
    } catch (err) {
      reportCommitError(err); // draft is kept; the user can retry or Escape
    }
  }

  const shared = {
    value: shown,
    disabled: !interactive,
    spellCheck: false,
    "aria-label": field.name ?? "Form text field",
    onFocus: () => setFocused(true),
    onBlur: (
      e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
      setFocused(false);
      if (cancelledRef.current) {
        cancelledRef.current = false;
        setDraft(null);
        return;
      }
      void commitDraft(e.currentTarget.value);
    },
    onChange: (
      e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => setDraft(e.currentTarget.value),
    className: cn(
      "absolute inset-0 h-full w-full resize-none border-0 outline-none",
      interactive ? "pointer-events-auto" : "pointer-events-none",
      showNative
        ? "bg-white text-slate-900 ring-2 ring-primary"
        : "bg-transparent text-transparent caret-transparent",
    ),
    style: {
      fontSize: fontSizePx,
      fontFamily: "Helvetica, Arial, sans-serif",
      padding: `0 ${Math.max(1, 2 * scale)}px`,
    } as React.CSSProperties,
  };

  function escape(e: React.KeyboardEvent<HTMLElement>) {
    cancelledRef.current = true;
    e.currentTarget.blur();
  }

  // The highlight tint lives on the WRAPPER: putting it on the control would
  // let tailwind-merge collapse it with the state background classes above.
  return (
    <div style={style} className={frame}>
      {field.multiline ? (
        <textarea
          {...shared}
          onKeyDown={(e) => {
            if (e.key === "Escape") escape(e);
          }}
        />
      ) : (
        <input
          {...shared}
          type={field.password ? "password" : "text"}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur(); // blur commits
            } else if (e.key === "Escape") {
              escape(e);
            }
          }}
        />
      )}
    </div>
  );
}

function ToggleWidget({ field, scale, highlight, interactive }: WidgetProps) {
  const commit = useFormStore((s) => s.commit);
  const { style, frame } = widgetFrame(field, scale, highlight);
  const isRadio = field.kind === "radioButton";

  // Optimistic checked state: rapid clicks must each toggle from what the
  // user SEES, not from the last committed value still in flight. Cleared
  // whenever the authoritative field state arrives.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  useEffect(() => setOptimistic(null), [field.checked]);
  const checked = optimistic ?? field.checked ?? false;

  async function handleClick() {
    // A checked radio stays checked on click (matching viewer behavior).
    if (isRadio && checked) return;
    const next = !checked;
    setOptimistic(next);
    const value: FormFieldValue = isRadio
      ? {
          kind: "radio",
          pageIndex: field.pageIndex,
          annotIndex: field.annotIndex,
        }
      : {
          kind: "checkbox",
          pageIndex: field.pageIndex,
          annotIndex: field.annotIndex,
          checked: next,
        };
    try {
      await commit(value);
    } catch (err) {
      setOptimistic(null);
      reportCommitError(err);
    }
  }

  return (
    <button
      type="button"
      role={isRadio ? "radio" : "checkbox"}
      aria-checked={checked}
      aria-label={field.name ?? (isRadio ? "Radio button" : "Checkbox")}
      disabled={!interactive}
      onClick={() => void handleClick()}
      style={style}
      className={cn(
        frame,
        interactive
          ? "pointer-events-auto cursor-pointer hover:ring-2 hover:ring-primary/60 focus-visible:ring-2 focus-visible:ring-primary"
          : "pointer-events-none",
      )}
    />
  );
}

function ChoiceWidget({ field, scale, highlight, interactive }: WidgetProps) {
  const commit = useFormStore((s) => s.commit);
  const { style, frame } = widgetFrame(field, scale, highlight);
  // Selection identity is the backend-reported INDEX. Matching by label
  // would break on the common `[export, label]` /Opt form ("MI" vs
  // "Michigan") and on repeated labels.
  const selectedIndex = field.selectedIndex ?? -1;

  async function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const optionIndex = Number(e.currentTarget.value);
    if (Number.isNaN(optionIndex) || optionIndex < 0) return;
    try {
      await commit({
        kind: "choice",
        pageIndex: field.pageIndex,
        annotIndex: field.annotIndex,
        optionIndex,
      });
    } catch (err) {
      reportCommitError(err); // controlled select snaps back to field.value
    }
  }

  // The highlight tint lives on the wrapper so tailwind-merge can't collapse
  // it with the select's own transparent background.
  return (
    <div style={style} className={frame}>
      <select
        value={selectedIndex >= 0 ? String(selectedIndex) : ""}
        disabled={!interactive}
        aria-label={field.name ?? "Choice field"}
        onChange={(e) => void handleChange(e)}
        style={{
          fontSize:
            Math.min(Math.max(field.bounds.height * 0.62, 6), 13) * scale,
        }}
        className={cn(
          "absolute inset-0 h-full w-full appearance-none border-0 outline-none",
          // Transparent face: the raster shows the committed value; the
          // native dropdown list itself uses readable colors (set on the
          // options). Keyboard focus makes the face opaque so arrow-key
          // navigation shows each selection instantly, without waiting for
          // the commit round-trip and raster repaint.
          "bg-transparent text-transparent",
          interactive
            ? "pointer-events-auto cursor-pointer hover:ring-2 hover:ring-primary/60 focus-visible:ring-2 focus-visible:ring-primary focus-visible:bg-white focus-visible:text-slate-900"
            : "pointer-events-none",
        )}
      >
        <option value="" disabled hidden />
        {field.options.map((label, i) => (
          <option key={i} value={String(i)} className="bg-background text-foreground">
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}
