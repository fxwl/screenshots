import type {
  BrowserApiAdapter,
  BrowserCookieChangeCause,
  BrowserCookieChangeEvent,
  BrowserCookieInput,
} from '../types';
import { buildCookieUrl, cookieContentCanonicalHash } from './CookieApplyHelper';
import { buildEchoCookieKey, type EchoSuppressor } from './EchoSuppressor';

export interface CoalescedCookieChange {
  kind: 'upsert' | 'delete';
  cookie: BrowserCookieInput;
  cause: BrowserCookieChangeCause;
}

interface BufferedChange {
  latestEvent: BrowserCookieChangeEvent;
  sawOverwriteRemoval: boolean;
}

/**
 * Coalesces rapid browser.onCookieChanged events over `debounceMs`:
 * - Suppresses echo events registered in EchoSuppressor (S-013, Prohibition #11)
 * - Filters transient `removed: true, cause: 'overwrite'` followed by the new value (S-016)
 * - Verifies live cookie state if an overwrite-removal had no immediate follow-up
 * - Preserves `expired` / `evicted` / `explicit` causes so S-015 distinguishes them accurately
 */
export class ChangeDetector {
  private readonly browser: BrowserApiAdapter;
  private readonly echoSuppressor: EchoSuppressor;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly onFlushedChanges: (changes: CoalescedCookieChange[]) => Promise<void>;

  private readonly buffer = new Map<string, BufferedChange>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstBufferedAt: number | null = null;
  private flushing: Promise<void> | null = null;

  constructor(params: {
    browser: BrowserApiAdapter;
    echoSuppressor: EchoSuppressor;
    debounceMs?: number;
    maxWaitMs?: number;
    onFlushedChanges: (changes: CoalescedCookieChange[]) => Promise<void>;
  }) {
    this.browser = params.browser;
    this.echoSuppressor = params.echoSuppressor;
    this.debounceMs = params.debounceMs ?? 1500;
    this.maxWaitMs =
      params.maxWaitMs ?? (this.debounceMs > 0 ? Math.max(this.debounceMs * 2, 5_000) : 0);
    this.onFlushedChanges = params.onFlushedChanges;
  }

  private now(): number {
    return this.browser.now ? this.browser.now() : Date.now();
  }

  handleCookieChange(event: BrowserCookieChangeEvent): void {
    const nowMs = this.now();
    const contentHash = cookieContentCanonicalHash(event.cookie);

    // S-013 / Prohibition #11: filter loopback echoes
    if (this.echoSuppressor.shouldSuppressCookieEvent(event, contentHash, nowMs)) {
      return;
    }

    const key = buildEchoCookieKey(event.cookie);
    const prev = this.buffer.get(key);

    if (event.removed && event.cause === 'overwrite') {
      // Transient overwrite removal — keep buffered without replacing a subsequent non-removed event
      this.buffer.set(key, {
        latestEvent: event,
        sawOverwriteRemoval: true,
      });
    } else if (!event.removed) {
      // New or updated cookie value supersedes any transient overwrite removal
      this.buffer.set(key, {
        latestEvent: event,
        sawOverwriteRemoval: prev?.sawOverwriteRemoval ?? false,
      });
    } else {
      // Explicit, expired, evicted, or expired_overwrite removal
      this.buffer.set(key, {
        latestEvent: event,
        sawOverwriteRemoval: false,
      });
    }

    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.debounceMs <= 0) {
      // Schedule microtask/next-tick coalesce so paired overwrite(removed=true)+set(removed=false)
      // fired synchronously in Chromium/Simulator are ALWAYS coalesced together!
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, 0);
      return;
    }
    const wallNow = Date.now();
    if (this.firstBufferedAt === null) {
      this.firstBufferedAt = wallNow;
    }
    // Bound trailing debounce with maxWaitMs so continuous cookie churn on noisy tabs NEVER starves flush()!
    const remainingMaxWait = Math.max(0, this.maxWaitMs - (wallNow - this.firstBufferedAt));
    const delayMs = Math.min(this.debounceMs, remainingMaxWait);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delayMs);
  }

  hasPending(): boolean {
    return this.buffer.size > 0;
  }

  /**
   * Discard a stale buffered event for a specific cookie key right before an
   * authoritative local mutation (e.g. explicit deleteCookies / upsertCookie),
   * preventing a pre-mutation debounced upsert from resurrecting a deleted cookie.
   */
  discardCookieKey(key: string): void {
    if (!this.buffer.delete(key)) return;
    if (this.buffer.size === 0) {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.firstBufferedAt = null;
    }
  }

  /**
   * Discard buffered events matching a predicate (e.g. all cookies on a site
   * undergoing an authoritative track switch, safety undo, or backup restore).
   */
  discardWhere(predicate: (cookie: BrowserCookieInput) => boolean): void {
    let removedAny = false;
    for (const [key, item] of this.buffer.entries()) {
      if (predicate(item.latestEvent.cookie)) {
        this.buffer.delete(key);
        removedAny = true;
      }
    }
    if (removedAny && this.buffer.size === 0) {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.firstBufferedAt = null;
    }
  }

  /**
   * Clear all buffered events & pending debounce timer (used after a full jar scan
   * during space join/create/switch so pre-join events cannot replay stale state).
   */
  clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.firstBufferedAt = null;
    this.buffer.clear();
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.firstBufferedAt = null;

    if (this.flushing) {
      await this.flushing;
      if (this.buffer.size === 0) return;
    }

    if (this.buffer.size === 0) return;

    const run = async () => {
      const snapshot = Array.from(this.buffer.values());
      this.buffer.clear();

      const finalized: CoalescedCookieChange[] = [];

      for (const item of snapshot) {
        const ev = item.latestEvent;

        // S-016: If the last seen event was a transient overwrite removal, verify live jar state
        if (ev.removed && ev.cause === 'overwrite') {
          try {
            const url = buildCookieUrl(ev.cookie);
            const live = await this.browser.getCookie({
              url,
              name: ev.cookie.name,
              storeId: ev.cookie.storeId,
              partitionKey: ev.cookie.partitionKey,
            });
            if (live) {
              finalized.push({
                kind: 'upsert',
                cookie: live,
                cause: 'overwrite',
              });
              continue;
            }
          } catch {
            // Fall through to treat as removed if live check fails
          }
          finalized.push({
            kind: 'delete',
            cookie: ev.cookie,
            cause: 'explicit',
          });
          continue;
        }

        if (ev.removed) {
          finalized.push({
            kind: 'delete',
            cookie: ev.cookie,
            cause: ev.cause,
          });
        } else {
          finalized.push({
            kind: 'upsert',
            cookie: ev.cookie,
            cause: ev.cause,
          });
        }
      }

      if (finalized.length > 0) {
        await this.onFlushedChanges(finalized);
      }
    };

    this.flushing = run().finally(() => {
      this.flushing = null;
    });
    await this.flushing;
  }

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffer.clear();
  }
}
