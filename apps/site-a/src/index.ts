import dotenv from "dotenv";

import { COMPONENTS } from "@cookie-research/protocol";
import {
  createDetectionNotifier,
  registerMappingAfterStartup,
} from "@cookie-research/service-kit";

import { createSiteAApp } from "./app.js";
import { loadSiteAConfig } from "./config.js";
import {
  EXPERIMENT_USER,
  initializeSiteAContext,
} from "./site-a-context.js";

dotenv.config({ path: new URL("../../../.env", import.meta.url), quiet: true });

const component = COMPONENTS.siteA;
const config = loadSiteAConfig();
const context = await initializeSiteAContext(
  config.databasePath,
  config.seedPassword,
);
const app = createSiteAApp({
  ...context,
  detectionNotifier: createDetectionNotifier({
    authToken: config.detectionAuthToken,
    managementBaseUrl: config.managementBaseUrl,
    serviceId: "site-a",
  }),
  revocationAuthToken: config.managerRevocationToken,
});

const server = app.listen(config.port, () => {
  console.log(`${component.name} listening on http://localhost:${config.port}`);
  void registerMappingAfterStartup({
    authToken: config.detectionAuthToken,
    managementBaseUrl: config.managementBaseUrl,
    principalId: config.principalId,
    serviceId: component.id,
    localUserId: EXPERIMENT_USER.id,
  });
});

function shutdown(): void {
  server.close(() => {
    context.database.close();
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
