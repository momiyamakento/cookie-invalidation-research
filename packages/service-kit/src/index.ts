import express, { type Express } from "express";

import type { Component } from "@cookie-research/protocol";

export { createResearchSiteApp } from "./research-site/app.js";
export {
  initializeResearchSiteContext,
  type LoginArtifacts,
  type ResearchSiteContext,
  type ResearchSiteDefinition,
} from "./research-site/runtime.js";
export { hashOpaqueToken } from "./research-site/security.js";
export { deriveBenchmarkToken } from "./benchmark-token.js";
export {
  createDetectionNotifier,
  sendDetectionNotification,
  type DetectionNotificationClientOptions,
  type DetectionNotificationClientResult,
  type DetectionNotifier,
  type DetectionNotifierConfig,
} from "./detection-notification.js";
export {
  registerMappingAfterStartup,
  registerServiceMapping,
  type MappingRegistrationInput,
  type MappingRegistrationOptions,
  type MappingRegistrationResult,
} from "./mapping-registration.js";
export {
  createSessionRevocationRouter,
  type InvalidationRequestRecord,
  type SessionRevocationHandler,
  type SessionRevocationHandlerResult,
} from "./session-revocation.js";

export function createHealthApp(component: Component): Express {
  const app = express();

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: component.id });
  });

  return app;
}

export function readPort(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${value}`);
  }

  return port;
}
