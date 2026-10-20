import type { TrackingEvent } from './types.js';

export type Listener = (e: TrackingEvent) => void;

/**
 * In-process, synchronous fan-out from the record-event path to SSE subscribers and the notify
 * worker (§2.3). A listener that throws is caught and logged; it never propagates back to the
 * caller, because a broken notifier or SSE stream must never break pixel/click recording.
 */
export class EventBus {
  private readonly listeners = new Set<Listener>();
  private readonly buffer: TrackingEvent[] = [];
  private readonly bufferSize: number;

  constructor(bufferSize = 100) {
    this.bufferSize = bufferSize;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  publish(e: TrackingEvent): void {
    this.buffer.push(e);
    if (this.buffer.length > this.bufferSize) {
      this.buffer.splice(0, this.buffer.length - this.bufferSize);
    }
    for (const listener of this.listeners) {
      try {
        listener(e);
      } catch (err) {
        console.error('openpost: an EventBus listener threw (ignored)', err);
      }
    }
  }

  /** Newest last, for SSE catch-up (`?since=`). */
  recent(limit = this.bufferSize): TrackingEvent[] {
    return this.buffer.slice(Math.max(0, this.buffer.length - limit));
  }

  /** Subscriber count (tests). */
  size(): number {
    return this.listeners.size;
  }
}
