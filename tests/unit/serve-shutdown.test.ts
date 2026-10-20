import { describe, expect, it, vi } from 'vitest';
import { createShutdown } from '../../src/cli/commands/serve.js';

function fakeDeps(overrides: Partial<Parameters<typeof createShutdown>[0]> = {}) {
  const calls: string[] = [];
  const exit = vi.fn();
  const log = { error: vi.fn() };
  const base = {
    app: { close: vi.fn(async () => void calls.push('app.close')) },
    scheduler: { stop: vi.fn(async () => void calls.push('scheduler.stop')) },
    notifyWorker: { stop: vi.fn(async () => void calls.push('notifyWorker.stop')) },
    detachNotifyWorker: vi.fn(() => void calls.push('detachNotifyWorker')),
    db: { close: vi.fn(() => void calls.push('db.close')) },
    exit,
    log,
  };
  return { deps: { ...base, ...overrides }, calls, exit, log };
}

describe('createShutdown (finding #22)', () => {
  it('runs every step in order and exits 0 on a clean shutdown', async () => {
    const { deps, calls, exit } = fakeDeps();
    const shutdown = createShutdown(deps);
    shutdown();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(calls).toEqual(['app.close', 'scheduler.stop', 'notifyWorker.stop', 'detachNotifyWorker', 'db.close']);
  });

  it('is idempotent - calling it twice runs the chain only once', async () => {
    const { deps, exit } = fakeDeps();
    const shutdown = createShutdown(deps);
    shutdown();
    shutdown();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
  });

  it('a rejection from ANY step (not just app.close) is caught, logged, and the rest of the chain still runs to completion', async () => {
    const { deps, calls, exit, log } = fakeDeps({
      scheduler: { stop: vi.fn(async () => { throw new Error('scheduler exploded'); }) },
    });
    const shutdown = createShutdown(deps);
    shutdown();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    // Every step after the throwing one still ran - the whole chain never stopped.
    expect(calls).toEqual(['app.close', 'notifyWorker.stop', 'detachNotifyWorker', 'db.close']);
    expect(log.error).toHaveBeenCalled();
  });

  it('a hung step (never resolves) is force-exited by the drain watchdog instead of hanging forever', async () => {
    const { deps, exit, log } = fakeDeps({
      app: { close: () => new Promise<void>(() => undefined) }, // never resolves
    });
    const shutdown = createShutdown({ ...deps, drainTimeoutMs: 10 });
    shutdown();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(log.error).toHaveBeenCalled();
  });
});
