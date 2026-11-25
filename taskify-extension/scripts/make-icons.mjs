/**
 * The extension's icons.
 *
 * The mark is Taskify's own: a green rounded square on the app's deep teal, with a white tick
 * for the task it manages. They are written as PNGs at the four sizes Chrome asks for.
 *
 * PNGs are written by hand (a minimal encoder) so the build needs no image library.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = new URL("../public/icons/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const BG = [0x0b, 0x2c, 0x36, 0xff]; // the app's deep teal
const MARK = [0x22, 0xc5, 0x5e, 0xff]; // the app's green
const TICK = [0xff, 0xff, 0xff, 0xff];

/** CRC32, for the PNG chunks. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  // Each scanline is prefixed with a filter byte (0 = none).
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Coverage of a pixel by a rounded square, sampled on a 4x4 grid for smooth edges. */
function roundedSquareCoverage(x, y, size, radius) {
  const samples = 4;
  let hits = 0;
  for (let sy = 0; sy < samples; sy += 1) {
    for (let sx = 0; sx < samples; sx += 1) {
      const px = x + (sx + 0.5) / samples;
      const py = y + (sy + 0.5) / samples;
      const cx = Math.min(Math.max(px, radius), size - radius);
      const cy = Math.min(Math.max(py, radius), size - radius);
      const dx = px - cx;
      const dy = py - cy;
      if (dx * dx + dy * dy <= radius * radius) hits += 1;
    }
  }
  return hits / (samples * samples);
}

/** Coverage of a pixel by a line segment, sampled. */
function segmentCoverage(x, y, ax, ay, bx, by, width) {
  const samples = 4;
  let hits = 0;
  for (let sy = 0; sy < samples; sy += 1) {
    for (let sx = 0; sx < samples; sx += 1) {
      const px = x + (sx + 0.5) / samples;
      const py = y + (sy + 0.5) / samples;
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSquared = dx * dx + dy * dy;
      let t = lengthSquared === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
      t = Math.max(0, Math.min(1, t));
      const cx = ax + t * dx;
      const cy = ay + t * dy;
      const dist = Math.hypot(px - cx, py - cy);
      if (dist <= width / 2) hits += 1;
    }
  }
  return hits / (samples * samples);
}

function blend(target, offset, color, alpha) {
  if (alpha <= 0) return;
  const inv = 1 - alpha;
  target[offset] = Math.round(color[0] * alpha + target[offset] * inv);
  target[offset + 1] = Math.round(color[1] * alpha + target[offset + 1] * inv);
  target[offset + 2] = Math.round(color[2] * alpha + target[offset + 2] * inv);
  target[offset + 3] = Math.round(255 * alpha + target[offset + 3] * inv);
}

function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const unit = size / 128;

  // The background: a rounded square in the app's teal.
  const bgRadius = 26 * unit;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const coverage = roundedSquareCoverage(x, y, size, bgRadius);
      const offset = (y * size + x) * 4;
      blend(pixels, offset, BG, coverage);
    }
  }

  // The mark: a green rounded square, a little smaller.
  const markSize = 76 * unit;
  const markLeft = (size - markSize) / 2;
  const markTop = (size - markSize) / 2;
  const markRadius = 18 * unit;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (x < markLeft || y < markTop || x >= markLeft + markSize || y >= markTop + markSize) continue;
      const coverage =
        roundedSquareCoverage(x - markLeft, y - markTop, markSize, markRadius);
      const offset = (y * size + x) * 4;
      blend(pixels, offset, MARK, coverage);
    }
  }

  // The tick: a check mark in white.
  const stroke = 11 * unit;
  const ax = markLeft + 22 * unit;
  const ay = markTop + 40 * unit;
  const bx = markLeft + 33 * unit;
  const by = markTop + 52 * unit;
  const cx = markLeft + 56 * unit;
  const cy = markTop + 27 * unit;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const coverage = Math.max(
        segmentCoverage(x, y, ax, ay, bx, by, stroke),
        segmentCoverage(x, y, bx, by, cx, cy, stroke),
      );
      if (coverage <= 0) continue;
      const offset = (y * size + x) * 4;
      blend(pixels, offset, TICK, coverage);
    }
  }

  return encodePng(size, size, pixels);
}

for (const size of [16, 32, 48, 128]) {
  const png = renderIcon(size);
  writeFileSync(join(OUT, `icon-${size}.png`), png);
  console.log(`icon-${size}.png (${png.length} bytes)`);
}
