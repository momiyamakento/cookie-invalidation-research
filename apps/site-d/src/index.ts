import dotenv from "dotenv";
import { COMPONENTS } from "@cookie-research/protocol";
import { registerMappingAfterStartup } from "@cookie-research/service-kit";
import { createSiteDApp, SITE_D_USER } from "./app.js";
import { loadSiteDConfig } from "./config.js";
dotenv.config({ path: new URL("../../../.env", import.meta.url), quiet: true });
const config = loadSiteDConfig(); const context = await createSiteDApp(config.databasePath, config.seedPassword, config.managerRevocationToken);
const server = context.app.listen(config.port, () => { console.log(`${COMPONENTS.siteD.name} listening on http://localhost:${config.port}`); void registerMappingAfterStartup({ authToken: config.detectionAuthToken, managementBaseUrl: config.managementBaseUrl, principalId: config.principalId, serviceId: "site-d", localUserId: SITE_D_USER.id }); });
function shutdown() { server.close(() => context.database.close()); }
process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
