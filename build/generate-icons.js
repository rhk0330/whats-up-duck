'use strict';
// Generates all icon assets with zero dependencies:
//   build/icon.png            512px app icon (electron-builder converts to .ico/.icns)
//   build/tray.png            32px Windows tray icon
//   build/trayTemplate.png    16px macOS template (black + alpha)
//   build/trayTemplate@2x.png 32px macOS template
// Run: node build/generate-icons.js

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// ---- minimal PNG encoder ----

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
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(rgba, w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- duck rendering ----

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const OUTLINE = hex('#4a3b2a');
const BODY = hex('#ffd93b');
const BELLY = hex('#ffe787');
const BILL = hex('#ff9f1c');
const BILL_OUTLINE = hex('#b96a00');
const EYE = hex('#2b2b2b');
const WHITE = [255, 255, 255];

const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

// Draw order matters: later entries paint over earlier ones.
const DUCK_SHAPES = [
  { test: (x, y) => inEllipse(x, y, 0.5, 0.66, 0.315, 0.265), color: OUTLINE },
  { test: (x, y) => inEllipse(x, y, 0.5, 0.66, 0.29, 0.24), color: BODY },
  { test: (x, y) => inEllipse(x, y, 0.5, 0.73, 0.17, 0.13), color: BELLY },
  { test: (x, y) => inEllipse(x, y, 0.5, 0.36, 0.265, 0.265), color: OUTLINE },
  { test: (x, y) => inEllipse(x, y, 0.5, 0.36, 0.24, 0.24), color: BODY },
  { test: (x, y) => inEllipse(x, y, 0.5, 0.455, 0.135, 0.07), color: BILL_OUTLINE },
  { test: (x, y) => inEllipse(x, y, 0.5, 0.45, 0.115, 0.052), color: BILL },
  { test: (x, y) => inEllipse(x, y, 0.41, 0.3, 0.047, 0.047), color: EYE },
  { test: (x, y) => inEllipse(x, y, 0.59, 0.3, 0.047, 0.047), color: EYE },
  { test: (x, y) => inEllipse(x, y, 0.398, 0.288, 0.017, 0.017), color: WHITE },
  { test: (x, y) => inEllipse(x, y, 0.578, 0.288, 0.017, 0.017), color: WHITE },
];

// Silhouette (union of outer shapes) for the macOS template icon.
const SILHOUETTE = (x, y) =>
  inEllipse(x, y, 0.5, 0.66, 0.315, 0.265) ||
  inEllipse(x, y, 0.5, 0.36, 0.265, 0.265) ||
  inEllipse(x, y, 0.5, 0.455, 0.135, 0.07);

const SS = 3; // supersampling grid per axis

function render(size, mode) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          let color = null;
          if (mode === 'template') {
            if (SILHOUETTE(x, y)) color = [0, 0, 0];
          } else {
            for (const s of DUCK_SHAPES) if (s.test(x, y)) color = s.color;
          }
          if (color) {
            r += color[0];
            g += color[1];
            b += color[2];
            a += 255;
          }
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      const alpha = a / n;
      // premultiplied average un-premultiplied back out
      rgba[i] = alpha ? Math.round(r / (a / 255)) : 0;
      rgba[i + 1] = alpha ? Math.round(g / (a / 255)) : 0;
      rgba[i + 2] = alpha ? Math.round(b / (a / 255)) : 0;
      rgba[i + 3] = Math.round(alpha);
    }
  }
  return encodePNG(rgba, size, size);
}

const out = (name, buf) => {
  fs.writeFileSync(path.join(__dirname, name), buf);
  console.log(`wrote build/${name} (${buf.length} bytes)`);
};

out('icon.png', render(512, 'color'));
out('tray.png', render(32, 'color'));
out('trayTemplate.png', render(16, 'template'));
out('trayTemplate@2x.png', render(32, 'template'));
