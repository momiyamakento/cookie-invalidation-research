import type { Database } from "better-sqlite3";
import type { SessionRevocationHandler } from "@cookie-research/service-kit";

import { openSiteADatabase } from "./db/database.js";
import { DecoyRepository } from "./db/repositories/decoy-repository.js";
import { SessionRepository } from "./db/repositories/session-repository.js";
import { UserRepository } from "./db/repositories/user-repository.js";
import {
  generateDecoyToken,
  hashDecoyToken,
} from "./security/decoy-token.js";
import { hashPassword } from "./security/password.js";
import {
  generateSessionToken,
  hashSessionToken,
} from "./security/session-token.js";
import { createSiteASessionRevocationHandler } from "./session-revocation-handler.js";

export const EXPERIMENT_USER = {
  id: "user-a-001",
  username: "alice-a",
} as const;

export interface SiteAContext {
  database: Database;
  decoyRepository: DecoyRepository;
  fallbackPasswordHash: string;
  issueLoginArtifacts: (userId: string) => LoginArtifacts;
  sessionRepository: SessionRepository;
  sessionRevocationHandler: SessionRevocationHandler;
  userRepository: UserRepository;
}

export interface LoginArtifacts {
  decoyToken: string;
  sessionToken: string;
}

async function seedExperimentUser(
  userRepository: UserRepository,
  seedPassword: string,
): Promise<string> {
  const existing = userRepository.findById(EXPERIMENT_USER.id);
  if (existing !== undefined) {
    if (existing.username !== EXPERIMENT_USER.username) {
      throw new Error(
        `Seed user ${EXPERIMENT_USER.id} exists with an unexpected username.`,
      );
    }

    return existing.passwordHash;
  }

  const passwordHash = await hashPassword(seedPassword);
  userRepository.insertIfAbsent({
    ...EXPERIMENT_USER,
    passwordHash,
    createdAt: new Date().toISOString(),
  });

  const seeded = userRepository.findById(EXPERIMENT_USER.id);
  if (seeded === undefined) {
    throw new Error("Failed to seed the Site A experiment user.");
  }

  return seeded.passwordHash;
}

export async function initializeSiteAContext(
  databasePath: string,
  seedPassword: string,
): Promise<SiteAContext> {
  const database = openSiteADatabase(databasePath);

  try {
    const userRepository = new UserRepository(database);
    const sessionRepository = new SessionRepository(database);
    const decoyRepository = new DecoyRepository(database);
    const fallbackPasswordHash = await seedExperimentUser(
      userRepository,
      seedPassword,
    );

    const issueLoginArtifactsTransaction = database.transaction(
      (userId: string): LoginArtifacts => {
        const sessionToken = generateSessionToken();
        const decoyToken = generateDecoyToken();
        sessionRepository.create(userId, hashSessionToken(sessionToken));
        decoyRepository.create(userId, hashDecoyToken(decoyToken));

        return { sessionToken, decoyToken };
      },
    );

    return {
      database,
      decoyRepository,
      fallbackPasswordHash,
      issueLoginArtifacts: (userId) =>
        issueLoginArtifactsTransaction.immediate(userId),
      sessionRepository,
      sessionRevocationHandler: createSiteASessionRevocationHandler(database),
      userRepository,
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
