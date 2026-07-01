import { describe, it, expect } from "vitest";
import {
  remapPageIndex,
  rotateRect,
  remapAnnotations,
  remapEdits,
  type PageRemap,
} from "./page-remap";
import type { Annotation, TextEdit } from "@/types/pdf";

describe("remapPageIndex", () => {
  it("shifts indices down after a delete and drops the deleted page", () => {
    const remap: PageRemap = { kind: "delete", pageIndex: 2 };
    expect(remapPageIndex(1, remap)).toBe(1);
    expect(remapPageIndex(2, remap)).toBeNull();
    expect(remapPageIndex(3, remap)).toBe(2);
  });

  it("shifts indices up after an insert", () => {
    const remap: PageRemap = { kind: "insert", afterIndex: 1 };
    expect(remapPageIndex(0, remap)).toBe(0);
    expect(remapPageIndex(1, remap)).toBe(1);
    expect(remapPageIndex(2, remap)).toBe(3);
  });

  it("permutes indices for a move exactly like the page list", () => {
    // Pages [0,1,2,3], move 0 → 2 gives order [1,2,0,3].
    const remap: PageRemap = { kind: "move", from: 0, to: 2 };
    expect(remapPageIndex(0, remap)).toBe(2); // moved page
    expect(remapPageIndex(1, remap)).toBe(0);
    expect(remapPageIndex(2, remap)).toBe(1);
    expect(remapPageIndex(3, remap)).toBe(3);

    // Move 3 → 0 gives order [3,0,1,2].
    const back: PageRemap = { kind: "move", from: 3, to: 0 };
    expect(remapPageIndex(3, back)).toBe(0);
    expect(remapPageIndex(0, back)).toBe(1);
    expect(remapPageIndex(2, back)).toBe(3);
  });
});

describe("rotateRect", () => {
  // A 100x50 rect at (10, 20) on a 612x792 page.
  const r = { x: 10, y: 20, width: 100, height: 50 };

  it("rotates clockwise into the swapped display space", () => {
    const out = rotateRect(r, true, 612, 792);
    expect(out).toEqual({ x: 792 - 70, y: 10, width: 50, height: 100 });
  });

  it("rotates counter-clockwise into the swapped display space", () => {
    const out = rotateRect(r, false, 612, 792);
    expect(out).toEqual({ x: 20, y: 612 - 110, width: 50, height: 100 });
  });

  it("clockwise then counter-clockwise round-trips", () => {
    const once = rotateRect(r, true, 612, 792);
    // After a CW rotation the display space is 792x612.
    const back = rotateRect(once, false, 792, 612);
    expect(back).toEqual(r);
  });
});

function anno(pageIndex: number): Annotation {
  return {
    id: `a${pageIndex}`,
    type: "highlight",
    pageIndex,
    rects: [{ x: 10, y: 20, width: 100, height: 50 }],
    color: "#fde047",
    opacity: 0.4,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function edit(pageIndex: number): TextEdit {
  return {
    id: `e${pageIndex}`,
    pageIndex,
    spanIndex: 0,
    originalBounds: { x: 0, y: 0, width: 10, height: 10 },
    originalText: "a",
    newText: "b",
    fontSize: 12,
    fontName: null,
    bold: false,
    italic: false,
    color: "#000000",
    baseline: 8,
  };
}

describe("remapAnnotations / remapEdits", () => {
  it("drops items on a deleted page and shifts the rest", () => {
    const annotations = [anno(0), anno(1), anno(2)];
    const out = remapAnnotations(annotations, { kind: "delete", pageIndex: 1 });
    expect(out.map((a) => a.pageIndex)).toEqual([0, 1]);
    expect(out[1]!.id).toBe("a2");

    const edits = [edit(0), edit(1), edit(2)];
    const eo = remapEdits(edits, { kind: "delete", pageIndex: 1 });
    expect(eo.map((e) => e.pageIndex)).toEqual([0, 1]);
  });

  it("rotates rects only on the rotated page", () => {
    const annotations = [anno(0), anno(1)];
    const out = remapAnnotations(annotations, {
      kind: "rotate",
      pageIndex: 1,
      clockwise: true,
      displayWidth: 612,
      displayHeight: 792,
    });
    expect(out[0]!.rects[0]).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(out[1]!.rects[0]).toEqual({
      x: 792 - 70,
      y: 10,
      width: 50,
      height: 100,
    });
  });
});
