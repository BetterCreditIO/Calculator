import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// @tauri-apps/cli sets TAURI_DEV_HOST when running `tauri dev` on a device/network.
const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
// Vite config is tuned for Tauri: a fixed dev port, no clearScreen (so Rust
// compiler errors stay visible), and HMR wired to the Tauri dev host.
export default defineConfig(async () => ({
  plugins: [react()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // Prevent Vite from obscuring Rust errors emitted by `tauri dev`.
  clearScreen: false,

  // Tauri expects a fixed port; fail rather than silently pick another.
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Don't watch the Rust source tree from the frontend dev server.
      ignored: ["**/src-tauri/**"],
    },
  },

  // Produce sensible output for the bundled webview.
  build: {
    // Tauri uses Chromium (WebView2 on Windows); target accordingly.
    target: "chrome105",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Split heavy, independently-cacheable vendors out of the main chunk.
        manualChunks: {
          react: ["react", "react-dom"],
          charts: ["recharts"],
        },
      },
    },
  },

  // Quieter, deterministic env handling.
  envPrefix: ["VITE_", "TAURI_ENV_"],
}));
