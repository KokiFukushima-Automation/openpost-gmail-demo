// Deterministic PNG icon generator for the PWA manifest (docs/09_phase5_spec.md §2.5). No image
// library: raw RGBA pixels, `node:zlib`'s deflate (for IDAT) and CRC32 (`zlib.crc32`, part of
// node:zlib since Node 21) for chunk checksums - nothing else. Rasterises a rounded square in
// `--accent` (#1b5fbf) with a white ring glyph from pure distance maths. Run directly
// (`node scripts/gen-icons.mjs`) to (re)write the committed PNGs under src/server/assets/; also
// imported by tests/unit/gen-icons.test.ts, which re-runs `renderIcon` in memory and asserts byte
// equality with the checked-in files (test 380).
import { deflateSync, crc32 } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ACCENT = [0x1b, 0x5f, 0xbf]; // #1b5fbf
const WHITE = [0xff, 0xff, 0xff];

function crc32Buf(buf) {
  // node:zlib's crc32 returns an unsigned 32-bit integer.
  return crc32(buf) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32Buf(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/** Renders a `size`x`size` RGBA rounded-square icon with a white ring glyph. `maskable` insets the
 *  artwork so Android's maskable-icon safe zone (a centred 80% circle) never clips it. */
export function renderIconPixels(size, { maskable = false } = {}) {
  const pixels = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const cornerRadius = maskable ? 0 : size * 0.22;
  const artScale = maskable ? 0.72 : 1; // keep well inside the 80% safe zone with margin
  const half = (size * artScale) / 2;

  const ringOuter = size * 0.30 * artScale;
  const ringInner = size * 0.19 * artScale;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;

      // Rounded-square membership test (or a plain square filling the whole canvas when maskable,
      // matching Android's own background-fill convention for maskable icons).
      let insideSquare;
      if (maskable) {
        insideSquare = true;
      } else {
        const ax = Math.abs(dx);
        const ay = Math.abs(dy);
        if (ax <= half - cornerRadius || ay <= half - cornerRadius) {
          insideSquare = ax <= half && ay <= half;
        } else {
          const cornerDx = ax - (half - cornerRadius);
          const cornerDy = ay - (half - cornerRadius);
          insideSquare = Math.sqrt(cornerDx * cornerDx + cornerDy * cornerDy) <= cornerRadius;
        }
      }

      if (!insideSquare) {
        pixels[idx] = 0;
        pixels[idx + 1] = 0;
        pixels[idx + 2] = 0;
        pixels[idx + 3] = 0;
        continue;
      }

      const dist = Math.sqrt(dx * dx + dy * dy);
      const onRing = dist <= ringOuter && dist >= ringInner;
      const color = onRing ? WHITE : ACCENT;
      pixels[idx] = color[0];
      pixels[idx + 1] = color[1];
      pixels[idx + 2] = color[2];
      pixels[idx + 3] = 255;
    }
  }
  return pixels;
}

export function encodePng(size, pixels) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = chunk('IHDR', ihdrData);

  // Each scanline is prefixed with a filter-type byte (0 = none).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = chunk('IDAT', deflateSync(raw, { level: 9 }));
  const iend = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

export function renderIcon(size, opts = {}) {
  return encodePng(size, renderIconPixels(size, opts));
}

const ICONS = [
  { name: 'icon-192.png', size: 192, opts: {} },
  { name: 'icon-512.png', size: 512, opts: {} },
  { name: 'icon-maskable-512.png', size: 512, opts: { maskable: true } },
  { name: 'apple-touch-icon-180.png', size: 180, opts: {} },
];

export function iconSha256(name) {
  const found = ICONS.find((i) => i.name === name);
  if (!found) throw new Error(`unknown icon: ${name}`);
  const buf = renderIcon(found.size, found.opts);
  return createHash('sha256').update(buf).digest('hex');
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, '..', 'src', 'server', 'assets');
  for (const { name, size, opts } of ICONS) {
    const buf = renderIcon(size, opts);
    writeFileSync(join(outDir, name), buf);
    console.log(`wrote ${name} (${buf.length} bytes, sha256 ${createHash('sha256').update(buf).digest('hex').slice(0, 16)}…)`);
  }
}

// Only run when invoked directly (`node scripts/gen-icons.mjs`), not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { ICONS };
