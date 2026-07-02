/**
 * Markup & edit state for the open document: highlights, underlines,
 * strikethroughs, comments, redactions, and pending in-place text edits.
 *
 * This is the in-memory model the editor mutates as the user works. On save,
 * the document store hands these to the backend (`save_document`) which bakes
 * them into a new PDF. A simple undo/redo stack keeps the editing experience
 * professional.
 */
import { create } from "zustand";
import type { Annotation, ImageStamp, TextEdit } from "@/types/pdf";
import {
  remapAnnotations,
  remapEdits,
  remapStamps,
  type PageRemap,
} from "@/features/pdf/lib/page-remap";

interface Snapshot {
  annotations: Annotation[];
  edits: TextEdit[];
  /** Placed signature stamps (baked as image XObjects on save). */
  stamps: ImageStamp[];
}

interface AnnotationState extends Snapshot {
  /** True once any change has been made since the last save. */
  dirty: boolean;

  past: Snapshot[];
  future: Snapshot[];

  addAnnotation: (annotation: Annotation) => void;
  removeAnnotation: (id: string) => void;
  updateAnnotation: (id: string, patch: Partial<Annotation>) => void;

  upsertEdit: (edit: TextEdit) => void;
  removeEdit: (id: string) => void;

  addStamp: (stamp: ImageStamp) => void;
  /** Move/resize a placed stamp. */
  updateStamp: (id: string, rect: ImageStamp["rect"]) => void;
  removeStamp: (id: string) => void;

  undo: () => void;
  redo: () => void;
  reset: () => void;
  markSaved: () => void;
  /** Mark unsaved state without touching content (structural page changes). */
  markDirty: () => void;

  /**
   * Realign annotations/edits after a structural page change (rotate, delete,
   * move, insert). Undo history is cleared — snapshots taken against the old
   * page structure would restore items onto the wrong pages.
   */
  applyPageRemap: (remap: PageRemap) => void;
}

const EMPTY: Snapshot = { annotations: [], edits: [], stamps: [] };
const HISTORY_LIMIT = 100;

export const useAnnotationStore = create<AnnotationState>((set, get) => {
  /** Push the current snapshot onto the undo stack before a mutation. */
  function commit(next: Snapshot) {
    const { annotations, edits, stamps, past } = get();
    const snapshot: Snapshot = { annotations, edits, stamps };
    set({
      ...next,
      dirty: true,
      past: [...past.slice(-HISTORY_LIMIT + 1), snapshot],
      future: [],
    });
  }

  return {
    ...EMPTY,
    dirty: false,
    past: [],
    future: [],

    addAnnotation: (annotation) =>
      commit({
        annotations: [...get().annotations, annotation],
        edits: get().edits,
        stamps: get().stamps,
      }),

    removeAnnotation: (id) =>
      commit({
        annotations: get().annotations.filter((a) => a.id !== id),
        edits: get().edits,
        stamps: get().stamps,
      }),

    updateAnnotation: (id, patch) =>
      commit({
        annotations: get().annotations.map((a) =>
          a.id === id ? { ...a, ...patch } : a,
        ),
        edits: get().edits,
        stamps: get().stamps,
      }),

    upsertEdit: (edit) => {
      const edits = get().edits;
      const existing = edits.findIndex(
        (e) => e.pageIndex === edit.pageIndex && e.spanIndex === edit.spanIndex,
      );
      const nextEdits =
        existing >= 0
          ? edits.map((e, i) => (i === existing ? edit : e))
          : [...edits, edit];
      commit({
        annotations: get().annotations,
        edits: nextEdits,
        stamps: get().stamps,
      });
    },

    removeEdit: (id) =>
      commit({
        annotations: get().annotations,
        edits: get().edits.filter((e) => e.id !== id),
        stamps: get().stamps,
      }),

    addStamp: (stamp) =>
      commit({
        annotations: get().annotations,
        edits: get().edits,
        stamps: [...get().stamps, stamp],
      }),

    updateStamp: (id, rect) =>
      commit({
        annotations: get().annotations,
        edits: get().edits,
        stamps: get().stamps.map((s) => (s.id === id ? { ...s, rect } : s)),
      }),

    removeStamp: (id) =>
      commit({
        annotations: get().annotations,
        edits: get().edits,
        stamps: get().stamps.filter((s) => s.id !== id),
      }),

    undo: () => {
      const { past, future, annotations, edits, stamps } = get();
      const previous = past[past.length - 1];
      if (!previous) return;
      set({
        ...previous,
        dirty: true,
        past: past.slice(0, -1),
        future: [{ annotations, edits, stamps }, ...future].slice(
          0,
          HISTORY_LIMIT,
        ),
      });
    },

    redo: () => {
      const { past, future, annotations, edits, stamps } = get();
      const next = future[0];
      if (!next) return;
      set({
        ...next,
        dirty: true,
        past: [...past, { annotations, edits, stamps }].slice(-HISTORY_LIMIT),
        future: future.slice(1),
      });
    },

    reset: () =>
      set({ ...EMPTY, dirty: false, past: [], future: [] }),

    markSaved: () => set({ dirty: false }),

    markDirty: () => set({ dirty: true }),

    applyPageRemap: (remap) =>
      set((s) => ({
        annotations: remapAnnotations(s.annotations, remap),
        edits: remapEdits(s.edits, remap),
        stamps: remapStamps(s.stamps, remap),
        // The document structure changed in the engine, so there is always
        // unsaved state now, and old snapshots are no longer index-valid.
        dirty: true,
        past: [],
        future: [],
      })),
  };
});
