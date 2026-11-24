interface FlipHistory {
  lastDeviceId: string;
  flipTimestamps: number[];
  dampedUntil: number;
}

/**
 * Optimization #7: RollingTokenDamper
 * Detects rapid ping-pong overwrites (>= 3 flips within 60s between two devices on the same cookie)
 * and damps background-tab devices while allowing the active-tab device to win.
 */
export class RollingTokenDamper {
  private readonly windowMs: number;
  private readonly flipThreshold: number;
  private readonly dampDurationMs: number;

  private readonly cookieHistory = new Map<string, FlipHistory>();
  private readonly siteDampedUntil = new Map<string, number>();

  constructor(options?: { windowMs?: number; flipThreshold?: number; dampDurationMs?: number }) {
    this.windowMs = options?.windowMs ?? 60_000;
    this.flipThreshold = options?.flipThreshold ?? 3;
    this.dampDurationMs = options?.dampDurationMs ?? 60_000;
  }

  recordUpdate(cookieKey: string, siteKey: string, sourceDeviceId: string, nowMs: number): boolean {
    let entry = this.cookieHistory.get(cookieKey);
    if (!entry) {
      entry = { lastDeviceId: sourceDeviceId, flipTimestamps: [], dampedUntil: 0 };
      this.cookieHistory.set(cookieKey, entry);
      return false;
    }

    entry.flipTimestamps = entry.flipTimestamps.filter((ts) => nowMs - ts <= this.windowMs);

    if (entry.lastDeviceId !== sourceDeviceId) {
      entry.flipTimestamps.push(nowMs);
      entry.lastDeviceId = sourceDeviceId;
      if (entry.flipTimestamps.length >= this.flipThreshold) {
        entry.dampedUntil = nowMs + this.dampDurationMs;
        const prevSiteDamp = this.siteDampedUntil.get(siteKey) ?? 0;
        this.siteDampedUntil.set(siteKey, Math.max(prevSiteDamp, entry.dampedUntil));
        return true;
      }
    }

    return entry.dampedUntil > nowMs;
  }

  isCookieDamped(cookieKey: string, nowMs: number): boolean {
    const entry = this.cookieHistory.get(cookieKey);
    return Boolean(entry && entry.dampedUntil > nowMs);
  }

  isSiteDamped(siteKey: string, nowMs: number): boolean {
    const until = this.siteDampedUntil.get(siteKey) ?? 0;
    return until > nowMs;
  }

  shouldSuppressLocalPush(
    cookieKey: string,
    siteKey: string,
    hasActiveTabForSite: boolean,
    nowMs: number,
  ): boolean {
    if (!this.isCookieDamped(cookieKey, nowMs) && !this.isSiteDamped(siteKey, nowMs)) {
      return false;
    }
    // Foreground active-tab device wins; background devices are damped
    return !hasActiveTabForSite;
  }

  reset(): void {
    this.cookieHistory.clear();
    this.siteDampedUntil.clear();
  }
}
