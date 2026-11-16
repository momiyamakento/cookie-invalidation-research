import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { COMPONENTS } from "@cookie-research/protocol";
import { readPort } from "@cookie-research/service-kit";

import type { SiteTokens } from "./internal-auth.js";
import type { InvalidationStrategy, ManagerToSiteTokens } from "./services/invalidation-orchestrator.js";

export interface ManagementConfig {
  benchmarkSharedSecret?: string;
  databasePath: string;
  managerToSiteTokens: ManagerToSiteTokens;
  port: number;
  siteTokens: SiteTokens;
  invalidationStrategy: InvalidationStrategy;
}

function requireToken(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required.`);
  }
  return value;
}

export function loadManagementConfig(
  environment = process.env,
): ManagementConfig {
  const defaultDatabasePath = fileURLToPath(
    new URL("../data/management.sqlite", import.meta.url),
  );

  const siteTokens: SiteTokens = {
    "site-a": requireToken(
      "SITE_A_TO_MANAGER_TOKEN",
      environment.SITE_A_TO_MANAGER_TOKEN,
    ),
    "site-b": requireToken(
      "SITE_B_TO_MANAGER_TOKEN",
      environment.SITE_B_TO_MANAGER_TOKEN,
    ),
    "site-c": requireToken(
      "SITE_C_TO_MANAGER_TOKEN",
      environment.SITE_C_TO_MANAGER_TOKEN,
    ),
  };
  const siteDToManager = environment.SITE_D_TO_MANAGER_TOKEN?.trim();
  const managerToSiteD = environment.MANAGER_TO_SITE_D_TOKEN?.trim();
  if ((siteDToManager === undefined) !== (managerToSiteD === undefined)) {
    throw new Error("Site D tokens must be configured together.");
  }
  if (siteDToManager !== undefined) siteTokens["site-d"] = siteDToManager;
  if (new Set(Object.values(siteTokens)).size !== Object.keys(siteTokens).length) {
    throw new Error("Site-to-Management tokens must be unique per service.");
  }
  const managerToSiteTokens: ManagerToSiteTokens = {
    "site-a": requireToken(
      "MANAGER_TO_SITE_A_TOKEN",
      environment.MANAGER_TO_SITE_A_TOKEN,
    ),
    "site-b": requireToken(
      "MANAGER_TO_SITE_B_TOKEN",
      environment.MANAGER_TO_SITE_B_TOKEN,
    ),
    "site-c": requireToken(
      "MANAGER_TO_SITE_C_TOKEN",
      environment.MANAGER_TO_SITE_C_TOKEN,
    ),
  };
  if (managerToSiteD !== undefined) managerToSiteTokens["site-d"] = managerToSiteD;
  if (new Set(Object.values(managerToSiteTokens)).size !== Object.keys(managerToSiteTokens).length) {
    throw new Error("Management-to-Site tokens must be unique per service.");
  }
  if (
    Object.values(managerToSiteTokens).some((token) =>
      token !== undefined && Object.values(siteTokens).includes(token),
    )
  ) {
    throw new Error("Internal API tokens must be unique by communication direction.");
  }

  const benchmarkSharedSecret = environment.BENCHMARK_SHARED_SECRET?.trim() || undefined;
  const strategy = environment.INVALIDATION_STRATEGY?.trim() || "parallel";
  if (strategy !== "parallel" && strategy !== "sequential") throw new Error("INVALIDATION_STRATEGY must be parallel or sequential.");
  return {
    ...(benchmarkSharedSecret === undefined ? {} : { benchmarkSharedSecret }),
    databasePath:
      environment.MANAGEMENT_DB_PATH === undefined ||
      environment.MANAGEMENT_DB_PATH.trim() === ""
        ? defaultDatabasePath
        : resolve(environment.MANAGEMENT_DB_PATH),
    managerToSiteTokens,
    port: readPort(
      environment.MANAGEMENT_SERVER_PORT,
      COMPONENTS.managementServer.defaultPort,
    ),
    siteTokens,
    invalidationStrategy: strategy,
  };
}
