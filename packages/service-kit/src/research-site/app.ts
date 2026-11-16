import { parse as parseCookie } from "cookie";
import express, {
  type CookieOptions,
  type Express,
  type Request,
} from "express";

import type { ResearchSiteContext } from "./runtime.js";
import type { DetectionNotifier } from "../detection-notification.js";
import { createSessionRevocationRouter } from "../session-revocation.js";
import { hashOpaqueToken, verifyPassword } from "./security.js";

const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: false,
} satisfies CookieOptions;

const DECOY_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/__research/decoy-use",
  secure: false,
} satisfies CookieOptions;

function formField(body: unknown, field: string): string | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const value = Reflect.get(body, field) as unknown;
  return typeof value === "string" ? value : undefined;
}

function readCookie(request: Request, name: string): string | undefined {
  if (request.headers.cookie === undefined) {
    return undefined;
  }

  try {
    return parseCookie(request.headers.cookie)[name];
  } catch {
    return undefined;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function loginPage(serviceName: string, error?: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(serviceName)} Login</title></head>
<body><main><h1>${escapeHtml(serviceName)}</h1><h2>Login</h2>
${error === undefined ? "" : `<p role="alert">${escapeHtml(error)}</p>`}
<form method="post" action="/login">
<label>Username <input name="username" autocomplete="username" required></label>
<label>Password <input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">Log in</button></form></main></body></html>`;
}

export function createResearchSiteApp(
  context: ResearchSiteContext,
  detectionNotifier?: DetectionNotifier,
  revocationAuthToken?: string,
): Express {
  const { definition } = context;
  const app = express();
  app.disable("x-powered-by");
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  if (revocationAuthToken !== undefined) {
    app.use(
      "/internal/v1/sessions/revoke",
      createSessionRevocationRouter(
        revocationAuthToken,
        context.sessionRevocationHandler,
      ),
    );
  }

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: definition.component.id });
  });

  app.get("/", (_request, response) => response.redirect("/login"));

  app.get("/login", (_request, response) => {
    response
      .set("Cache-Control", "no-store")
      .type("html")
      .send(loginPage(definition.component.name));
  });

  app.post("/login", async (request, response) => {
    const username = formField(request.body, "username")?.trim();
    const password = formField(request.body, "password");
    const user =
      username === undefined
        ? undefined
        : context.userRepository.findByUsername(username);
    const passwordHash = user?.passwordHash ?? context.fallbackPasswordHash;
    const matches =
      password !== undefined &&
      password.length <= 1024 &&
      (await verifyPassword(password, passwordHash));

    if (user === undefined || !matches) {
      response
        .status(401)
        .set("Cache-Control", "no-store")
        .type("html")
        .send(
          loginPage(
            definition.component.name,
            "Invalid username or password.",
          ),
        );
      return;
    }

    const artifacts = context.issueLoginArtifacts(user.id);
    response.cookie(
      definition.sessionCookieName,
      artifacts.sessionToken,
      SESSION_COOKIE_OPTIONS,
    );
    response.cookie(
      definition.decoyCookieName,
      artifacts.decoyToken,
      DECOY_COOKIE_OPTIONS,
    );
    response.redirect("/protected");
  });

  app.get("/protected", (request, response) => {
    const token = readCookie(request, definition.sessionCookieName);
    const session =
      token === undefined
        ? undefined
        : context.sessionRepository.findActiveWithUser(hashOpaqueToken(token));
    if (session === undefined) {
      response
        .status(401)
        .set("Cache-Control", "no-store")
        .type("text/plain")
        .send("Unauthorized");
      return;
    }

    response
      .set("Cache-Control", "no-store")
      .type("html")
      .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(definition.component.name)} Protected</title></head>
<body><main><h1>${escapeHtml(definition.component.name)}</h1>
<p>Logged in as ${escapeHtml(session.username)}</p>
<p>local user id: ${escapeHtml(session.userId)}</p>
<p>session status: ${session.status}</p>
<form method="post" action="/logout"><button type="submit">Log out</button></form>
</main></body></html>`);
  });

  app.get("/__research/decoy-use", async (request, response) => {
    response.set("Cache-Control", "no-store");
    const token = readCookie(request, definition.decoyCookieName);
    if (token === undefined) {
      response.status(400).json({
        detected: false,
        serviceId: definition.component.id,
        status: "missing_decoy_cookie",
      });
      return;
    }

    const outcome = context.decoyRepository.detectFirstUse(
      hashOpaqueToken(token),
    );
    if (outcome.kind === "not_found") {
      response.status(404).json({
        detected: false,
        serviceId: definition.component.id,
        status: "decoy_not_found",
      });
      return;
    }

    const notification =
      detectionNotifier === undefined
        ? undefined
        : await detectionNotifier({
            eventId: outcome.event.eventId,
            localUserId: outcome.event.userId,
            decoyId: outcome.event.decoyId,
            detectedAt: outcome.event.detectedAt,
          });
    if (notification !== undefined && !notification.ok) {
      console.error(
        `[${definition.component.id}] detection notification failed for event ${outcome.event.eventId}: ${notification.error}`,
      );
    }

    response.json({
      detected: outcome.kind === "detected",
      eventId: outcome.event.eventId,
      serviceId: definition.component.id,
      localUserId: outcome.event.userId,
      decoyId: outcome.event.decoyId,
      detectedAt: outcome.event.detectedAt,
      status:
        outcome.kind === "detected" ? "detected" : "already_detected",
      notificationStatus: notification?.ok === true ? "notified" : "failed",
    });
  });

  app.post("/logout", (request, response) => {
    const token = readCookie(request, definition.sessionCookieName);
    if (token !== undefined) {
      context.sessionRepository.revokeActiveByTokenHash(hashOpaqueToken(token));
    }

    response.clearCookie(definition.sessionCookieName, SESSION_COOKIE_OPTIONS);
    response.clearCookie(definition.decoyCookieName, DECOY_COOKIE_OPTIONS);
    response.redirect(303, "/login");
  });

  return app;
}
