/**
 * Minimal, dependency-light toast system backed by Zustand.
 *
 * A custom store (rather than a heavier toast library) keeps the surface small
 * and fully typed. `toast()` can be called from anywhere — including non-React
 * code such as the Tauri action helpers — because it operates on the store
 * directly.
 */
import { create } from "zustand";
import { uid } from "@/lib/utils";

export type ToastVariant = "default" | "success" | "error";

export interface Toast {
  id: string;
  title: string;
  description?: string;
  variant: ToastVariant;
  /** Auto-dismiss delay in ms; 0 keeps it until dismissed. */
  duration: number;
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, "id" | "duration" | "variant"> & {
    variant?: ToastVariant;
    duration?: number;
  }) => string;
  dismiss: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (input) => {
    const id = uid("toast");
    const toast: Toast = {
      id,
      title: input.title,
      description: input.description,
      variant: input.variant ?? "default",
      duration: input.duration ?? 4500,
    };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    if (toast.duration > 0) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, toast.duration);
    }
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Imperative helpers usable outside React. */
export const toast = {
  show: (title: string, description?: string) =>
    useToastStore.getState().push({ title, description }),
  success: (title: string, description?: string) =>
    useToastStore.getState().push({ title, description, variant: "success" }),
  error: (title: string, description?: string) =>
    useToastStore
      .getState()
      .push({ title, description, variant: "error", duration: 7000 }),
};
