/**
 * Font matching + glyph-metric calibration for the PDF text overlay.
 *
 * THE FIDELITY PROBLEM
 * --------------------
 * The overlay renders each extracted text run as a DOM element placed over the
 * raster. The raster's glyphs come from the PDF's own (often embedded, often
 * subsetted) fonts; the DOM cannot use those fonts directly. If the overlay
 * font's advance widths differ from the PDF font's, selection highlights and
 * caret positions drift away from the painted glyphs as a line gets longer.
 *
 * THE FIX (same approach PDF.js uses for its text layer)
 * ------------------------------------------------------
 * 1. Map the PDF font name to the closest local family *class* (serif / sans /
 *    mono, with bold/italic variants) so metrics start close.
 * 2. Measure the run's natural width with the chosen CSS font via an offscreen
 *    canvas (`measureText` — synchronous, no layout thrash).
 * 3. Apply `transform: scaleX(target / natural)` so the DOM run's total advance
 *    EXACTLY matches the painted run's width. Per-glyph positions then align to
 *    within a fraction of a glyph across the whole run.
 */

export interface FontStyle {
  /** CSS font-family stack matched from the PDF font name. */
  family: string;
  bold: boolean;
  italic: boolean;
}

const SERIF_STACK =
  'Georgia, "Times New Roman", Times, serif';
const SANS_STACK =
  '"Segoe UI", Arial, Helvetica, sans-serif';
const MONO_STACK =
  '"Consolas", "Courier New", Courier, monospace';

/**
 * Classify a PDF font name (e.g. "ABCDEF+TimesNewRomanPS-BoldMT") into a local
 * family stack plus bold/italic flags. Subset prefixes ("ABCDEF+") and foundry
 * suffixes are handled by substring matching on the lowercased name.
 */
export function matchFontStyle(
  fontName: string | null,
  boldHint: boolean,
  italicHint: boolean,
): FontStyle {
  const name = (fontName ?? "").toLowerCase();

  // "Century Gothic" and similar are sans faces despite the keyword hit; the
  // exclusion list mirrors the backend's classify_font_name so the on-screen
  // preview and the saved output always agree.
  const serif =
    /times|georgia|garamond|book|palatino|cambria|century|minion|caslon|baskerville|serif/.test(
      name,
    ) &&
    !/sans/.test(name) &&
    !/gothic/.test(name);
  const mono = /courier|consol|mono|menlo|typewriter/.test(name);

  const bold = boldHint || /bold|black|heavy|semibold|demibold/.test(name);
  const italic = italicHint || /italic|oblique/.test(name);

  return {
    family: mono ? MONO_STACK : serif ? SERIF_STACK : SANS_STACK,
    bold,
    italic,
  };
}

/** Build the canvas/CSS font shorthand for a style at a given pixel size. */
export function cssFont(style: FontStyle, sizePx: number): string {
  const italic = style.italic ? "italic " : "";
  const weight = style.bold ? "700 " : "400 ";
  return `${italic}${weight}${sizePx}px ${style.family}`;
}

// One shared offscreen canvas context for all measurements.
let measureCtx: CanvasRenderingContext2D | null = null;

function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (!measureCtx) {
    try {
      measureCtx = document.createElement("canvas").getContext("2d");
    } catch {
      measureCtx = null;
    }
  }
  return measureCtx;
}

/**
 * Compute the horizontal scale factor that stretches `text`, rendered with
 * `font`, to exactly `targetWidthPx`. Returns 1 when measurement is
 * unavailable or the result would be degenerate.
 */
export function horizontalScale(
  text: string,
  font: string,
  targetWidthPx: number,
): number {
  if (!text || targetWidthPx <= 0) return 1;
  const ctx = getMeasureCtx();
  if (!ctx) return 1;
  ctx.font = font;
  const natural = ctx.measureText(text).width;
  if (!Number.isFinite(natural) || natural <= 0) return 1;
  const scale = targetWidthPx / natural;
  // Clamp: outside this range the match is wrong anyway (e.g. exotic script);
  // an extreme squeeze would hurt selection more than a small drift.
  return Math.min(4, Math.max(0.25, scale));
}
