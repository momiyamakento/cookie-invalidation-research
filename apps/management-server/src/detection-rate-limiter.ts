export interface DetectionRateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Per-service rolling-window limiter for newly accepted detection event IDs.
 * Identical event IDs remain retryable and consume no additional capacity.
 * State is intentionally process-local; restart behavior is documented as an
 * evaluation limitation rather than presented as a distributed guarantee.
 */
export class DetectionRateLimiter {
  private readonly accepted = new Map<string, Map<string, number>>();

  public constructor(
    private readonly maxEvents: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) throw new Error("maxEvents must be a positive integer.");
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new Error("windowMs must be a positive integer.");
  }

  public check(serviceId: string, eventId: string): DetectionRateLimitDecision {
    const current = this.now();
    const events = this.events(serviceId, current);
    if (events.has(eventId) || events.size < this.maxEvents) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const oldest = Math.min(...events.values());
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - current) / 1_000)),
    };
  }

  public record(serviceId: string, eventId: string): void {
    const current = this.now();
    this.events(serviceId, current).set(eventId, current);
  }

  private events(serviceId: string, current: number): Map<string, number> {
    const events = this.accepted.get(serviceId) ?? new Map<string, number>();
    const cutoff = current - this.windowMs;
    for (const [eventId, acceptedAt] of events) {
      if (acceptedAt <= cutoff) events.delete(eventId);
    }
    if (events.size === 0) this.accepted.delete(serviceId);
    else this.accepted.set(serviceId, events);
    if (!this.accepted.has(serviceId)) this.accepted.set(serviceId, events);
    return events;
  }
}
