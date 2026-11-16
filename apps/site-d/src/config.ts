import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPONENTS } from "@cookie-research/protocol";
import { readPort } from "@cookie-research/service-kit";

export interface SiteDConfig { detectionAuthToken: string; databasePath: string; managementBaseUrl: string; managerRevocationToken: string; port: number; principalId: string; seedPassword: string; }
function required(name: string, value: string | undefined): string { if (value === undefined || value.trim() === "") throw new Error(`${name} is required.`); return value.trim(); }
export function loadSiteDConfig(environment = process.env): SiteDConfig {
  const managementBaseUrl = new URL(required("MANAGEMENT_BASE_URL", environment.MANAGEMENT_BASE_URL));
  if (!['http:', 'https:'].includes(managementBaseUrl.protocol)) throw new Error("MANAGEMENT_BASE_URL must use http or https.");
  const seedPassword = environment.SITE_D_SEED_PASSWORD;
  if (seedPassword === undefined || seedPassword.length < 12) throw new Error("SITE_D_SEED_PASSWORD is required and must contain at least 12 characters.");
  return {
    detectionAuthToken: required("SITE_D_TO_MANAGER_TOKEN", environment.SITE_D_TO_MANAGER_TOKEN),
    databasePath: environment.SITE_D_DB_PATH?.trim() ? resolve(environment.SITE_D_DB_PATH) : fileURLToPath(new URL("../data/site-d.sqlite", import.meta.url)),
    managementBaseUrl: managementBaseUrl.toString().replace(/\/$/u, ""),
    managerRevocationToken: required("MANAGER_TO_SITE_D_TOKEN", environment.MANAGER_TO_SITE_D_TOKEN),
    port: readPort(environment.SITE_D_PORT, COMPONENTS.siteD.defaultPort),
    principalId: required("SITE_D_PRINCIPAL_ID", environment.SITE_D_PRINCIPAL_ID),
    seedPassword,
  };
}
