import { describe, it, expect } from "vitest";
import { matchFontStyle, cssFont, horizontalScale } from "./text-metrics";

describe("matchFontStyle", () => {
  it("classifies subsetted Times variants as serif with correct flags", () => {
    const s = matchFontStyle("ABCDEF+TimesNewRomanPS-BoldMT", false, false);
    expect(s.family).toMatch(/Times/);
    expect(s.bold).toBe(true);
    expect(s.italic).toBe(false);
  });

  it("classifies Courier/mono names as monospace", () => {
    expect(matchFontStyle("CourierNewPSMT", false, false).family).toMatch(
      /Courier|monospace/,
    );
    expect(matchFontStyle("DejaVuSansMono", false, false).family).toMatch(
      /monospace/,
    );
  });

  it("classifies unknown and sans names as the sans stack", () => {
    expect(matchFontStyle("Arial-ItalicMT", false, false)).toMatchObject({
      italic: true,
      bold: false,
    });
    expect(matchFontStyle("Helvetica", false, false).family).toMatch(
      /sans-serif/,
    );
    expect(matchFontStyle(null, false, false).family).toMatch(/sans-serif/);
  });

  it("detects oblique/semibold from the name and honors hints", () => {
    const s = matchFontStyle("SomeFont-SemiboldOblique", false, false);
    expect(s.bold).toBe(true);
    expect(s.italic).toBe(true);
    const hinted = matchFontStyle("Mystery", true, true);
    expect(hinted.bold).toBe(true);
    expect(hinted.italic).toBe(true);
  });

  it("does not misclassify 'sans-serif' names as serif", () => {
    expect(matchFontStyle("PT Sans-Serif Pro", false, false).family).toMatch(
      /sans-serif/,
    );
  });

  it("classifies gothic faces as sans and schoolbook faces as serif", () => {
    expect(matchFontStyle("CenturyGothic", false, false).family).toMatch(
      /sans-serif/,
    );
    expect(matchFontStyle("CenturySchoolbook", false, false).family).toMatch(
      /Times|Georgia/,
    );
    expect(matchFontStyle("BookmanOldStyle", false, false).family).toMatch(
      /Times|Georgia/,
    );
  });
});

describe("cssFont", () => {
  it("builds a valid shorthand with style and weight", () => {
    const s = matchFontStyle("Times-BoldItalic", false, false);
    expect(cssFont(s, 16)).toBe(`italic 700 16px ${s.family}`);
  });
});

describe("horizontalScale", () => {
  it("returns 1 for empty text or non-positive width", () => {
    expect(horizontalScale("", "16px sans-serif", 100)).toBe(1);
    expect(horizontalScale("hello", "16px sans-serif", 0)).toBe(1);
  });

  it("never returns a degenerate scale (clamped or fallback)", () => {
    // In jsdom the canvas context is unavailable, so this exercises the
    // graceful fallback path; in a real browser it exercises the clamp.
    const scale = horizontalScale("hello world", "16px sans-serif", 120);
    expect(scale).toBeGreaterThanOrEqual(0.25);
    expect(scale).toBeLessThanOrEqual(4);
  });
});
