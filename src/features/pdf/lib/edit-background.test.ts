import { describe, it, expect } from "vitest";
import { medianColor, rgbToHex } from "./edit-background";

describe("rgbToHex", () => {
  it("formats and clamps channels", () => {
    expect(rgbToHex(255, 255, 255)).toBe("#ffffff");
    expect(rgbToHex(0, 0, 0)).toBe("#000000");
    expect(rgbToHex(300, -5, 15.6)).toBe("#ff0010");
  });
});

describe("medianColor", () => {
  it("returns white for no samples", () => {
    expect(medianColor([])).toBe("#ffffff");
  });

  it("returns the sample itself for a single color", () => {
    expect(medianColor([[250, 244, 230]])).toBe("#faf4e6");
  });

  it("ignores a minority of glyph-colored pixels", () => {
    // Cream paper with a few black anti-aliased strays — the median must
    // land on the paper, which is the whole point of sampling a ring.
    const paper: [number, number, number] = [250, 244, 230];
    const ink: [number, number, number] = [20, 20, 20];
    const samples = [
      ...Array.from({ length: 20 }, () => paper),
      ...Array.from({ length: 6 }, () => ink),
    ];
    expect(medianColor(samples)).toBe("#faf4e6");
  });

  it("takes per-channel medians independently", () => {
    const samples: Array<[number, number, number]> = [
      [10, 200, 30],
      [20, 210, 10],
      [30, 190, 20],
    ];
    expect(medianColor(samples)).toBe(rgbToHex(20, 200, 20));
  });
});
