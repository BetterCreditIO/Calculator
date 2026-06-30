# PDFium runtime library

This directory holds the **PDFium dynamic library** that the Rust PDF engine
(`pdfium-render`) binds to at runtime. The binary itself is **not committed**
(it's large and platform-specific — see the root `.gitignore`).

## Get it

From the project root:

```bash
npm run pdfium          # Windows pdfium.dll (for bundling) + your host lib (for dev)
npm run pdfium win      # Windows pdfium.dll only
npm run pdfium host     # your current platform only
```

This downloads from [bblanchon/pdfium-binaries](https://github.com/bblanchon/pdfium-binaries).

## Where it goes

- `src-tauri/lib/pdfium.dll` — bundled into the Windows installer as a resource
  (`tauri.conf.json` → `bundle.resources`). The engine finds it via the app's
  resource directory at runtime.
- `src-tauri/libpdfium.so` / `libpdfium.dylib` — placed for local `tauri dev` on
  Linux/macOS so the engine can bind during development.

The engine's lookup order is: resource dir → executable dir → working dir →
system library path.
