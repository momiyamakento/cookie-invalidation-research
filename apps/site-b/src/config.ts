import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { COMPONENTS } from "@cookie-research/protocol";
import {
  readPort,
  type ResearchSiteDefinition,
} from "@cookie-research/service-kit";

export const SITE_B_DEFINITION = {
  component: COMPONENTS.siteB,
  decoyCookieName: "decoy_site_b",
  localUserId: "user-b-018",
  sessionCookieName: "sid_site_b",
  username: "alice-b",
} satisfies ResearchSiteDefinition;

export interface SiteBConfig {
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

export function loadSiteBConfig(environment = process.env): SiteBConfig {
  const seedPassword = environment.SITE_B_SEED_PASSWORD;
  if (seedPassword === undefined || seedPassword.length < 12) {
    throw new Error(
      "SITE_B_SEED_PASSWORD is required and must contain at least 12 characters.",
    );
  }

  const defaultDatabasePath = fileURLToPath(
    new URL("../data/site-b.sqlite", import.meta.url),
  );
  return {
    detectionAuthToken: requireSetting(
      "SITE_B_TO_MANAGER_TOKEN",
      environment.SITE_B_TO_MANAGER_TOKEN,
    ),
    databasePath:
      environment.SITE_B_DB_PATH === undefined ||
      environment.SITE_B_DB_PATH.trim() === ""
        ? defaultDatabasePath
        : resolve(environment.SITE_B_DB_PATH),
    managementBaseUrl: requireManagementBaseUrl(
      environment.MANAGEMENT_BASE_URL,
    ),
    managerRevocationToken: requireSetting(
      "MANAGER_TO_SITE_B_TOKEN",
      environment.MANAGER_TO_SITE_B_TOKEN,
    ),
    port: readPort(environment.SITE_B_PORT, COMPONENTS.siteB.defaultPort),
    principalId: requireSetting(
      "SITE_B_PRINCIPAL_ID",
      environment.SITE_B_PRINCIPAL_ID,
    ),
    seedPassword,
  };
}
