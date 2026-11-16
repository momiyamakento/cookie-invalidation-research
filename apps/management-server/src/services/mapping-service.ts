import type {
  MappingIdentity,
  MappingRecord,
  MappingRegistrationResult,
  MappingRepository,
} from "../db/repositories/mapping-repository.js";
import type { ServiceRepository } from "../db/repositories/service-repository.js";
import type { BenchmarkServiceId } from "@cookie-research/protocol";

export type RegisterMappingResult =
  | MappingRegistrationResult
  | { kind: "service_not_found" };

export class MappingService {
  public constructor(
    private readonly mappingRepository: MappingRepository,
    private readonly serviceRepository: ServiceRepository,
  ) {}

  public register(identity: MappingIdentity): RegisterMappingResult {
    if (this.serviceRepository.findById(identity.serviceId) === undefined) {
      return { kind: "service_not_found" };
    }

    return this.mappingRepository.register(identity);
  }

  public registerBenchmark(
    serviceId: BenchmarkServiceId,
    baseUrl: string,
    identity: MappingIdentity,
  ): RegisterMappingResult {
    this.serviceRepository.registerBenchmark(serviceId, baseUrl);
    return this.mappingRepository.register(identity);
  }

  public findForPrincipal(principalId: string): MappingRecord[] {
    return this.mappingRepository.findForPrincipal(principalId);
  }

  public findPrincipalByServiceUser(
    serviceId: string,
    localUserId: string,
  ): string | undefined {
    return this.mappingRepository.findPrincipalByServiceUser(
      serviceId,
      localUserId,
    );
  }
}
