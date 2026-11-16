import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { COMPONENTS } from "@cookie-research/protocol";
import {
  readPort,
  type ResearchSiteDefinition,
} from "@cookie-research/service-kit";

export const SITE_C_DEFINITION = {
  component: COMPONENTS.siteC,
  decoyCookieName: "decoy_site_c",
  localUserId: "user-c-105",
  sessionCookieName: "sid_site_c",
  username: "alice-c",
} satisfies ResearchSiteDefinition;

export interface SiteCConfig {
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

export function loadSiteCConfig(environment = process.env): SiteCConfig {
  const seedPassword = environment.SITE_C_SEED_PASSWORD;
  if (seedPassword === undefined || seedPassword.length < 12) {
    throw new Error(
      "SITE_C_SEED_PASSWORD is required and must contain at least 12 characters.",
    );
  }

  const defaultDatabasePath = fileURLToPath(
    new URL("../data/site-c.sqlite", import.meta.url),
  );
  return {
    detectionAuthToken: requireSetting(
      "SITE_C_TO_MANAGER_TOKEN",
      environment.SITE_C_TO_MANAGER_TOKEN,
    ),
    databasePath:
      environment.SITE_C_DB_PATH === undefined ||
      environment.SITE_C_DB_PATH.trim() === ""
        ? defaultDatabasePath
        : resolve(environment.SITE_C_DB_PATH),
    managementBaseUrl: requireManagementBaseUrl(
      environment.MANAGEMENT_BASE_URL,
    ),
    managerRevocationToken: requireSetting(
      "MANAGER_TO_SITE_C_TOKEN",
      environment.MANAGER_TO_SITE_C_TOKEN,
    ),
    port: readPort(environment.SITE_C_PORT, COMPONENTS.siteC.defaultPort),
    principalId: requireSetting(
      "SITE_C_PRINCIPAL_ID",
      environment.SITE_C_PRINCIPAL_ID,
    ),
    seedPassword,
  };
}
