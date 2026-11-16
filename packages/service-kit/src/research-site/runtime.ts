import type { Database } from "better-sqlite3";

import type { Component } from "@cookie-research/protocol";

import { openResearchSiteDatabase } from "./database.js";
import { ResearchDecoyRepository } from "./repositories/decoy-repository.js";
import { ResearchSessionRepository } from "./repositories/session-repository.js";
import { ResearchUserRepository } from "./repositories/user-repository.js";
import {
  generateOpaqueToken,
  hashOpaqueToken,
  hashPassword,
} from "./security.js";
import { createResearchSiteSessionRevocationHandler } from "./session-revocation-handler.js";
import type { SessionRevocationHandler } from "../session-revocation.js";

export interface ResearchSiteDefinition {
  component: Component;
  decoyCookieName: string;
  localUserId: string;
  sessionCookieName: string;
  username: string;
}

export interface LoginArtifacts {
  decoyToken: string;
  sessionToken: string;
}

export interface ResearchSiteContext {
  database: Database;
  decoyRepository: ResearchDecoyRepository;
  definition: ResearchSiteDefinition;
  fallbackPasswordHash: string;
  issueLoginArtifacts: (userId: string) => LoginArtifacts;
  sessionRepository: ResearchSessionRepository;
  sessionRevocationHandler: SessionRevocationHandler;
  userRepository: ResearchUserRepository;
}

async function seedUser(
  repository: ResearchUserRepository,
  definition: ResearchSiteDefinition,
  seedPassword: string,
): Promise<string> {
  const existing = repository.findById(definition.localUserId);
  if (existing !== undefined) {
    if (existing.username !== definition.username) {
      throw new Error(
        `Seed user ${definition.localUserId} has an unexpected username.`,
      );
    }
    return existing.passwordHash;
  }

  repository.insertIfAbsent({
    id: definition.localUserId,
    username: definition.username,
    passwordHash: await hashPassword(seedPassword),
    createdAt: new Date().toISOString(),
  });
  const seeded = repository.findById(definition.localUserId);
  if (seeded === undefined) {
    throw new Error(`Failed to seed ${definition.component.id}.`);
  }
  return seeded.passwordHash;
}

export async function initializeResearchSiteContext(
  definition: ResearchSiteDefinition,
  databasePath: string,
  seedPassword: string,
): Promise<ResearchSiteContext> {
  const database = openResearchSiteDatabase(databasePath);

  try {
    const userRepository = new ResearchUserRepository(database);
    const sessionRepository = new ResearchSessionRepository(database);
    const decoyRepository = new ResearchDecoyRepository(database);
    const fallbackPasswordHash = await seedUser(
      userRepository,
      definition,
      seedPassword,
    );
    const issue = database.transaction((userId: string): LoginArtifacts => {
      const sessionToken = generateOpaqueToken();
      const decoyToken = generateOpaqueToken();
      sessionRepository.create(userId, hashOpaqueToken(sessionToken));
      decoyRepository.create(userId, hashOpaqueToken(decoyToken));
      return { sessionToken, decoyToken };
    });

    return {
      database,
      decoyRepository,
      definition,
      fallbackPasswordHash,
      issueLoginArtifacts: (userId) => issue.immediate(userId),
      sessionRepository,
      sessionRevocationHandler: createResearchSiteSessionRevocationHandler(database),
      userRepository,
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
