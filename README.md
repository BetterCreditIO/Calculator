<div align="center">

# GoodBoyPdf

**A premium desktop PDF editor with an integrated Illinois mortgage calculator.**

*Produced by Goodboy Labs*

High-fidelity reading & editing powered by PDFium · built with Tauri 2, React & TypeScript

</div>

---

GoodBoyPdf is a fast, beautiful, native **Windows** desktop application for
reading, marking up, and editing PDFs — with a built-in, professional-grade
**mortgage & affordability calculator** tuned for Illinois. It is designed for
loan officers, real-estate agents, and small-business owners who need a tool
that feels trustworthy and works without jank.

> **Disclaimer:** the calculator's property-tax and homeowners-insurance figures
> are **estimates** based on Illinois county/state averages. They are not
> financial advice. Always confirm with your county assessor and an insurance
> agent.

## Features

**PDF viewer & editor**
- High-fidelity PDFium rendering (the engine inside Chrome), crisp on HiDPI
- Metric-calibrated text selection: glyph-accurate boxes with font-matched,
  width-calibrated overlay runs (the PDF.js technique)
- Two-tier in-place text editing: true text-object rewrites that keep the
  original embedded font where safe, with a matched-font baseline-exact
  re-stamp fallback — previewed in place before saving
- Markup: highlight, underline, strikethrough, comments, redaction
- Page-thumbnail sidebar (HiDPI-sharp), full-text search with on-page hit
  highlighting, cursor-anchored Ctrl+wheel zoom, fit-width / fit-page
- Undo/redo, keyboard shortcuts, dark & light themes

**Mortgage & affordability calculator**
- Inputs: purchase price, down-payment %, term, interest rate
- Monthly principal & interest, estimated Illinois property tax (Cook, DuPage,
  Lake, Will, Kane, McHenry, or statewide), estimated homeowners insurance, PMI,
  and HOA → total monthly housing cost
- Donut breakdown chart + year-by-year amortization schedule
- Save/compare scenarios and export an estimate report

## Tech stack

| Layer | Choice |
|---|---|
| Shell / packaging | Tauri 2 (Rust) → NSIS installer + signed auto-updater |
| PDF engine | PDFium via `pdfium-render` |
| UI | React 18 · TypeScript · Tailwind CSS · shadcn-style components |
| State | Zustand · Charts: Recharts |

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the full technical plan,
including the text-editing fidelity strategy and security model.

## Prerequisites

- **Node.js 22+** and npm
- **Rust** (stable) — https://rustup.rs
- Tauri's platform prerequisites — https://v2.tauri.app/start/prerequisites/
  (on Windows: the MSVC C++ build tools; WebView2 ships with Windows 11 and is
  auto-installed otherwise)

## Develop

```bash
npm install
npm run icons         # generate the app icon set from code (scripts/gen-icon.mjs)
npm run pdfium        # download the PDFium runtime (DLL for bundling + host lib for dev)
npm run tauri:dev     # launch the desktop app with hot reload
```

> `npm run tauri:dev` / `npm run tauri:build` run the icon + PDFium fetch steps
> automatically via `pre*` hooks; the explicit commands above are just for the
> first run. The app icon is defined in code (`scripts/gen-icon.mjs`), so no
> binary assets are committed.

Frontend-only commands (no Rust toolchain needed):

```bash
npm run dev           # Vite dev server (UI only; backend calls are no-ops)
npm run typecheck     # strict TypeScript check
npm test              # mortgage-engine unit tests
npm run build         # production frontend build
```

## Build the Windows installer

```bash
npm ci
npm run icons         # generate the icon set (src-tauri/icons/*)
npm run pdfium win    # ensure src-tauri/lib/pdfium.dll exists for bundling
npm run tauri:build
```

The signed installer is written to
`src-tauri/target/release/bundle/nsis/GoodBoyPdf_<version>_x64-setup.exe`, ready
to host on your website for direct download. `currentUser` install mode means no
admin prompt.

> Building the Windows installer must be done **on Windows** (or a Windows CI
> runner). The included GitHub Actions release workflow does this for you.

### Auto-updater setup (one-time)

```bash
npm run tauri signer generate -- -w ~/.tauri/goodboypdf.key
```

1. Put the printed **public key** in `src-tauri/tauri.conf.json` →
   `plugins.updater.pubkey`.
2. Point `plugins.updater.endpoints` at where you'll host `latest.json`.
3. Provide the **private key** + password to CI as the `TAURI_SIGNING_PRIVATE_KEY`
   and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets. **Never commit the private key.**

## Release via CI

Push a version tag and the [`release`](./.github/workflows/release.yml) workflow
builds, signs, and publishes a draft GitHub release with the installer and update
artifacts:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

## Project layout

```
src/                 React + TypeScript frontend (features/, components/, stores/, hooks/, lib/)
src-tauri/           Rust core (PDFium engine, commands, capabilities, config)
scripts/             PDFium fetch tooling
ARCHITECTURE.md      Architecture & technical plan
```

## License

MIT — see [LICENSE](./LICENSE).
