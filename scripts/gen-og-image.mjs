// Generates public/og-image.png (1200x630) with zero dependencies:
// node:zlib deflateRawSync + hand-rolled PNG chunks over a raw RGBA buffer.
// No text — font rendering is off-limits without deps (ponytail: if we ever
// want brand text in the preview, generate the PNG at deploy time instead).
// Output is byte-stable: PNG carries no timestamps and deflate is
// deterministic, so re-running reproduces the same file.
import { deflateRawSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const W = 1200;
const H = 630;
const BG = [10, 10, 11]; // #0a0a0b, matches theme-color

// Opaque RGBA pixel buffer, pre-filled with the background colour.
const px = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    px[i] = BG[0];
    px[i + 1] = BG[1];
    px[i + 2] = BG[2];
    px[i + 3] = 255;
  }
}

// Alpha-blend an opaque RGB colour onto one pixel.
// ponytail: 8-bit integer blend, no anti-aliasing — the art is straight
// lines and squares, so sub-pixel edges don't matter.
function blend(x, y, [r, g, b], a) {
  const i = (y * W + x) * 4;
  const inv = 255 - a;
  px[i] = (r * a + px[i] * inv) / 255;
  px[i + 1] = (g * a + px[i + 1] * inv) / 255;
  px[i + 2] = (b * a + px[i + 2] * inv) / 255;
}

function line(axis, pos, color, alpha) {
  for (let t = 0; t < (axis === "v" ? H : W); t++)
    blend(axis === "v" ? pos : t, axis === "v" ? t : pos, color, alpha);
}

// Subtle race-grid motif: thin white lines, verticals a touch stronger
// than horizontals, evoking a timing-sheet lattice.
const GRID = 48;
for (let x = 0; x <= W; x += GRID) line("v", x, [255, 255, 255], 16);
for (let y = 0; y <= H; y += GRID) line("h", y, [255, 255, 255], 9);

// Small F1 checkered strip in the bottom-right corner: 2 rows x 12 cols
// of 32px squares, flush with both edges.
const S = 32;
const Cols = 12;
const ROWS = 2;
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < Cols; c++) {
    if ((r + c) % 2 !== 0) continue; // dark squares stay the background
    for (let y = H - (r + 1) * S; y < H - r * S; y++) {
      for (let x = W - (c + 1) * S; x < W - c * S; x++)
        blend(x, y, [232, 232, 236], 255);
    }
  }
}

// --- PNG encoding ------------------------------------------------------

function crc32(buf) {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(
    crc32(Buffer.concat([Buffer.from(type, "ascii"), data])),
    8 + data.length
  );
  return out;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
// compression/filter/interlace are already 0

// Each scanline is prefixed with filter byte 0 (None); the raw stream is
// zlib-deflated raw (no wrapper — PNG demands raw deflate).
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  const row = y * (1 + W * 4);
  raw[row] = 0;
  px.subarray(y * W * 4, (y + 1) * W * 4).copy(raw, row + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateRawSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const outPath = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "og-image.png");
writeFileSync(outPath, png);
console.log(`wrote ${outPath} (${png.length} bytes, ${W}x${H} RGBA)`);
