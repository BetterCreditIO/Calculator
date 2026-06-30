import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { applyTheme, useUiStore } from "@/stores/ui-store";

// Apply the persisted theme immediately (the inline script in index.html does a
// first pass to avoid a flash; this re-syncs once the store has hydrated).
applyTheme(useUiStore.getState().theme);

// Keep "system" theme in sync with OS changes while the app is running.
if (window.matchMedia) {
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      const { theme } = useUiStore.getState();
      if (theme === "system") applyTheme("system");
    });
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
