import type { Database } from "better-sqlite3";

import { openManagementDatabase } from "./db/database.js";
import { DetectionRepository } from "./db/repositories/detection-repository.js";
import { MappingRepository } from "./db/repositories/mapping-repository.js";
import { InvalidationJobRepository } from "./db/repositories/invalidation-job-repository.js";
import { ServiceRepository } from "./db/repositories/service-repository.js";
import { MappingService } from "./services/mapping-service.js";
import { DetectionService } from "./services/detection-service.js";

export interface ManagementContext {
  database: Database;
  detectionRepository: DetectionRepository;
  detectionService: DetectionService;
  invalidationJobRepository: InvalidationJobRepository;
  mappingRepository: MappingRepository;
  mappingService: MappingService;
  serviceRepository: ServiceRepository;
}

export function initializeManagementContext(
  databasePath: string,
): ManagementContext {
  const database = openManagementDatabase(databasePath);

  try {
    const serviceRepository = new ServiceRepository(database);
    const mappingRepository = new MappingRepository(database);
    const detectionRepository = new DetectionRepository(database);
    const invalidationJobRepository = new InvalidationJobRepository(database);
    serviceRepository.seedFixedServices();

    return {
      database,
      detectionRepository,
      detectionService: new DetectionService(
        database,
        detectionRepository,
        mappingRepository,
      ),
      invalidationJobRepository,
      mappingRepository,
      mappingService: new MappingService(
        mappingRepository,
        serviceRepository,
      ),
      serviceRepository,
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
