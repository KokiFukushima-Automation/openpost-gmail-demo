import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ICONS, renderIcon } from '../../scripts/gen-icons.mjs';
import { PWA_ICON_EXPECTED_SHA256 } from '../../src/server/assets/index.js';

const ASSETS_DIR = join(process.cwd(), 'src', 'server', 'assets');

describe('gen-icons: deterministic PNG generation (test 380)', () => {
  for (const { name, size, opts } of ICONS) {
    it(`${name}: re-running renderIcon in memory is byte-identical to the committed file and matches the recorded sha256`, () => {
      const regenerated = renderIcon(size, opts);
      const committed = readFileSync(join(ASSETS_DIR, name));
      expect(regenerated.equals(committed)).toBe(true);
      const sha = createHash('sha256').update(committed).digest('hex');
      expect(sha).toBe(PWA_ICON_EXPECTED_SHA256[name]);
    });
  }

  it('PNG signature and IHDR dimensions are correct', () => {
    const buf = renderIcon(192, {});
    expect(buf.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(buf.readUInt32BE(16)).toBe(192); // width
    expect(buf.readUInt32BE(20)).toBe(192); // height
  });
});
