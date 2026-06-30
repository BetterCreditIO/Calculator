#!/usr/bin/env node
/**
 * Download the PDFium runtime library from bblanchon/pdfium-binaries.
 *
 *   node scripts/fetch-pdfium.mjs            # Windows DLL (for bundling) + host lib (for dev)
 *   node scripts/fetch-pdfium.mjs win        # Windows pdfium.dll only
 *   node scripts/fetch-pdfium.mjs host       # current platform only
 *
 * pdfium-render binds to this library at RUNTIME, so the crate compiles without
 * it — but the app needs it present to render. For Windows release builds the
 * DLL must live at `src-tauri/lib/pdfium.dll` (bundled as a resource via
 * tauri.conf.json). For local `tauri dev` the host library is placed next to the
 * dev binary's search paths.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const LIB_DIR = path.join(ROOT, "src-tauri", "lib");
const SRC_TAURI = path.join(ROOT, "src-tauri");
const BASE =
  "https://github.com/bblanchon/pdfium-binaries/releases/latest/download";

/** Map a logical target → release asset, member inside the archive, and dest(s). */
function targetSpec(target) {
  switch (target) {
    case "win":
      return {
        asset: "pdfium-win-x64.tgz",
        member: "bin/pdfium.dll",
        // Bundling resource location (see tauri.conf.json bundle.resources).
        dests: [path.join(LIB_DIR, "pdfium.dll")],
      };
    case "linux":
      return {
        asset: "pdfium-linux-x64.tgz",
        member: "lib/libpdfium.so",
        dests: [path.join(SRC_TAURI, "libpdfium.so")],
      };
    case "mac": {
      const arm = process.arch === "arm64";
      return {
        asset: arm ? "pdfium-mac-arm64.tgz" : "pdfium-mac-x64.tgz",
        member: "lib/libpdfium.dylib",
        dests: [path.join(SRC_TAURI, "libpdfium.dylib")],
      };
    }
    default:
      throw new Error(`Unknown target: ${target}`);
  }
}

function hostTarget() {
  if (process.platform === "win32") return "win";
  if (process.platform === "darwin") return "mac";
  return "linux";
}

async function download(url, dest) {
  process.stdout.write(`  ↓ ${url}\n`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { writeFileSync } = await import("node:fs");
  writeFileSync(dest, buf);
}

async function fetchTarget(target) {
  const spec = targetSpec(target);
  const work = mkdtempSync(path.join(tmpdir(), "pdfium-"));
  const archive = path.join(work, spec.asset);
  await download(`${BASE}/${spec.asset}`, archive);

  // Extract just the member we need (tar ships with Windows 10+, macOS, Linux).
  execFileSync("tar", ["-xzf", archive, "-C", work, spec.member], {
    stdio: "inherit",
  });
  const extracted = path.join(work, spec.member);
  if (!existsSync(extracted)) {
    throw new Error(`Member ${spec.member} not found in ${spec.asset}`);
  }
  for (const dest of spec.dests) {
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(extracted, dest);
    process.stdout.write(`  ✓ ${path.relative(ROOT, dest)}\n`);
  }
}

async function main() {
  const arg = process.argv[2];
  let targets;
  if (arg === "win") targets = ["win"];
  else if (arg === "host") targets = [hostTarget()];
  else {
    // Default: ensure the Windows DLL for bundling AND the host lib for dev.
    targets = Array.from(new Set(["win", hostTarget()]));
  }

  mkdirSync(LIB_DIR, { recursive: true });
  for (const t of targets) {
    process.stdout.write(`Fetching PDFium (${t})…\n`);
    await fetchTarget(t);
  }
  process.stdout.write("Done.\n");
}

main().catch((err) => {
  console.error(`\nfetch-pdfium failed: ${err.message}`);
  process.exit(1);
});
