import dotenv from "dotenv";

import {
  createResearchSiteApp,
  createDetectionNotifier,
  initializeResearchSiteContext,
  registerMappingAfterStartup,
} from "@cookie-research/service-kit";

import { loadSiteCConfig, SITE_C_DEFINITION } from "./config.js";

dotenv.config({ path: new URL("../../../.env", import.meta.url), quiet: true });

const config = loadSiteCConfig();
const context = await initializeResearchSiteContext(
  SITE_C_DEFINITION,
  config.databasePath,
  config.seedPassword,
);
const app = createResearchSiteApp(
  context,
  createDetectionNotifier({
    authToken: config.detectionAuthToken,
    managementBaseUrl: config.managementBaseUrl,
    serviceId: "site-c",
  }),
  config.managerRevocationToken,
);

const server = app.listen(config.port, () => {
  console.log(
    `${SITE_C_DEFINITION.component.name} listening on http://localhost:${config.port}`,
  );
  void registerMappingAfterStartup({
    authToken: config.detectionAuthToken,
    managementBaseUrl: config.managementBaseUrl,
    principalId: config.principalId,
    serviceId: SITE_C_DEFINITION.component.id,
    localUserId: SITE_C_DEFINITION.localUserId,
  });
});

function shutdown(): void {
  server.close(() => context.database.close());
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
