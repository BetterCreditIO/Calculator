// Generate a 1024x1024 RGBA app icon and encode it as a PNG using only Node's
// built-in zlib. Design: rounded-square indigo→violet gradient tile with a
// white document mark (folded corner + text lines) and a subtle highlight.
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const S = 1024;
const buf = Buffer.alloc(S * S * 4); // RGBA

function set(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  // simple source-over alpha blend onto existing pixel
  const sa = a / 255;
  const da = buf[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa === 0) return;
  buf[i] = Math.round((r * sa + buf[i] * da * (1 - sa)) / oa);
  buf[i + 1] = Math.round((g * sa + buf[i + 1] * da * (1 - sa)) / oa);
  buf[i + 2] = Math.round((b * sa + buf[i + 2] * da * (1 - sa)) / oa);
  buf[i + 3] = Math.round(oa * 255);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// rounded-rect coverage (anti-aliased) at pixel (px,py)
function roundRectCoverage(px, py, x0, y0, x1, y1, radius) {
  // distance to the rounded rectangle; returns 1 inside, 0 outside, AA on edge
  const cx = Math.min(Math.max(px, x0 + radius), x1 - radius);
  const cy = Math.min(Math.max(py, y0 + radius), y1 - radius);
  // inside the straight bands
  if (px >= x0 && px <= x1 && py >= y0 && py <= y1) {
    const dx = px < x0 + radius ? x0 + radius - px : px > x1 - radius ? px - (x1 - radius) : 0;
    const dy = py < y0 + radius ? y0 + radius - py : py > y1 - radius ? py - (y1 - radius) : 0;
    if (dx === 0 || dy === 0) return 1;
    const d = Math.hypot(px - cx, py - cy);
    return Math.max(0, Math.min(1, radius - d + 0.5));
  }
  return 0;
}

// Background gradient tile
const margin = 96;
const tileR = 200;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const cov = roundRectCoverage(x, y, margin, margin, S - margin, S - margin, tileR);
    if (cov <= 0) continue;
    const t = (x + y) / (2 * S); // diagonal gradient
    const r = lerp(0x4f, 0x7c, t); // 4f46e5 indigo-600 -> 7c3aed violet-600
    const g = lerp(0x46, 0x3a, t);
    const b = lerp(0xe5, 0xed, t);
    set(x, y, Math.round(r), Math.round(g), Math.round(b), Math.round(255 * cov));
  }
}

// Soft top highlight
for (let y = margin; y < S / 2; y++) {
  for (let x = margin; x < S - margin; x++) {
    const cov = roundRectCoverage(x, y, margin, margin, S - margin, S - margin, tileR);
    if (cov <= 0) continue;
    const a = (1 - (y - margin) / (S / 2 - margin)) * 26;
    set(x, y, 255, 255, 255, Math.round(a * cov));
  }
}

// White document mark
const dx0 = 348,
  dy0 = 300,
  dx1 = 676,
  dy1 = 724,
  docR = 28,
  fold = 86;
for (let y = dy0; y <= dy1; y++) {
  for (let x = dx0; x <= dx1; x++) {
    // cut the folded top-right corner (triangle)
    if (x > dx1 - fold && y < dy0 + fold && x - (dx1 - fold) > dy0 + fold - y) continue;
    const cov = roundRectCoverage(x, y, dx0, dy0, dx1, dy1, docR);
    if (cov <= 0) continue;
    set(x, y, 255, 255, 255, Math.round(255 * cov));
  }
}
// Fold shadow triangle
for (let y = dy0; y < dy0 + fold; y++) {
  for (let x = dx1 - fold; x <= dx1; x++) {
    if (x - (dx1 - fold) <= dy0 + fold - y) continue; // only the folded flap area
    const within = x <= dx1 && y >= dy0;
    if (within) set(x, y, 0xc7, 0xd2, 0xfe, 200); // indigo-200 flap
  }
}

// Text lines on the document (indigo)
const lineColor = [0x6366, 0xf1]; // unused split, keep simple
function drawLine(yc, x0, x1, h) {
  for (let y = yc - h / 2; y <= yc + h / 2; y++) {
    for (let x = x0; x <= x1; x++) {
      const cov = roundRectCoverage(x, y, x0, yc - h / 2, x1, yc + h / 2, h / 2);
      if (cov <= 0) continue;
      set(x, y, 0x63, 0x66, 0xf1, Math.round(255 * cov));
    }
  }
}
drawLine(440, 400, 624, 26);
drawLine(508, 400, 600, 26);
drawLine(576, 400, 624, 26);
// accent "checkmark" style underline in violet
drawLine(644, 400, 540, 26);

// ---- PNG encode ----
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
// add filter byte (0) per scanline
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);
const out = process.argv[2] || "app-icon.png";
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log("wrote", out, png.length, "bytes");
