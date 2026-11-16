import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Express } from "express";
import type { Database } from "better-sqlite3";
import { createDetectionNotifier, createResearchSiteApp, initializeResearchSiteContext } from "@cookie-research/service-kit";
import { createManagementApp } from "../../apps/management-server/src/app.js";
import { initializeManagementContext } from "../../apps/management-server/src/management-context.js";
import { SiteTokenAuthenticator } from "../../apps/management-server/src/internal-auth.js";
import { InvalidationOrchestrator } from "../../apps/management-server/src/services/invalidation-orchestrator.js";
import { createSiteRevocationClient } from "../../apps/management-server/src/site-revocation-client.js";
import { createSiteAApp } from "../../apps/site-a/src/app.js";
import { initializeSiteAContext } from "../../apps/site-a/src/site-a-context.js";
import { SITE_B_DEFINITION } from "../../apps/site-b/src/config.js";
import { SITE_C_DEFINITION } from "../../apps/site-c/src/config.js";
import { createSiteDApp } from "../../apps/site-d/src/app.js";
import { loadDemoConfig } from "../../apps/demo/src/config.js";
import { createDemoApp } from "../../apps/demo/src/app.js";

/** Real HTTP servers and real SQLite stores; no mocked detection or revocation. */
export async function startDemoSystem() {
  const directory = mkdtempSync(join(tmpdir(), "cookie-demo-test-"));
  const databases: Database[] = [];
  const servers: Array<ReturnType<Express["listen"]>> = [];
  const close = async () => {
    await Promise.all(servers.map(async (s) => await new Promise<void>((resolve, reject) => s.close((e) => e ? reject(e) : resolve()))));
    databases.reverse().forEach((db) => db.close());
    rmSync(directory, { recursive: true, force: true });
  };
  const listen = async (app: Express) => await new Promise<string>((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") { reject(new Error("Missing address")); return; }
      servers.push(server); resolve(`http://127.0.0.1:${address.port}`);
    });
    server.once("error", reject);
  });
  try {
    const password = "demo-test-password-123";
    const config = loadDemoConfig({ SITE_A_SEED_PASSWORD: password, SITE_B_SEED_PASSWORD: password, SITE_C_SEED_PASSWORD: password, SITE_D_SEED_PASSWORD: password });
    const manager = initializeManagementContext(join(directory, "manager.sqlite")); databases.push(manager.database);
    const tokens = { "site-a": "demo-ma", "site-b": "demo-mb", "site-c": "demo-mc", "site-d": "demo-md" };
    const notifierTokens = { "site-a": "demo-am", "site-b": "demo-bm", "site-c": "demo-cm", "site-d": "demo-dm" };
    config.managementAuthTokens = notifierTokens;
    const orchestrator = new InvalidationOrchestrator(manager.database, manager.detectionRepository, manager.invalidationJobRepository, manager.serviceRepository, tokens, createSiteRevocationClient());
    config.managementBaseUrl = await listen(createManagementApp(manager.mappingService, {
      authenticator: new SiteTokenAuthenticator(notifierTokens), detectionService: manager.detectionService, invalidationOrchestrator: orchestrator,
    }));
    const a = await initializeSiteAContext(join(directory, "a.sqlite"), password); databases.push(a.database);
    const notifier = createDetectionNotifier({ serviceId: "site-a", managementBaseUrl: config.managementBaseUrl, authToken: notifierTokens["site-a"] });
    const apps: Express[] = [createSiteAApp({ ...a, detectionNotifier: notifier, revocationAuthToken: tokens["site-a"] })];
    for (const definition of [SITE_B_DEFINITION, SITE_C_DEFINITION]) {
      const context = await initializeResearchSiteContext(definition, join(directory, `${definition.component.id}.sqlite`), password); databases.push(context.database);
      apps.push(createResearchSiteApp(context, createDetectionNotifier({ serviceId: definition.component.id, managementBaseUrl: config.managementBaseUrl, authToken: notifierTokens[definition.component.id] }), tokens[definition.component.id]));
    }
    const d = await createSiteDApp(join(directory, "d.sqlite"), password, tokens["site-d"]); databases.push(d.database); apps.push(d.app);
    for (const [index, site] of config.sites.entries()) {
      site.baseUrl = await listen(apps[index]!);
      manager.database.prepare("UPDATE services SET base_url = ? WHERE id = ?").run(site.baseUrl, site.id);
      manager.mappingService.register({ principalId: "demo-principal-001", serviceId: site.id, localUserId: site.localUserId });
    }
    const demo = createDemoApp(config);
    const baseUrl = await listen(demo);
    return { demo, baseUrl, config, manager, close };
  } catch (error) { await close(); throw error; }
}
