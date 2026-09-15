import type { AdminSession, JanuaStore } from "@janua/core";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { DEFAULT_ADMIN_KEY } from "./admin-defaults.js";

export const ADMIN_SESSION_COOKIE = "janua_admin_session";
export const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ADMIN_USERNAME = "admin";

const SCRYPT_KEY_LENGTH = 64;

export interface EnsureAdminAccountOptions {
  configuredPassword?: string;
  env?: NodeJS.ProcessEnv;
}

export interface AdminAccountSetupResult {
  username: string;
  source: "existing" | "env-password" | "env-hash" | "config-password" | "default";
}

export function ensureAdminAccount(store: JanuaStore, options: EnsureAdminAccountOptions): AdminAccountSetupResult {
  const env = options.env ?? process.env;
  const username = ADMIN_USERNAME;
  const now = new Date().toISOString();
  const envPassword = env.JANUA_ADMIN_PASSWORD?.trim();
  const envHash = env.JANUA_ADMIN_PASSWORD_HASH?.trim();
  if (envHash) {
    store.upsertAdminUser({ username, passwordHash: envHash, createdAt: now, updatedAt: now });
    return { username, source: "env-hash" };
  }
  if (envPassword) {
    store.upsertAdminUser({ username, passwordHash: hashPassword(envPassword), createdAt: now, updatedAt: now });
    return { username, source: "env-password" };
  }

  const configuredPassword = options.configuredPassword?.trim();
  if (configuredPassword) {
    store.upsertAdminUser({ username, passwordHash: hashPassword(configuredPassword), createdAt: now, updatedAt: now });
    return { username, source: "config-password" };
  }

  const existing = store.getAdminUser(username);
  if (existing) return { username, source: "existing" };

  store.upsertAdminUser({ username, passwordHash: hashPassword(DEFAULT_ADMIN_KEY), createdAt: now, updatedAt: now });
  return { username, source: "default" };
}

export function createAdminSession(store: JanuaStore, username: string, now = new Date()): { session: AdminSession; token: string } {
  const token = randomBytes(32).toString("base64url");
  const session: AdminSession = {
    id: randomUUID(),
    tokenHash: hashSessionToken(token),
    username,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ADMIN_SESSION_TTL_MS).toISOString(),
    lastSeenAt: now.toISOString(),
  };
  store.createAdminSession(session);
  return { session, token };
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString("base64url");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [scheme, salt, expected] = encoded.split(":");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const actual = scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  const expectedBuffer = Buffer.from(expected, "base64url");
  if (actual.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actual, expectedBuffer);
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
