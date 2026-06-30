/**
 * Global keyboard shortcuts. Mounted once at the app root.
 *
 * Single-key tool shortcuts are ignored while the user is typing in an input,
 * textarea, contentEditable region, or the calculator, so they never fight with
 * text entry.
 */
import { useEffect } from "react";
import { useUiStore, type Tool } from "@/stores/ui-store";
import { useDocumentStore } from "@/stores/document-store";
import { useAnnotationStore } from "@/stores/annotation-store";
import { useOpenDocument, useSaveDocument } from "@/features/pdf/use-pdf-actions";

const TOOL_KEYS: Record<string, Tool> = {
  v: "select",
  e: "edit",
  h: "highlight",
  u: "underline",
  c: "comment",
  r: "redaction",
};

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  );
}

export function useKeyboardShortcuts() {
  const openDocument = useOpenDocument();
  const saveDocument = useSaveDocument();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const ui = useUiStore.getState();
      const doc = useDocumentStore.getState();
      const ann = useAnnotationStore.getState();
      const mod = e.ctrlKey || e.metaKey;

      // ---- Modifier combos (work even while focused, except text fields) ----
      if (mod) {
        const key = e.key.toLowerCase();
        switch (key) {
          case "o":
            e.preventDefault();
            void openDocument();
            return;
          case "s":
            e.preventDefault();
            void saveDocument();
            return;
          case "m":
            e.preventDefault();
            ui.toggleCalculator();
            return;
          case "z":
            if (!isTypingTarget(e.target)) {
              e.preventDefault();
              if (e.shiftKey) ann.redo();
              else ann.undo();
            }
            return;
          case "y":
            if (!isTypingTarget(e.target)) {
              e.preventDefault();
              ann.redo();
            }
            return;
          case "=":
          case "+":
            e.preventDefault();
            doc.zoomIn();
            return;
          case "-":
            e.preventDefault();
            doc.zoomOut();
            return;
          case "0":
            e.preventDefault();
            doc.setFitMode("width");
            return;
          default:
            return;
        }
      }

      // ---- Single-key tool shortcuts (not while typing) ----
      if (isTypingTarget(e.target)) return;
      const tool = TOOL_KEYS[e.key.toLowerCase()];
      if (tool && doc.meta) {
        e.preventDefault();
        ui.setActiveTool(tool);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openDocument, saveDocument]);
}
