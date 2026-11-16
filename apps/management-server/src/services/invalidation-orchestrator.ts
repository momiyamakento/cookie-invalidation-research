import type { Database } from "better-sqlite3";

import {
  isBenchmarkServiceId,
} from "@cookie-research/protocol";
import type {
  DetectionInvalidationTarget,
  DetectionProcessingStatus,
  DetectionTarget,
  ManagedServiceId,
} from "@cookie-research/protocol";
import { deriveBenchmarkToken } from "@cookie-research/service-kit";

import type { DetectionRepository } from "../db/repositories/detection-repository.js";
import type {
  InvalidationJobRecord,
  InvalidationJobRepository,
} from "../db/repositories/invalidation-job-repository.js";
import type { ServiceRepository } from "../db/repositories/service-repository.js";
import type {
  SiteRevocationClient,
  SiteRevocationClientResult,
} from "../site-revocation-client.js";

export type ManagerToSiteTokens = Partial<Record<ManagedServiceId, string>>;
export type InvalidationStrategy = "parallel" | "sequential";

export interface InvalidationOrchestrationResult {
  eventId: string;
  principalId: string;
  status: DetectionProcessingStatus;
  targets: DetectionInvalidationTarget[];
  totalDurationMs: number | null;
}

interface JobCompletion {
  job: InvalidationJobRecord;
  result: SiteRevocationClientResult;
  completedAt: string;
  durationMs: number;
}

export class InvalidationOrchestrator {
  public constructor(
    private readonly database: Database,
    private readonly detectionRepository: DetectionRepository,
    private readonly jobRepository: InvalidationJobRepository,
    private readonly serviceRepository: ServiceRepository,
    private readonly tokens: ManagerToSiteTokens,
    private readonly client: SiteRevocationClient,
    private readonly benchmarkSharedSecret?: string,
    private readonly strategy: InvalidationStrategy = "parallel",
  ) {}

  public async orchestrate(
    eventId: string,
    targets: DetectionTarget[],
  ): Promise<InvalidationOrchestrationResult> {
    const prepare = this.database.transaction(() => {
      const event = this.detectionRepository.findByEventId(eventId);
      if (event === undefined) throw new Error(`Detection ${eventId} not found.`);
      if (event.status !== "RESOLVED") {
        return { execute: false as const, event, jobs: this.jobRepository.findForEvent(eventId) };
      }
      if (!this.detectionRepository.markProcessing(eventId)) {
        const current = this.detectionRepository.findByEventId(eventId);
        if (current === undefined) throw new Error(`Detection ${eventId} disappeared.`);
        return { execute: false as const, event: current, jobs: this.jobRepository.findForEvent(eventId) };
      }
      const jobs = targets.map((target) =>
        this.jobRepository.createPending(eventId, target),
      );
      const processing = this.detectionRepository.findByEventId(eventId);
      if (processing === undefined) throw new Error(`Detection ${eventId} disappeared.`);
      return { execute: true as const, event: processing, jobs };
    }).immediate();

    if (!prepare.execute) return this.snapshot(prepare.event.eventId);

    const execute = async (job: InvalidationJobRecord): Promise<JobCompletion> => {
        const service = this.serviceRepository.findById(job.targetServiceId);
        const token = this.tokenFor(job.targetServiceId);
        const result =
          service === undefined
            ? ({
                ok: false,
                attempts: 0,
                httpStatus: null,
                error: "SERVICE_NOT_FOUND",
              } satisfies SiteRevocationClientResult)
            : token === undefined
              ? ({ ok: false, attempts: 0, httpStatus: null, error: "SITE_TOKEN_NOT_CONFIGURED" } satisfies SiteRevocationClientResult)
              : await this.client({
                baseUrl: service.baseUrl,
                authToken: token,
                request: {
                  requestId: job.requestId,
                  eventId: job.eventId,
                  localUserId: job.targetLocalUserId,
                  reason: "DECOY_COOKIE_DETECTED",
                  detectedAt: prepare.event.detectedAt,
                },
              });
        const completedAt = new Date().toISOString();
        return {
          job,
          result,
          completedAt,
          durationMs: Math.max(0, Date.now() - Date.parse(job.startedAt)),
        };
    };
    const settled: PromiseSettledResult<JobCompletion>[] = this.strategy === "parallel"
      ? await Promise.allSettled(prepare.jobs.map(execute))
      : await (async () => {
        const outcomes: PromiseSettledResult<JobCompletion>[] = [];
        for (const job of prepare.jobs) {
          try { outcomes.push({ status: "fulfilled", value: await execute(job) }); }
          catch (reason) { outcomes.push({ status: "rejected", reason }); }
        }
        return outcomes;
      })();

    const completions: JobCompletion[] = settled.map((outcome, index) => {
      if (outcome.status === "fulfilled") return outcome.value;
      const job = prepare.jobs[index];
      if (job === undefined) throw new Error("Missing invalidation job result.");
      return {
        job,
        result: {
          ok: false,
          attempts: 0,
          httpStatus: null,
          error: "CLIENT_ERROR",
        },
        completedAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - Date.parse(job.startedAt)),
      };
    });

    this.database.transaction(() => {
      for (const completion of completions) {
        this.jobRepository.complete(completion.job.id, {
          status: completion.result.ok ? "SUCCESS" : "FAILED",
          httpStatus: completion.result.httpStatus,
          completedAt: completion.completedAt,
          durationMs: completion.durationMs,
          revokedCount: completion.result.ok
            ? completion.result.response.revokedCount
            : null,
          errorMessage: completion.result.ok ? null : completion.result.error,
        });
      }
      const successCount = completions.filter(({ result }) => result.ok).length;
      const finalStatus =
        successCount === completions.length
          ? "SUCCESS"
          : successCount === 0
            ? "FAILED"
            : "PARTIAL_FAILURE";
      const completedAt = new Date().toISOString();
      this.detectionRepository.complete(
        eventId,
        finalStatus,
        completedAt,
        Math.max(0, Date.now() - Date.parse(prepare.event.receivedAt)),
      );
    }).immediate();

    return this.snapshot(eventId);
  }

  public snapshot(eventId: string): InvalidationOrchestrationResult {
    const event = this.detectionRepository.findByEventId(eventId);
    if (event === undefined) throw new Error(`Detection ${eventId} not found.`);
    return {
      eventId,
      principalId: event.principalId,
      status: event.status,
      totalDurationMs: event.totalDurationMs,
      targets: this.jobRepository.findForEvent(eventId).map((job) => ({
        serviceId: job.targetServiceId,
        localUserId: job.targetLocalUserId,
        status: job.status,
        revokedCount: job.revokedCount,
        durationMs: job.durationMs,
        httpStatus: job.httpStatus,
      })),
    };
  }

  private tokenFor(serviceId: ManagedServiceId): string | undefined {
    const fixedToken = this.tokens[serviceId];
    if (fixedToken !== undefined) return fixedToken;
    return isBenchmarkServiceId(serviceId) && this.benchmarkSharedSecret !== undefined
      ? deriveBenchmarkToken(this.benchmarkSharedSecret, serviceId)
      : undefined;
  }
}
