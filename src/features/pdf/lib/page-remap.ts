/**
 * Pure helpers that keep in-memory annotations and pending text edits
 * consistent when the document's page structure changes (rotate / delete /
 * move / insert). The math lives here — outside the store — so it is unit
 * testable in isolation.
 */
import type { Annotation, Rect, TextEdit } from "@/types/pdf";

/** Descriptor of a structural change, in frontend terms. */
export type PageRemap =
  | { kind: "delete"; pageIndex: number }
  | { kind: "move"; from: number; to: number }
  | { kind: "insert"; afterIndex: number }
  | {
      kind: "rotate";
      pageIndex: number;
      clockwise: boolean;
      /** Display dimensions (points) of the page BEFORE the rotation. */
      displayWidth: number;
      displayHeight: number;
    };

/** Map an old page index to its new index, or null if the page was removed. */
export function remapPageIndex(index: number, remap: PageRemap): number | null {
  switch (remap.kind) {
    case "delete":
      if (index === remap.pageIndex) return null;
      return index > remap.pageIndex ? index - 1 : index;
    case "insert":
      return index > remap.afterIndex ? index + 1 : index;
    case "move": {
      const { from, to } = remap;
      if (index === from) return to;
      // Removing `from` shifts later pages down; inserting at `to` shifts
      // pages at/after `to` up.
      let next = index > from ? index - 1 : index;
      if (next >= to) next += 1;
      return next;
    }
    case "rotate":
      return index;
  }
}

/**
 * Rotate a display-space rect by 90° with the page. `oldWidth`/`oldHeight`
 * are the page's display dimensions BEFORE the rotation (the space `r` lives
 * in); the returned rect is in the rotated display space (dimensions swapped).
 */
export function rotateRect(
  r: Rect,
  clockwise: boolean,
  oldWidth: number,
  oldHeight: number,
): Rect {
  return clockwise
    ? {
        x: oldHeight - (r.y + r.height),
        y: r.x,
        width: r.height,
        height: r.width,
      }
    : {
        x: r.y,
        y: oldWidth - (r.x + r.width),
        width: r.height,
        height: r.width,
      };
}

/** Remap a full annotation list for a structural change. */
export function remapAnnotations(
  annotations: Annotation[],
  remap: PageRemap,
): Annotation[] {
  const out: Annotation[] = [];
  for (const a of annotations) {
    const nextIndex = remapPageIndex(a.pageIndex, remap);
    if (nextIndex == null) continue; // page deleted → drop its markup
    if (remap.kind === "rotate" && a.pageIndex === remap.pageIndex) {
      out.push({
        ...a,
        pageIndex: nextIndex,
        rects: a.rects.map((r) =>
          rotateRect(r, remap.clockwise, remap.displayWidth, remap.displayHeight),
        ),
      });
    } else {
      out.push({ ...a, pageIndex: nextIndex });
    }
  }
  return out;
}

/**
 * Remap pending text edits. Edits on a ROTATED page are dropped by the caller
 * before rotation is allowed (a scalar baseline cannot survive a 90° turn),
 * so this only shifts page indices and drops deleted pages' edits.
 */
export function remapEdits(edits: TextEdit[], remap: PageRemap): TextEdit[] {
  const out: TextEdit[] = [];
  for (const e of edits) {
    const nextIndex = remapPageIndex(e.pageIndex, remap);
    if (nextIndex == null) continue;
    out.push(e.pageIndex === nextIndex ? e : { ...e, pageIndex: nextIndex });
  }
  return out;
}
