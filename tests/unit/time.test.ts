import { describe, expect, it } from 'vitest';
import { systemClock } from '../../src/core/time.js';

describe('time', () => {
  it('systemClock returns the current epoch millis', () => {
    const before = Date.now();
    const value = systemClock();
    const after = Date.now();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });
});
