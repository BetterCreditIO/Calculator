/**
 * Interactive form (AcroForm) state for the open document.
 *
 * Fields are enumerated once per document (and re-enumerated after structural
 * page operations, which shift widget indices). A commit sends ONE field value
 * to the backend, which drives pdfium's form-fill machinery and returns the
 * authoritative post-fill state for every field — radio groups clear their
 * siblings, text may be truncated to the field's MaxLen, read-only fields
 * refuse the change. The store then bumps the document revision so page
 * rasters repaint with pdfium's own rendering of the new value.
 */
import { create } from "zustand";
import type { FormField, FormFieldValue } from "@/types/pdf";
import { listFormFields, fillFormFields } from "@/lib/tauri";
import { useDocumentStore, onBeforePageOp } from "@/stores/document-store";
import { useAnnotationStore } from "@/stores/annotation-store";
import { toast } from "@/hooks/use-toast";

interface FormState {
  /** All fillable widgets in the document (all pages). */
  fields: FormField[];
  /** Document id the fields belong to (guards stale async results). */
  docId: string | null;
  status: "idle" | "loading" | "ready";
  /**
   * Incremented every time the fields are re-enumerated (document open or a
   * structural page operation). Widget indices are only meaningful within one
   * epoch: a commit begun against an older epoch is refused, and the overlay
   * keys widgets by epoch so stale drafts are discarded rather than written
   * into whatever widget now occupies the old index.
   */
  epoch: number;
  /** Whether field locations are visually highlighted on the page. */
  highlight: boolean;

  /** Enumerate the fields of the given document. */
  load: (docId: string) => Promise<void>;
  reset: () => void;
  /**
   * Discard the current fields and epoch SYNCHRONOUSLY. Runs before a page
   * operation dispatches, so no widget stays interactive (and no queued
   * commit stays valid) against indices that are about to shift.
   */
  invalidate: () => void;
  toggleHighlight: () => void;

  /**
   * Apply one field value in the engine. Commits are QUEUED, not rejected,
   * while another is in flight (tabbing quickly between fields must never
   * drop a value). Resolves once this value has been applied; rejects
   * (leaving store state untouched) on failure so the caller can keep the
   * user's draft and surface the error.
   *
   * KNOWN LIMITATION: fills mutate the engine's document bytes directly, so
   * they are not part of the annotation undo stack — Ctrl+Z does not revert
   * a field value (matching the "committed to the form" mental model);
   * re-editing the field is the way back.
   */
  commit: (value: FormFieldValue) => Promise<void>;
}

/** Tail of the commit queue; each commit chains behind the previous one. */
let commitTail: Promise<void> = Promise.resolve();

/**
 * Pages whose visible field state differs between two enumerations, always
 * including the page that was directly edited.
 */
function changedPages(
  before: FormField[],
  after: FormField[],
  editedPage: number,
): number[] {
  const pages = new Set<number>([editedPage]);
  const key = (f: FormField) => `${f.pageIndex}:${f.annotIndex}`;
  const prior = new Map(before.map((f) => [key(f), f]));
  for (const f of after) {
    const old = prior.get(key(f));
    if (old && (old.value !== f.value || old.checked !== f.checked)) {
      pages.add(f.pageIndex);
    }
  }
  return [...pages];
}

/** Document id the "fillable form" notice was last shown for (once per doc). */
let noticeShownFor: string | null = null;

export const useFormStore = create<FormState>((set, get) => ({
  fields: [],
  docId: null,
  status: "idle",
  epoch: 0,
  highlight: true,

  load: async (docId) => {
    // Bump the epoch and CLEAR the fields synchronously, before any await:
    // the document (or its page structure) just changed, so stale widgets
    // must neither render nor accept input while re-enumeration is in
    // flight, and any commit captured against old indices must be refused.
    set((s) => ({ docId, status: "loading", epoch: s.epoch + 1, fields: [] }));
    try {
      const fields = await listFormFields(docId);
      // Discard if another document was opened while we were fetching.
      if (get().docId !== docId) return;
      set({ fields, status: "ready" });
      // Fields re-enumerate after every page operation; announce once per doc.
      const fillable = fields.filter((f) => f.kind !== "signature").length;
      if (fillable > 0 && noticeShownFor !== docId) {
        noticeShownFor = docId;
        toast.show(
          "This PDF has a fillable form",
          `${fillable} field${fillable === 1 ? "" : "s"} detected — click any highlighted field to fill it. Values are written into the real form, so they read correctly in any viewer.`,
        );
      }
    } catch {
      if (get().docId !== docId) return;
      // Enumeration failing (e.g. malformed form) degrades to "no fields".
      set({ fields: [], status: "ready" });
    }
  },

  reset: () =>
    set((s) => ({
      fields: [],
      docId: null,
      status: "idle",
      epoch: s.epoch + 1,
    })),

  invalidate: () =>
    set((s) => ({ fields: [], status: "loading", epoch: s.epoch + 1 })),

  toggleHighlight: () => set((s) => ({ highlight: !s.highlight })),

  commit: (value) => {
    // Widget indices are epoch-scoped; a queued commit must not apply after
    // a page operation has shifted them.
    const epochAtCall = get().epoch;
    const run = async () => {
      const docId = get().docId;
      if (!docId) throw new Error("No document is open.");
      if (get().epoch !== epochAtCall) {
        throw new Error(
          "The document changed while editing — please re-enter the value.",
        );
      }
      const previous = get().fields;
      const fields = await fillFormFields(docId, [value]);
      // Discard if the document (or its structure) changed mid-flight.
      if (get().docId !== docId || get().epoch !== epochAtCall) return;
      set({ fields, status: "ready" });
      // Repaint exactly the pages whose field state changed (a radio
      // selection can clear a sibling on another page) and flag unsaved
      // state so the Save affordances light up.
      useDocumentStore
        .getState()
        .bumpPageRevisions(changedPages(previous, fields, value.pageIndex));
      useAnnotationStore.getState().markDirty();
    };
    // Chain behind the previous commit whether it succeeded or failed; each
    // caller observes only its own outcome.
    const result = commitTail.then(run, run);
    commitTail = result.catch(() => {});
    return result;
  },
}));

/**
 * Resolves once every commit enqueued so far has settled. The save flow
 * awaits this (after blurring the focused field, which enqueues its draft)
 * so a document is never written without the value the user just typed.
 */
export function flushFormCommits(): Promise<void> {
  return commitTail.then(
    () => undefined,
    () => undefined,
  );
}

// Structural page operations shift widget indices; invalidate BEFORE the op
// is dispatched to the engine (see document-store's onBeforePageOp).
onBeforePageOp(() => useFormStore.getState().invalidate());
