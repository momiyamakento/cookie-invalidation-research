import { fileURLToPath } from "node:url";

import { COMPONENTS } from "@cookie-research/protocol";
import {
  createHealthApp,
  createSessionRevocationRouter,
  type DetectionNotifier,
  type SessionRevocationHandler,
} from "@cookie-research/service-kit";
import type { Database } from "better-sqlite3";
import { parse as parseCookie } from "cookie";
import express, { type CookieOptions, type Request } from "express";

import type { DecoyRepository } from "./db/repositories/decoy-repository.js";
import type { SessionRepository } from "./db/repositories/session-repository.js";
import type { UserRepository } from "./db/repositories/user-repository.js";
import { hashDecoyToken } from "./security/decoy-token.js";
import { verifyPassword } from "./security/password.js";
import { hashSessionToken } from "./security/session-token.js";
import type { LoginArtifacts } from "./site-a-context.js";

export const SESSION_COOKIE_NAME = "sid_site_a";
export const DECOY_COOKIE_NAME = "decoy_site_a";

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: false,
} satisfies CookieOptions;

export const DECOY_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/__research/decoy-use",
  secure: false,
} satisfies CookieOptions;

interface SiteAAppDependencies {
  database: Database;
  decoyRepository: DecoyRepository;
  fallbackPasswordHash: string;
  issueLoginArtifacts: (userId: string) => LoginArtifacts;
  sessionRepository: SessionRepository;
  userRepository: UserRepository;
  detectionNotifier?: DetectionNotifier;
  revocationAuthToken?: string;
  sessionRevocationHandler?: SessionRevocationHandler;
}

function formField(body: unknown, field: string): string | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }

  const value = Reflect.get(body, field) as unknown;
  return typeof value === "string" ? value : undefined;
}

function readCookie(request: Request, cookieName: string): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (cookieHeader === undefined) {
    return undefined;
  }

  try {
    return parseCookie(cookieHeader)[cookieName];
  } catch {
    return undefined;
  }
}

export function createSiteAApp(dependencies: SiteAAppDependencies) {
  const app = createHealthApp(COMPONENTS.siteA);
  app.disable("x-powered-by");
  app.set("view engine", "ejs");
  app.set("views", fileURLToPath(new URL("./views", import.meta.url)));
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  if (
    dependencies.revocationAuthToken !== undefined &&
    dependencies.sessionRevocationHandler !== undefined
  ) {
    app.use(
      "/internal/v1/sessions/revoke",
      createSessionRevocationRouter(
        dependencies.revocationAuthToken,
        dependencies.sessionRevocationHandler,
      ),
    );
  }

  app.get("/", (_request, response) => {
    response.redirect("/login");
  });

  app.get("/login", (_request, response) => {
    response.set("Cache-Control", "no-store");
    response.render("login", { error: null });
  });

  app.post("/login", async (request, response) => {
    const username = formField(request.body, "username")?.trim();
    const password = formField(request.body, "password");
    const user =
      username === undefined
        ? undefined
        : dependencies.userRepository.findByUsername(username);
    const passwordHash = user?.passwordHash ?? dependencies.fallbackPasswordHash;
    const passwordMatches =
      password !== undefined &&
      password.length <= 1024 &&
      (await verifyPassword(password, passwordHash));

    if (user === undefined || !passwordMatches) {
      response.status(401).set("Cache-Control", "no-store").render("login", {
        error: "Invalid username or password.",
      });
      return;
    }

    const { sessionToken, decoyToken } =
      dependencies.issueLoginArtifacts(user.id);
    response.cookie(
      SESSION_COOKIE_NAME,
      sessionToken,
      SESSION_COOKIE_OPTIONS,
    );
    response.cookie(DECOY_COOKIE_NAME, decoyToken, DECOY_COOKIE_OPTIONS);
    response.redirect("/protected");
  });

  app.get("/protected", (request, response) => {
    const token = readCookie(request, SESSION_COOKIE_NAME);
    const session =
      token === undefined
        ? undefined
        : dependencies.sessionRepository.findActiveWithUser(
            hashSessionToken(token),
          );

    if (session === undefined) {
      response
        .status(401)
        .set("Cache-Control", "no-store")
        .type("text/plain")
        .send("Unauthorized");
      return;
    }

    response.set("Cache-Control", "no-store").render("protected", { session });
  });

  app.get("/__research/decoy-use", async (request, response) => {
    response.set("Cache-Control", "no-store");
    const token = readCookie(request, DECOY_COOKIE_NAME);
    if (token === undefined) {
      response.status(400).json({
        detected: false,
        serviceId: COMPONENTS.siteA.id,
        status: "missing_decoy_cookie",
      });
      return;
    }

    const outcome = dependencies.decoyRepository.detectFirstUse(
      hashDecoyToken(token),
    );
    if (outcome.kind === "not_found") {
      response.status(404).json({
        detected: false,
        serviceId: COMPONENTS.siteA.id,
        status: "decoy_not_found",
      });
      return;
    }

    const notification =
      dependencies.detectionNotifier === undefined
        ? undefined
        : await dependencies.detectionNotifier({
            eventId: outcome.event.eventId,
            localUserId: outcome.event.userId,
            decoyId: outcome.event.decoyId,
            detectedAt: outcome.event.detectedAt,
          });
    if (notification !== undefined && !notification.ok) {
      console.error(
        `[site-a] detection notification failed for event ${outcome.event.eventId}: ${notification.error}`,
      );
    }

    response.json({
      detected: outcome.kind === "detected",
      eventId: outcome.event.eventId,
      serviceId: COMPONENTS.siteA.id,
      localUserId: outcome.event.userId,
      decoyId: outcome.event.decoyId,
      detectedAt: outcome.event.detectedAt,
      status:
        outcome.kind === "detected" ? "detected" : "already_detected",
      notificationStatus: notification?.ok === true ? "notified" : "failed",
    });
  });

  app.post("/logout", (request, response) => {
    const token = readCookie(request, SESSION_COOKIE_NAME);
    if (token !== undefined) {
      dependencies.sessionRepository.revokeActiveByTokenHash(
        hashSessionToken(token),
      );
    }

    response.clearCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
    response.clearCookie(DECOY_COOKIE_NAME, DECOY_COOKIE_OPTIONS);
    response.redirect(303, "/login");
  });

  return app;
}
