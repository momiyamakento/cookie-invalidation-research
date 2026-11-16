import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { COMPONENTS } from "@cookie-research/protocol";
import { readPort } from "@cookie-research/service-kit";

export interface SiteAConfig {
  detectionAuthToken: string;
  databasePath: string;
  managementBaseUrl: string;
  managerRevocationToken: string;
  port: number;
  principalId: string;
  seedPassword: string;
}

function requireSetting(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function requireManagementBaseUrl(value: string | undefined): string {
  const configured = requireSetting("MANAGEMENT_BASE_URL", value);
  const url = new URL(configured);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MANAGEMENT_BASE_URL must use http or https.");
  }
  return url.toString().replace(/\/$/u, "");
}

function requireSeedPassword(value: string | undefined): string {
  if (value === undefined || value.length < 12) {
    throw new Error(
      "SITE_A_SEED_PASSWORD is required and must contain at least 12 characters.",
    );
  }

  return value;
}

export function loadSiteAConfig(environment = process.env): SiteAConfig {
  const defaultDatabasePath = fileURLToPath(
    new URL("../data/site-a.sqlite", import.meta.url),
  );

  return {
    detectionAuthToken: requireSetting(
      "SITE_A_TO_MANAGER_TOKEN",
      environment.SITE_A_TO_MANAGER_TOKEN,
    ),
    databasePath:
      environment.SITE_A_DB_PATH === undefined ||
      environment.SITE_A_DB_PATH.trim() === ""
        ? defaultDatabasePath
        : resolve(environment.SITE_A_DB_PATH),
    managementBaseUrl: requireManagementBaseUrl(
      environment.MANAGEMENT_BASE_URL,
    ),
    managerRevocationToken: requireSetting(
      "MANAGER_TO_SITE_A_TOKEN",
      environment.MANAGER_TO_SITE_A_TOKEN,
    ),
    port: readPort(environment.SITE_A_PORT, COMPONENTS.siteA.defaultPort),
    principalId: requireSetting(
      "SITE_A_PRINCIPAL_ID",
      environment.SITE_A_PRINCIPAL_ID,
    ),
    seedPassword: requireSeedPassword(environment.SITE_A_SEED_PASSWORD),
  };
}
