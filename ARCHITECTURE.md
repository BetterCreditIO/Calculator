# Lumen PDF — Architecture & Technical Plan

Lumen PDF is a premium, downloadable **Windows desktop** PDF editor with an
integrated **Illinois mortgage & affordability calculator**. This document is
the architectural plan: the design decisions, data flows, fidelity strategy,
security model, and distribution mechanism. Read it before the code.

---

## 1. Goals & non-negotiables

| Requirement | How it is met |
|---|---|
| Native, downloadable Windows app + auto-update | Tauri 2 → NSIS installer + signed Tauri updater |
| Very high text reading/editing fidelity | PDFium raster + point-accurate text overlay (hybrid) |
| Professional, enterprise-grade UI | React + TypeScript + Tailwind + shadcn/ui, dark/light |
| Built-in mortgage calculator (IL taxes + insurance) | Pure TS engine + cited Illinois averages |
| Smooth, responsive, no jank | Lazy/virtualized page rendering, GPU transitions, off-thread PDF work |
| Clean, maintainable, production-ready code | Strict TS, typed IPC boundary, single-responsibility modules, tests |

---

## 2. Technology stack & rationale

- **Tauri 2 (Rust core + web frontend).** Small installers (~a few MB vs.
  Electron's ~100 MB), native performance, a hardened capability-based security
  model, and a first-party updater + bundler. The Rust core hosts the PDF
  engine; the webview hosts the UI.
- **PDFium via `pdfium-render` (Rust).** PDFium is the engine inside Chrome —
  the gold standard for rendering fidelity and text extraction with real glyph
  geometry. This is the single biggest fidelity lever and the reason we are not
  on a pure-JS stack.
- **React + TypeScript + Tailwind + shadcn-style components.** A fast, typed,
  themeable UI with a consistent design system driven by CSS variables.
- **Zustand** for state — minimal boilerplate, selector-based subscriptions, and
  trivially usable from non-React code (e.g. toast/IPC helpers).
- **Recharts** for the payment-breakdown donut chart.

Verified versions in use: Tauri `2.11.x`, `pdfium-render 0.9.x`,
`@tauri-apps/api 2.11.x`, React `18.3`, Vite `5.4`, Tailwind `3.4`.

---

## 3. Process & threading model

```
┌──────────────────────────────────────────────────────────────┐
│  WebView (Chromium / WebView2)                                 │
│  React UI · Zustand stores · typed IPC bridge (src/lib/tauri)  │
└───────────────▲───────────────────────────┬──────────────────┘
                │  invoke(cmd, args)         │  ArrayBuffer / JSON
                │                            ▼
┌──────────────────────────────────────────────────────────────┐
│  Tauri Rust core  (src-tauri)                                  │
│  commands.rs  → thin handlers, marshalling, file IO            │
│        │ channel (request + reply)                             │
│        ▼                                                       │
│  PdfEngine facade  →  ┌───────────────────────────────────┐   │
│                       │  pdfium-worker thread (single)     │   │
│                       │  owns Pdfium + document byte cache │   │
│                       └───────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

**Why a dedicated worker thread?** PDFium is *not* thread-safe and prefers a
single calling thread; Tauri dispatches commands across a pool. We therefore run
PDFium on one owned thread and communicate over a channel: each command sends a
request with a per-request reply channel and blocks on it. This guarantees
serialized, same-thread PDFium access **with no `unsafe`, no global locks bleeding
into the rest of the app, and no self-referential lifetime problems** (a
`PdfDocument` borrows from `Pdfium`).

**Document storage.** The worker caches only the raw file *bytes* per document
id and re-parses them per operation. Re-parsing is cheap next to rendering, and
the frontend caches rendered rasters as object URLs, so pages are re-rendered
only when the zoom level changes.

---

## 4. PDF rendering pipeline

1. **Open** — `open_pdf(path)` reads bytes (Rust `std::fs`), hands them to the
   engine, which parses metadata + per-page point dimensions and returns
   `DocumentMeta`.
2. **Render** — `render_page(id, pageIndex, scale)` rasterizes the page with
   PDFium at `scale × devicePixelRatio` device pixels (crisp on HiDPI), encodes
   PNG from the raw RGBA buffer using our own `image` crate (decoupled from
   pdfium-render's internal image version), and returns the bytes as a raw
   `tauri::ipc::Response` → arrives in JS as an **ArrayBuffer** (no base64
   bloat). The frontend wraps it in a `Blob` object URL.
3. **Lazy display** — `PdfViewer` lays out every page at its exact box; each
   `PdfPage` only fetches its raster + text layer when within ~1000px of the
   viewport (`IntersectionObserver`), and revokes object URLs on unmount/zoom.
   Large documents stay smooth and memory-bounded while the scrollbar stays
   accurate.

---

## 5. Text reading & editing fidelity — the core strategy

This is the heart of the product. We use a **hybrid raster + geometry overlay**,
the same shape of solution mature editors use.

### 5.1 Display layer (pixel-perfect)
Pages are shown as PDFium rasters. What the user sees is byte-for-byte what
PDFium (Chrome's engine) produces — fonts, kerning, vector art, and images are
all exact.

### 5.2 Selectable/editable text overlay (geometry- and style-accurate)
For each page we extract characters via PDFium's text API and group them into
**style-aware, line-level spans**: a run splits whenever the font name, size,
weight, italic flag, or fill color changes, so every span is a single styled,
editable unit. Each span carries its real (matrix-scaled) font size, raw PDF
font name, bold/italic flags, fill color, and the exact **baseline Y** (from
`FPDFText_GetCharOrigin`). Geometry is converted **once, at the Rust
boundary**, from PDFium's native space (points, origin bottom-left, y-up) into
a normalized **top-left, point-based** space:

```
x = left
y = pageHeight − top
w = right − left
h = top − bottom
```

On the DOM side (see `lib/text-metrics.ts`), the overlay then applies the same
technique PDF.js uses for its text layer:
1. the PDF font name is classified into the closest local family class
   (serif / sans / mono, with bold/italic), and
2. the run is measured with the matched CSS font and stretched with
   `transform: scaleX(target / natural)` so its total advance width equals the
   painted run's width exactly.

Selection highlights and caret positions then track the raster to within a
fraction of a glyph across the whole run.

### 5.3 In-place editing
With the Edit tool, double-clicking a span turns it into an inline editor
rendered in the matched font, size, and color. A committed change becomes a
`TextEdit` (original geometry + baseline + style + new text) and is **previewed
in place** — the original glyphs are whited-out and the replacement is shown in
matched typography. *What you see is what gets saved.*

### 5.4 Persisting edits with fidelity (`save_document`) — two tiers

**Tier 1 — true in-place edit (best case, Acrobat's mechanism).** The backend
locates the page **text object** that draws the edited run (bounds overlap +
text match) and rewrites its string via `FPDFText_SetText`. The object keeps
its **original font, size, matrix, color, and render mode** — for same-font
edits the output is indistinguishable from the source document. Guard rail:
subsetted embedded fonts (`ABCDEF+…`) only carry glyphs the document already
uses, so this tier is taken only when every replacement character already
occurs in that object's text; page content is explicitly regenerated afterward
(`set_text` alone does not mark the page dirty in pdfium-render 0.9).

**Tier 2 — white-out + matched-font re-stamp (fallback).** When no safe object
match exists, the original glyph region is covered and the replacement is
stamped as a new text object **on the original baseline** at the extracted font
size and fill color, using the closest PDF standard-14 font
(Helvetica/Times/Courier × bold/italic) classified from the original font name
— the same classification the on-screen preview uses, so preview and output
agree.

**Markup:** highlight / underline / strikethrough / redaction are baked in as
filled rectangle path objects at the recorded geometry; comments are flattened
as visible notes.

**Honest fidelity ceiling.** Tier 1 preserves the original font outright. Tier
2 substitutes the closest standard family at exact position/size/color — the
same practical limit any editor hits when a subsetted embedded font lacks the
glyphs an edit introduces (Acrobat warns and substitutes in this case too).

---

## 6. IPC contract (the typed boundary)

Every backend call lives in exactly one typed wrapper in `src/lib/tauri.ts`,
mirroring serde structs in `src-tauri/src/pdf/models.rs`
(`#[serde(rename_all = "camelCase")]` keeps the wire format aligned). Errors are
normalized to a single `BackendError` with the failing command's context.

| Command | Args | Returns |
|---|---|---|
| `open_pdf` | `path` | `DocumentMeta` |
| `open_pdf_bytes` | `bytes, name` | `DocumentMeta` |
| `close_pdf` | `id` | `()` |
| `render_page` | `id, pageIndex, scale` | PNG bytes (ArrayBuffer) |
| `get_page_text` | `id, pageIndex` | `PageTextLayer` |
| `search_text` | `id, query` | `SearchHit[]` |
| `write_text_file` | `path, contents` | `()` |
| `save_document` | `id, outputPath, edits, annotations` | `()` |

---

## 7. State management

| Store | Responsibility |
|---|---|
| `document-store` | open document, viewport (page/zoom/fit), cached text layers, scroll requests |
| `annotation-store` | annotations + pending edits, undo/redo, dirty flag |
| `ui-store` | theme, active tool, panel visibility, markup color (persisted prefs) |
| `calculator-store` | calculator inputs + saved scenarios (persisted) |

Derived values (e.g. the `MortgageResult`) are computed with `useMemo`, never
stored, so they can't go stale.

---

## 8. Mortgage calculator — data flow & sourcing

```
inputs (calculator-store)
   └─ buildMortgageInput() ── resolves county → tax rate, insurance mode → $/yr
         └─ computeMortgage() (pure) ── P&I, PITI, PMI w/ auto-cancel, amortization
               └─ UI: total, donut chart, yearly schedule, export, scenarios
```

- **P&I:** `M = P·[r(1+r)ⁿ]/[(1+r)ⁿ−1]`, with the `r = 0` straight-line case.
- **PMI:** applied when down payment < 20%, auto-cancels in the schedule when the
  balance reaches 80% of the original value (per the Homeowners Protection Act).
- **Property tax:** `price × county effective rate ÷ 12`. County rates are a
  single internally-consistent dataset (SmartAsset, mid-2026): IL statewide
  1.92%, Cook 1.89%, DuPage 1.91%, Lake 2.43%, Will 2.12%, Kane 2.26%, McHenry
  2.18% (national median ≈ 0.89% for context).
- **Insurance:** modeled at ≈ $7.40 per $1,000 of coverage (derived from the IL
  average ≈ $2,225/yr at $300k, Bankrate Nov 2025), with a realistic floor; a
  custom annual amount can be entered instead.

**Every tax/insurance figure is labeled an ESTIMATE** throughout the UI and the
exported report, with a clear "not financial advice" disclaimer. The pure engine
is exhaustively unit-tested (`mortgage.test.ts`).

---

## 9. File handling & security model

- **Capability-based permissions** (`src-tauri/capabilities/default.json`): the
  webview gets only `core:default`, the dialog permissions it needs, and
  `updater:default`. **No broad filesystem permission is granted to the webview.**
- **All file IO happens in trusted Rust commands** (`open_pdf`,
  `write_text_file`, PDF save), and only ever to paths the user explicitly chose
  via the native open/save dialog. The web layer cannot read or write arbitrary
  paths.
- **Strict CSP** (`default-src 'self'`, images limited to `self`/`blob:`/`data:`,
  scripts to `self`). No remote code, no inline scripts in app code.
- **Updates are cryptographically signed**; unsigned updates are rejected.

---

## 10. Performance

- Off-thread PDF work keeps the UI thread free.
- Lazy, viewport-gated page + thumbnail rendering with reserved layout boxes.
- High-DPI rasters for crisp text; raster object URLs revoked promptly.
- `requestAnimationFrame`-throttled scroll-spy.
- Vendor code-splitting (React, charts) for fast startup.
- GPU-friendly transitions; no layout-thrashing animations.

---

## 11. Update mechanism (Windows)

- `tauri-plugin-updater` checks the configured `plugins.updater.endpoints` on
  launch (and on demand from the menu). A newer **signed** release prompts the
  user, downloads, and installs (NSIS `passive` mode), then relaunches.
- **Release signing:** generate keys once with `tauri signer generate`; put the
  public key in `tauri.conf.json` → `plugins.updater.pubkey`; provide the private
  key to CI via `TAURI_SIGNING_PRIVATE_KEY`. `bundle.createUpdaterArtifacts` is
  enabled so the build emits the signed update artifact + `latest.json`.

---

## 12. Distribution / Windows installer

- **Bundler:** NSIS (`bundle.targets: ["nsis"]`), `currentUser` install (no admin
  prompt — ideal for a direct website download). WiX/MSI is available for
  enterprise deployment (Windows-only build).
- **WebView2:** `downloadBootstrapper` (tiny installer; fetches the runtime if
  absent — present on all current Windows). `offlineInstaller`/`fixedVersion`
  are options for air-gapped environments.
- **PDFium runtime:** `pdfium.dll` (from `bblanchon/pdfium-binaries`) is fetched
  into `src-tauri/lib/` at build time and bundled as a resource; the engine
  locates it via the resource dir → exe dir → cwd → system path.

See `README.md` for the exact build commands.

---

## 13. Testing & verification

- **Mortgage engine:** 15 unit tests (formula correctness, 0% case, full
  amortization, PMI on/off + auto-cancel, NaN resilience) — `npm test`.
- **Frontend:** strict `tsc --noEmit` + production `vite build` in CI.
- **Backend:** the Tauri-free PDF logic (`error`/`models`/`engine`) is
  type-checked against the real `pdfium-render` API; `cargo fmt`/`clippy` in CI.

---

## 14. Project layout

```
├─ src/                      # React + TypeScript frontend
│  ├─ components/ui/         # shadcn-style primitives
│  ├─ components/layout/     # TopBar, StatusBar, SearchBar, ThemeToggle
│  ├─ features/pdf/          # viewer, page, text/annotation layers, toolbar, actions
│  ├─ features/mortgage/     # calculator, chart, schedule, scenarios, lib (math/data/export)
│  ├─ stores/                # Zustand stores
│  ├─ hooks/                 # toast, shortcuts, file-drop, updater, in-view
│  ├─ lib/                   # typed IPC bridge + utils
│  └─ types/                 # shared PDF domain types
└─ src-tauri/                # Rust core
   ├─ src/pdf/               # engine.rs, commands.rs, models.rs
   ├─ src/error.rs, lib.rs, main.rs
   ├─ capabilities/          # security capabilities
   └─ tauri.conf.json
```

---

## 15. Known limitations & future work

- Tier-2 edits substitute the closest standard-14 font when the original
  (typically a subsetted embed) can't safely render the new characters (§5.4).
- Markup is created from text selection (highlight/underline/strikethrough) and
  pointer drag (redaction); text-flow-aware redaction of reflowed runs is future
  work.
- Rotated pages render correctly; the text overlay assumes upright pages
  (rotation metadata is captured for a future overlay transform).
- Comments are flattened on save; round-trippable PDF annotation objects are a
  natural enhancement.
- In-place (Tier-1) edits keep the object's original layout matrix; a large
  length change can alter line justification, as it does in other editors.
```
