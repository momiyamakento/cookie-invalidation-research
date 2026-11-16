import dotenv from "dotenv";

import {
  createResearchSiteApp,
  createDetectionNotifier,
  initializeResearchSiteContext,
  registerMappingAfterStartup,
} from "@cookie-research/service-kit";

import { loadSiteBConfig, SITE_B_DEFINITION } from "./config.js";

dotenv.config({ path: new URL("../../../.env", import.meta.url), quiet: true });

const config = loadSiteBConfig();
const context = await initializeResearchSiteContext(
  SITE_B_DEFINITION,
  config.databasePath,
  config.seedPassword,
);
const app = createResearchSiteApp(
  context,
  createDetectionNotifier({
    authToken: config.detectionAuthToken,
    managementBaseUrl: config.managementBaseUrl,
    serviceId: "site-b",
  }),
  config.managerRevocationToken,
);

const server = app.listen(config.port, () => {
  console.log(
    `${SITE_B_DEFINITION.component.name} listening on http://localhost:${config.port}`,
  );
  void registerMappingAfterStartup({
    authToken: config.detectionAuthToken,
    managementBaseUrl: config.managementBaseUrl,
    principalId: config.principalId,
    serviceId: SITE_B_DEFINITION.component.id,
    localUserId: SITE_B_DEFINITION.localUserId,
  });
});

function shutdown(): void {
  server.close(() => context.database.close());
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
