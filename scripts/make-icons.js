// Generates extension/icons/njia-icon-{16,32,48,128}.png with zero dependencies.
// Design: terracotta rounded square, ivory winding path ("njia" = the way), ink destination dot.
// Run: node scripts/make-icons.js
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// ---- minimal PNG encoder (RGBA, 8-bit) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- palette (ink / terracotta, per HANDOFF branding) ----
const TERRA_TOP = [0xd3, 0x65, 0x3c];
const TERRA_BOT = [0xb8, 0x4a, 0x26];
const IVORY = [0xfb, 0xf3, 0xe7];
const INK = [0x1b, 0x1b, 0x2f];

// ---- draw at 4x supersample, then box-downsample (premultiplied) ----
function renderIcon(size) {
  const S = size * 4;
  const buf = Buffer.alloc(S * S * 4); // transparent
  const r = 0.22 * S; // corner radius
  const y0 = 0.2 * S, y1 = 0.84 * S; // path vertical extent
  const cx = 0.5 * S, amp = 0.17 * S, w = 0.13 * S;
  const pathX = (y) => cx + amp * Math.sin(((y - y0) / (y1 - y0)) * 1.5 * Math.PI);
  const dot = { x: pathX(y0), y: y0, r: 0.1 * S };

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // rounded-rect coverage
      const dx = Math.max(r - x, x - (S - 1 - r), 0);
      const dy = Math.max(r - y, y - (S - 1 - r), 0);
      if (dx * dx + dy * dy > r * r) continue;
      // background: vertical gradient
      const t = y / S;
      let px = [
        TERRA_TOP[0] + (TERRA_BOT[0] - TERRA_TOP[0]) * t,
        TERRA_TOP[1] + (TERRA_BOT[1] - TERRA_TOP[1]) * t,
        TERRA_TOP[2] + (TERRA_BOT[2] - TERRA_TOP[2]) * t,
      ];
      // winding path
      if (y >= y0 && y <= y1 && Math.abs(x - pathX(y)) < w / 2) px = IVORY;
      // destination dot (ink, ivory ring)
      const ddx = x - dot.x, ddy = y - dot.y;
      const dd = Math.sqrt(ddx * ddx + ddy * ddy);
      if (dd < dot.r * 1.45 && dd >= dot.r) px = IVORY;
      else if (dd < dot.r) px = INK;
      const i = (y * S + x) * 4;
      buf[i] = px[0];
      buf[i + 1] = px[1];
      buf[i + 2] = px[2];
      buf[i + 3] = 255;
    }
  }

  // downsample 4x4 (premultiplied average to avoid dark fringes)
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rs = 0, gs = 0, bs = 0, as = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const i = ((y * 4 + sy) * S + (x * 4 + sx)) * 4;
          const a = buf[i + 3] / 255;
          rs += buf[i] * a;
          gs += buf[i + 1] * a;
          bs += buf[i + 2] * a;
          as += a;
        }
      }
      const o = (y * size + x) * 4;
      if (as > 0) {
        out[o] = Math.round(rs / as);
        out[o + 1] = Math.round(gs / as);
        out[o + 2] = Math.round(bs / as);
      }
      out[o + 3] = Math.round((as / 16) * 255);
    }
  }
  return encodePng(size, size, out);
}

const outDir = path.join(__dirname, "..", "extension", "icons");
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `njia-icon-${size}.png`);
  fs.writeFileSync(file, renderIcon(size));
  console.log(`wrote ${file}`);
}
