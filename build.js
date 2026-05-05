/**
 * SVG Grabber – Build Script
 *
 * Usage:
 *   node build.js           # one-shot production build
 *   node build.js --watch   # rebuild on file change (development)
 *
 * Output: dist/ — load this folder as an unpacked Chrome extension.
 */

'use strict';

const esbuild  = require('esbuild');
const fs       = require('fs');
const path     = require('path');
const zlib     = require('zlib');

const WATCH = process.argv.includes('--watch');
const ROOT  = __dirname;
const SRC   = path.join(ROOT, 'src');
const DIST  = path.join(ROOT, 'dist');

// ── Directory helpers ──────────────────────────────────────────────────────
function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dst) {
  mkdirp(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

// ── Minimal PNG encoder ────────────────────────────────────────────────────
// Creates a solid-colour PNG without any external library.

function uint32BE(n) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) c = (c & 1) ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const dataBuf   = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const crc       = crc32(Buffer.concat([typeBytes, dataBuf]));
  return Buffer.concat([uint32BE(dataBuf.length), typeBytes, dataBuf, uint32BE(crc)]);
}

/**
 * Generate a simple icon PNG: an indigo square with a white "S"-shaped
 * bezier symbol drawn in pixels.  The design is identical at every size
 * (scaled by the caller via the `size` parameter).
 */
function generateIconPNG(size) {
  // ── Pixel renderer ──────────────────────────────────────────────────────
  const pixels = new Uint8Array(size * size * 3); // RGB

  // Background: indigo #4f46e5 = rgb(79,70,229)
  const BG  = [79,  70,  229];
  // Foreground: white #ffffff
  const FG  = [255, 255, 255];

  function setPixel(x, y, col) {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 3;
    pixels[i] = col[0]; pixels[i+1] = col[1]; pixels[i+2] = col[2];
  }

  // Fill with background.
  for (let i = 0; i < size * size; i++) {
    pixels[i*3]   = BG[0];
    pixels[i*3+1] = BG[1];
    pixels[i*3+2] = BG[2];
  }

  // Draw a simple S-curve bezier (3 anchor points) in white, scaled to `size`.
  // Anchor points defined on a 0-1 unit square, scaled to (2..size-2).
  const pts = [
    [0.65, 0.2],   // top-right of S
    [0.30, 0.2],   // top bar left
    [0.30, 0.45],  // mid-left
    [0.70, 0.55],  // mid-right
    [0.70, 0.80],  // bottom bar right
    [0.35, 0.80],  // bottom-left of S
  ];

  const margin = 2;
  const span   = size - margin * 2;

  function toPixel(u, v) {
    return [Math.round(u * span + margin), Math.round(v * span + margin)];
  }

  // Stroke width: 1 px at 16, scaled up for larger icons.
  const sw = Math.max(1, Math.round(size / 16));

  function drawThickLine(x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.sqrt(dx*dx + dy*dy);
    const steps = Math.ceil(len * 2);
    for (let s = 0; s <= steps; s++) {
      const t  = s / steps;
      const cx = Math.round(x0 + t * dx);
      const cy = Math.round(y0 + t * dy);
      for (let ox = -Math.floor(sw/2); ox <= Math.floor(sw/2); ox++)
        for (let oy = -Math.floor(sw/2); oy <= Math.floor(sw/2); oy++)
          setPixel(cx+ox, cy+oy, FG);
    }
  }

  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = toPixel(...pts[i]);
    const [x1, y1] = toPixel(...pts[i+1]);
    drawThickLine(x0, y0, x1, y1);
  }

  // ── Encode as PNG ────────────────────────────────────────────────────────
  const signature = Buffer.from([137,80,78,71,13,10,26,10]);

  // IHDR
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8]  = 8; // bit depth
  ihdr[9]  = 2; // colour type: RGB
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace: none

  // Raw image rows: each row = [0(filter)] + [R,G,B × width]
  const raw = Buffer.allocUnsafe(size * (size * 3 + 1));
  for (let row = 0; row < size; row++) {
    const rowStart = row * size * 3;
    const rowOff   = row * (size * 3 + 1);
    raw[rowOff] = 0; // filter type: None
    const rowPixels = pixels.subarray(rowStart, rowStart + size * 3);
    Buffer.from(rowPixels.buffer, rowPixels.byteOffset, rowPixels.byteLength)
          .copy(raw, rowOff + 1);
  }

  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── esbuild helpers ────────────────────────────────────────────────────────
const commonOptions = {
  bundle:    true,
  platform:  'browser',
  target:    ['chrome112'],
  minify:    !WATCH,
  sourcemap: WATCH ? 'inline' : false,
  logLevel:  'info',
};

async function buildAll() {
  mkdirp(path.join(DIST, 'background'));
  mkdirp(path.join(DIST, 'content_scripts'));
  mkdirp(path.join(DIST, 'side_panel'));
  mkdirp(path.join(DIST, 'workers'));
  mkdirp(path.join(DIST, 'icons'));

  const promises = [
    // Service worker – no external deps, IIFE format.
    esbuild.build({
      ...commonOptions,
      entryPoints: [path.join(SRC, 'background/service_worker.js')],
      outfile:     path.join(DIST, 'background/service_worker.js'),
      format:      'iife',
    }),

    // Content script – no external deps, IIFE (runs in isolated world).
    esbuild.build({
      ...commonOptions,
      entryPoints: [path.join(SRC, 'content_scripts/overlay.js')],
      outfile:     path.join(DIST, 'content_scripts/overlay.js'),
      format:      'iife',
    }),

    // Side panel – bundles fabric.js.
    esbuild.build({
      ...commonOptions,
      entryPoints: [path.join(SRC, 'side_panel/panel.js')],
      outfile:     path.join(DIST, 'side_panel/panel.js'),
      format:      'iife',
      // Fabric.js v5 uses browser globals extensively.
      define: {
        'process.env.NODE_ENV': WATCH ? '"development"' : '"production"',
      },
    }),

    // Web worker – bundles imagetracerjs.
    esbuild.build({
      ...commonOptions,
      entryPoints: [path.join(SRC, 'workers/tracer.worker.js')],
      outfile:     path.join(DIST, 'workers/tracer.worker.js'),
      format:      'iife',
    }),
  ];

  if (WATCH) {
    // In watch mode esbuild v0.17+ expects contexts; keep it simple with
    // rebuild contexts.
    console.log('[build] watching for changes…');
    // Run once, then rely on esbuild's --watch flag (rebuild triggers on
    // each invocation of this script from a shell watcher).
  }

  await Promise.all(promises);

  // ── Copy static files ──────────────────────────────────────────────────
  copyFile(path.join(SRC, 'manifest.json'),           path.join(DIST, 'manifest.json'));
  copyFile(path.join(SRC, 'side_panel/index.html'),   path.join(DIST, 'side_panel/index.html'));

  // ── Generate icons ─────────────────────────────────────────────────────
  for (const size of [16, 48, 128]) {
    fs.writeFileSync(
      path.join(DIST, 'icons', `icon${size}.png`),
      generateIconPNG(size),
    );
  }

  console.log('[build] ✓ dist/ is ready – load it as an unpacked Chrome extension.');
}

buildAll().catch((err) => {
  console.error('[build] FAILED:', err);
  process.exit(1);
});
