/**
 * Global UI state: theme, active tool, panel visibility.
 *
 * Theme is persisted under the "goodboy-theme" key. The inline script in
 * index.html reads the SAME key before React mounts to apply the correct
 * `.dark` class immediately and avoid a flash of the wrong theme.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AnnotationType } from "@/types/pdf";

export type Theme = "light" | "dark" | "system";

/** Tools selectable from the markup toolbar. `select` is the default cursor. */
export type Tool = "select" | "edit" | AnnotationType;

interface UiState {
  theme: Theme;
  setTheme: (theme: Theme) => void;

  activeTool: Tool;
  setActiveTool: (tool: Tool) => void;

  thumbnailsOpen: boolean;
  toggleThumbnails: () => void;

  calculatorOpen: boolean;
  setCalculatorOpen: (open: boolean) => void;
  toggleCalculator: () => void;

  /** Active markup color (shared by highlight/underline/etc.). */
  markupColor: string;
  setMarkupColor: (color: string) => void;
}

/** Resolve a Theme preference to the concrete light/dark value. */
export function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return theme;
}

/** Apply the resolved theme to the document root. */
export function applyTheme(theme: Theme): void {
  const resolved = resolveTheme(theme);
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: "system",
      setTheme: (theme) => {
        applyTheme(theme);
        set({ theme });
      },

      activeTool: "select",
      setActiveTool: (activeTool) => set({ activeTool }),

      thumbnailsOpen: true,
      toggleThumbnails: () =>
        set((s) => ({ thumbnailsOpen: !s.thumbnailsOpen })),

      calculatorOpen: false,
      setCalculatorOpen: (calculatorOpen) => set({ calculatorOpen }),
      toggleCalculator: () =>
        set((s) => ({ calculatorOpen: !s.calculatorOpen })),

      markupColor: "#fde047", // amber-300, the classic highlighter yellow
      setMarkupColor: (markupColor) => set({ markupColor }),
    }),
    {
      name: "goodboy-theme",
      // Only persist the durable preferences, not ephemeral tool/panel state.
      partialize: (s) => ({ theme: s.theme, markupColor: s.markupColor }),
    },
  ),
);
