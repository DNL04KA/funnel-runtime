/**
 * Client-side event queue.
 *
 * Events are buffered, flushed in batches, and mirrored into localStorage until
 * the server confirms them. That means a reload mid-flight replays the batch —
 * which is exactly the case the server's `event_id` deduplication exists for, so
 * the retry is safe by construction rather than by careful timing.
 */

export interface QueuedEvent {
  event_id: string;
  session_id: string;
  event_type: string;
  client_ts: string;
  step_id?: string | null;
  props?: Record<string, unknown>;
}

const STORAGE_KEY = 'funnel.event_queue.v1';
const FLUSH_SIZE = 6;
const FLUSH_INTERVAL_MS = 2500;

function readStored(): QueuedEvent[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as QueuedEvent[]) : [];
  } catch {
    return [];
  }
}

function writeStored(events: QueuedEvent[]): void {
  try {
    if (events.length === 0) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(events.slice(-200)));
  } catch {
    /* quota or private mode — the queue degrades to in-memory only */
  }
}

export interface QueueStats {
  pending: number;
  sent: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  batches: number;
  lastError: string | null;
}

type Listener = (stats: QueueStats) => void;

class EventQueue {
  private buffer: QueuedEvent[] = readStored();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private listeners = new Set<Listener>();
  private stats: QueueStats = {
    pending: this.buffer.length,
    sent: 0,
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    batches: 0,
    lastError: null,
  };

  constructor() {
    if (typeof window === 'undefined') return;
    // A tab closing mid-funnel still delivers: sendBeacon survives unload.
    window.addEventListener('pagehide', () => this.flushBeacon());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flushBeacon();
    });
    if (this.buffer.length > 0) this.schedule(200);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.stats);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.stats = { ...this.stats, pending: this.buffer.length };
    for (const listener of this.listeners) listener(this.stats);
  }

  push(event: QueuedEvent): void {
    // Same event_id twice in one session is a no-op locally as well as remotely.
    if (this.buffer.some((e) => e.event_id === event.event_id)) return;
    this.buffer.push(event);
    writeStored(this.buffer);
    this.notify();
    if (this.buffer.length >= FLUSH_SIZE) void this.flush();
    else this.schedule(FLUSH_INTERVAL_MS);
  }

  private schedule(delay: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  async flush(): Promise<void> {
    if (this.inFlight || this.buffer.length === 0) return;
    const batch = this.buffer.slice(0, 50);
    this.inFlight = true;

    try {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: batch }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = (await res.json()) as {
        accepted: number;
        duplicates: number;
        rejected: number;
      };

      // Drop only what this batch covered; events queued meanwhile stay.
      const sentIds = new Set(batch.map((e) => e.event_id));
      this.buffer = this.buffer.filter((e) => !sentIds.has(e.event_id));
      writeStored(this.buffer);

      this.stats = {
        ...this.stats,
        batches: this.stats.batches + 1,
        sent: this.stats.sent + batch.length,
        accepted: this.stats.accepted + payload.accepted,
        duplicates: this.stats.duplicates + payload.duplicates,
        rejected: this.stats.rejected + payload.rejected,
        lastError: null,
      };
    } catch (err) {
      // Nothing is discarded: the batch stays queued and is retried as-is.
      this.stats = { ...this.stats, lastError: (err as Error).message };
      this.schedule(4000);
    } finally {
      this.inFlight = false;
      this.notify();
      if (this.buffer.length > 0) this.schedule(FLUSH_INTERVAL_MS);
    }
  }

  private flushBeacon(): void {
    if (this.buffer.length === 0) return;
    try {
      const body = JSON.stringify({ events: this.buffer.slice(0, 50) });
      const ok = navigator.sendBeacon?.(
        '/api/events',
        new Blob([body], { type: 'application/json' }),
      );
      // The queue is intentionally *not* cleared: if the beacon landed, the
      // replay on next load is deduplicated server-side.
      if (!ok) void this.flush();
    } catch {
      /* ignore */
    }
  }
}

export const eventQueue = new EventQueue();

/** Monotonic-ish per-session event ids: stable across retries, unique per action. */
export function makeEventId(sessionId: string, stepId: string | null, kind: string, seq: number): string {
  return `${sessionId}:${stepId ?? 'none'}:${kind}:${seq}`;
}
