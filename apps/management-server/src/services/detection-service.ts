import type { Database } from "better-sqlite3";

import type {
  DetectionNotificationRequest,
  DetectionTarget,
} from "@cookie-research/protocol";

import type {
  DetectionEventRecord,
  DetectionRepository,
} from "../db/repositories/detection-repository.js";
import type { MappingRepository } from "../db/repositories/mapping-repository.js";

export type ResolveDetectionResult =
  | {
      kind: "received" | "already_received";
      event: DetectionEventRecord;
      targets: DetectionTarget[];
    }
  | { kind: "event_id_conflict" }
  | { kind: "user_mapping_not_found" };

function sameNotification(
  event: DetectionEventRecord,
  request: DetectionNotificationRequest,
): boolean {
  return (
    event.eventId === request.eventId &&
    event.sourceServiceId === request.serviceId &&
    event.sourceLocalUserId === request.localUserId &&
    event.decoyId === request.decoyId &&
    event.detectedAt === request.detectedAt
  );
}

export class DetectionService {
  public constructor(
    private readonly database: Database,
    private readonly detectionRepository: DetectionRepository,
    private readonly mappingRepository: MappingRepository,
  ) {}

  public resolve(request: DetectionNotificationRequest): ResolveDetectionResult {
    const transaction = this.database.transaction((): ResolveDetectionResult => {
      const existing = this.detectionRepository.findByEventId(request.eventId);
      if (existing !== undefined) {
        if (!sameNotification(existing, request)) {
          return { kind: "event_id_conflict" };
        }
        return {
          kind: "already_received",
          event: existing,
          targets: this.targets(existing.principalId),
        };
      }

      const principalId = this.mappingRepository.findPrincipalByServiceUser(
        request.serviceId,
        request.localUserId,
      );
      if (principalId === undefined) {
        return { kind: "user_mapping_not_found" };
      }
      const targets = this.targets(principalId);
      const event = this.detectionRepository.insert(request, principalId);
      return { kind: "received", event, targets };
    });

    return transaction.immediate();
  }

  public findByEventId(eventId: string): DetectionEventRecord | undefined {
    return this.detectionRepository.findByEventId(eventId);
  }

  private targets(principalId: string): DetectionTarget[] {
    return this.mappingRepository
      .findForPrincipal(principalId)
      .map(({ serviceId, localUserId }) => ({
        serviceId: serviceId as DetectionTarget["serviceId"],
        localUserId,
      }));
  }
}
