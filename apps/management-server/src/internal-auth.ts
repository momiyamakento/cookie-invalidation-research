import { createHash, timingSafeEqual } from "node:crypto";

import { isBenchmarkServiceId, type ManagedServiceId, type SiteServiceId } from "@cookie-research/protocol";
import { deriveBenchmarkToken } from "@cookie-research/service-kit";

export type SiteTokens = Partial<Record<SiteServiceId, string>>;

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export class SiteTokenAuthenticator {
  private readonly tokenDigests: ReadonlyArray<{
    serviceId: SiteServiceId;
    digest: Buffer;
  }>;

  public constructor(
    tokens: SiteTokens,
    private readonly benchmarkSharedSecret?: string,
  ) {
    this.tokenDigests = Object.entries(tokens).map(([serviceId, token]) => ({
      serviceId: serviceId as SiteServiceId,
      digest: tokenDigest(token),
    }));
  }

  public authenticate(
    authorization: string | undefined,
    benchmarkServiceId?: string,
  ): ManagedServiceId | undefined {
    if (authorization === undefined || !authorization.startsWith("Bearer ")) {
      return undefined;
    }

    const providedToken = authorization.slice("Bearer ".length);
    if (providedToken.length === 0) {
      return undefined;
    }
    const providedDigest = tokenDigest(providedToken);

    for (const candidate of this.tokenDigests) {
      if (timingSafeEqual(providedDigest, candidate.digest)) {
        return candidate.serviceId;
      }
    }
    if (
      this.benchmarkSharedSecret !== undefined &&
      benchmarkServiceId !== undefined &&
      isBenchmarkServiceId(benchmarkServiceId)
    ) {
      const expected = tokenDigest(deriveBenchmarkToken(this.benchmarkSharedSecret, benchmarkServiceId));
      if (timingSafeEqual(providedDigest, expected)) return benchmarkServiceId;
    }
    return undefined;
  }
}
