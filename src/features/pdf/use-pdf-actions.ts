/**
 * High-level document actions that combine native dialogs, the backend bridge,
 * and the app stores. Components call these instead of touching IPC directly.
 */
import { useCallback } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useDocumentStore } from "@/stores/document-store";
import { useAnnotationStore } from "@/stores/annotation-store";
import { saveDocument as saveDocumentCmd } from "@/lib/tauri";
import { toast, useToastStore } from "@/hooks/use-toast";

const PDF_FILTER = [{ name: "PDF Document", extensions: ["pdf"] }];

/** Returns a callback that prompts for a PDF and opens it. */
export function useOpenDocument() {
  const openFromPath = useDocumentStore((s) => s.openFromPath);
  const resetAnnotations = useAnnotationStore((s) => s.reset);

  return useCallback(async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        filters: PDF_FILTER,
        title: "Open PDF",
      });
      if (typeof selected !== "string") return; // cancelled
      resetAnnotations();
      await openFromPath(selected);
    } catch (err) {
      toast.error(
        "Couldn't open the file",
        err instanceof Error ? err.message : String(err),
      );
    }
  }, [openFromPath, resetAnnotations]);
}

/** Returns a callback that saves the current document (with markup) to a new file. */
export function useSaveDocument() {
  return useCallback(async () => {
    const { meta } = useDocumentStore.getState();
    if (!meta) {
      toast.error("Nothing to save", "Open a PDF first.");
      return;
    }
    const { annotations, edits, markSaved } = useAnnotationStore.getState();

    try {
      const suggested = suggestSaveName(meta.path, meta.title);
      const outputPath = await saveDialog({
        defaultPath: suggested,
        filters: PDF_FILTER,
        title: "Save PDF As",
      });
      if (!outputPath) return; // cancelled

      const savingId = toast.show("Saving…", "Applying edits and markup.");
      await saveDocumentCmd({ id: meta.id, outputPath, edits, annotations });
      useToastStore.getState().dismiss(savingId);
      markSaved();
      toast.success("Saved", `Wrote ${baseName(outputPath)}.`);
    } catch (err) {
      toast.error(
        "Save failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }, []);
}

/** Open a document directly from a file path (used by drag-and-drop). */
export function useOpenPath() {
  const openFromPath = useDocumentStore((s) => s.openFromPath);
  const resetAnnotations = useAnnotationStore((s) => s.reset);
  return useCallback(
    async (path: string) => {
      if (!path.toLowerCase().endsWith(".pdf")) {
        toast.error("Unsupported file", "Only PDF files can be opened.");
        return;
      }
      try {
        resetAnnotations();
        await openFromPath(path);
      } catch (err) {
        toast.error(
          "Couldn't open the file",
          err instanceof Error ? err.message : String(err),
        );
      }
    },
    [openFromPath, resetAnnotations],
  );
}

function suggestSaveName(path: string | null, title: string): string {
  if (path) {
    return path.replace(/\.pdf$/i, "") + " (edited).pdf";
  }
  const safe = title.replace(/[^\w\-. ]+/g, "").trim() || "document";
  return `${safe.replace(/\.pdf$/i, "")} (edited).pdf`;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
