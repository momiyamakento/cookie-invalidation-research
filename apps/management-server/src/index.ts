import dotenv from "dotenv";

import { COMPONENTS } from "@cookie-research/protocol";

import { createManagementApp } from "./app.js";
import { loadManagementConfig } from "./config.js";
import { initializeManagementContext } from "./management-context.js";
import { SiteTokenAuthenticator } from "./internal-auth.js";
import { createSiteRevocationClient } from "./site-revocation-client.js";
import { InvalidationOrchestrator } from "./services/invalidation-orchestrator.js";

dotenv.config({ path: new URL("../../../.env", import.meta.url), quiet: true });

const component = COMPONENTS.managementServer;
const config = loadManagementConfig();
const context = initializeManagementContext(config.databasePath);
const invalidationOrchestrator = new InvalidationOrchestrator(
  context.database,
  context.detectionRepository,
  context.invalidationJobRepository,
  context.serviceRepository,
  config.managerToSiteTokens,
  createSiteRevocationClient(),
  config.benchmarkSharedSecret,
  config.invalidationStrategy,
);
const app = createManagementApp(context.mappingService, {
  authenticator: new SiteTokenAuthenticator(config.siteTokens, config.benchmarkSharedSecret),
  detectionService: context.detectionService,
  invalidationOrchestrator,
});

const server = app.listen(config.port, () => {
  console.log(`${component.name} listening on http://localhost:${config.port}`);
});

function shutdown(): void {
  server.close(() => {
    context.database.close();
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
