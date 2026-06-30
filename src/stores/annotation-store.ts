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
import type { Annotation, TextEdit } from "@/types/pdf";

interface Snapshot {
  annotations: Annotation[];
  edits: TextEdit[];
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

  undo: () => void;
  redo: () => void;
  reset: () => void;
  markSaved: () => void;
}

const EMPTY: Snapshot = { annotations: [], edits: [] };
const HISTORY_LIMIT = 100;

export const useAnnotationStore = create<AnnotationState>((set, get) => {
  /** Push the current snapshot onto the undo stack before a mutation. */
  function commit(next: Snapshot) {
    const { annotations, edits, past } = get();
    const snapshot: Snapshot = { annotations, edits };
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
      }),

    removeAnnotation: (id) =>
      commit({
        annotations: get().annotations.filter((a) => a.id !== id),
        edits: get().edits,
      }),

    updateAnnotation: (id, patch) =>
      commit({
        annotations: get().annotations.map((a) =>
          a.id === id ? { ...a, ...patch } : a,
        ),
        edits: get().edits,
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
      commit({ annotations: get().annotations, edits: nextEdits });
    },

    removeEdit: (id) =>
      commit({
        annotations: get().annotations,
        edits: get().edits.filter((e) => e.id !== id),
      }),

    undo: () => {
      const { past, future, annotations, edits } = get();
      const previous = past[past.length - 1];
      if (!previous) return;
      set({
        ...previous,
        dirty: true,
        past: past.slice(0, -1),
        future: [{ annotations, edits }, ...future].slice(0, HISTORY_LIMIT),
      });
    },

    redo: () => {
      const { past, future, annotations, edits } = get();
      const next = future[0];
      if (!next) return;
      set({
        ...next,
        dirty: true,
        past: [...past, { annotations, edits }].slice(-HISTORY_LIMIT),
        future: future.slice(1),
      });
    },

    reset: () =>
      set({ ...EMPTY, dirty: false, past: [], future: [] }),

    markSaved: () => set({ dirty: false }),
  };
});
