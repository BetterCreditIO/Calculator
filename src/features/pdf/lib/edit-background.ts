/**
 * Background matching for text edits.
 *
 * When an edit can't be applied in place, the save path covers the original
 * glyphs with a filled rectangle before re-stamping (see engine.rs Tier 2).
 * A hardcoded white cover looks wrong on colored paper, shaded table cells,
 * and scans — so the editor SAMPLES the true background from the page raster:
 * it reads the ring of pixels immediately AROUND the text run (never the
 * glyphs themselves) and takes the per-channel median, which is robust to a
 * few stray anti-aliased or line pixels. The user can override the sample
 * with an explicit color, the OS-level eyedropper, or no fill at all.
 */
import type { Rect } from "@/types/pdf";

/** How far (in PDF points) outside the text box the sampling ring extends. */
const RING_PAD_PTS = 3;

/** Per-channel median of a set of RGB samples, as #rrggbb. */
export function medianColor(samples: Array<[number, number, number]>): string {
  if (samples.length === 0) return "#ffffff";
  const channel = (i: 0 | 1 | 2) => {
    const values = samples.map((s) => s[i]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)]!;
  };
  return rgbToHex(channel(0), channel(1), channel(2));
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/**
 * Sample the page background around `rect` (display point space) from the
 * page's rendered raster. Returns null when the raster isn't available or
 * can't be read — callers fall back to white.
 */
export async function sampleBackground(
  rasterUrl: string | null,
  pageWidthPts: number,
  rect: Rect,
): Promise<string | null> {
  if (!rasterUrl || pageWidthPts <= 0) return null;
  try {
    const img = await loadImage(rasterUrl);
    // Raster pixels per PDF point.
    const scale = img.naturalWidth / pageWidthPts;
    const pad = Math.max(2, RING_PAD_PTS * scale);

    // Outer region (clamped to the raster) and the inner glyph box, in
    // raster pixels.
    const ox = Math.max(0, Math.floor(rect.x * scale - pad));
    const oy = Math.max(0, Math.floor(rect.y * scale - pad));
    const ox2 = Math.min(img.naturalWidth, Math.ceil((rect.x + rect.width) * scale + pad));
    const oy2 = Math.min(img.naturalHeight, Math.ceil((rect.y + rect.height) * scale + pad));
    const w = ox2 - ox;
    const h = oy2 - oy;
    if (w < 2 || h < 2) return null;

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, ox, oy, w, h, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;

    // Inner (glyph) box in the region's local coordinates.
    const ix = rect.x * scale - ox;
    const iy = rect.y * scale - oy;
    const ix2 = (rect.x + rect.width) * scale - ox;
    const iy2 = (rect.y + rect.height) * scale - oy;

    const samples: Array<[number, number, number]> = [];
    // Subsample the ring on a small grid — a handful of hundred pixels is
    // plenty for a median and keeps this O(1)-ish at any zoom.
    const step = Math.max(1, Math.floor(Math.min(w, h) / 48));
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const inGlyphBox = x >= ix && x < ix2 && y >= iy && y < iy2;
        if (inGlyphBox) continue;
        const o = (y * w + x) * 4;
        if (data[o + 3]! < 200) continue; // skip transparent padding
        samples.push([data[o]!, data[o + 1]!, data[o + 2]!]);
      }
    }
    // A run spanning the full page width can leave no ring; fall back to the
    // whole region (glyph pixels included — the median still favors paper).
    if (samples.length < 16) {
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const o = (y * w + x) * 4;
          if (data[o + 3]! < 200) continue;
          samples.push([data[o]!, data[o + 1]!, data[o + 2]!]);
        }
      }
    }
    if (samples.length === 0) return null;
    return medianColor(samples);
  } catch {
    return null;
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("raster image failed to load"));
    img.src = url;
  });
}

/**
 * Minimal typing for the Chromium EyeDropper API (present in WebView2 /
 * Chrome ≥95; feature-detected at the call site).
 */
export interface EyeDropperApi {
  open(): Promise<{ sRGBHex: string }>;
}

export function getEyeDropper(): (new () => EyeDropperApi) | null {
  const ctor = (window as { EyeDropper?: new () => EyeDropperApi }).EyeDropper;
  return ctor ?? null;
}
