import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

describe('packaging invariants (test 323)', () => {
  it('Dockerfile exists and contains USER openpost, VOLUME ["/data"]', () => {
    const path = join(ROOT, 'Dockerfile');
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('USER openpost');
    expect(content).toContain('VOLUME ["/data"]');
    expect(content).toContain('HEALTHCHECK');
  });

  it('compose.yaml exists and mounts a named volume', () => {
    const path = join(ROOT, 'compose.yaml');
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf8');
    expect(content).toMatch(/openpost-data:\/data/);
  });

  it('packaging/openpost.service exists and contains NoNewPrivileges=true and UMask=0077', () => {
    const path = join(ROOT, 'packaging', 'openpost.service');
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('NoNewPrivileges=true');
    expect(content).toContain('UMask=0077');
    expect(content).toContain('ProtectSystem=strict');
  });

  it('packaging/openpost.env.example and packaging/README.md exist', () => {
    expect(existsSync(join(ROOT, 'packaging', 'openpost.env.example'))).toBe(true);
    expect(existsSync(join(ROOT, 'packaging', 'README.md'))).toBe(true);
  });

  it('docs/packaging.md records the SEA deferral', () => {
    const content = readFileSync(join(ROOT, 'docs', 'packaging.md'), 'utf8');
    expect(content).toMatch(/deferred/i);
    expect(content).toMatch(/better-sqlite3/);
  });
});
