import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_ADMIN_KEY } from "./admin-defaults.js";

export interface ResolveAdminKeyOptions {
  keyFile?: string;
}

export interface ResolvedAdminKey {
  key: string;
  source: "env" | "file" | "default";
}

export function resolveAdminKey(env: NodeJS.ProcessEnv, options: ResolveAdminKeyOptions = {}): ResolvedAdminKey {
  const key = env.ADMIN_API_KEY;
  if (key) {
    return { key, source: "env" };
  }

  if (options.keyFile) {
    if (existsSync(options.keyFile)) {
      const fileKey = readFileSync(options.keyFile, "utf8").trim();
      if (fileKey) {
        return { key: fileKey, source: "file" };
      }
    }
  }

  return { key: DEFAULT_ADMIN_KEY, source: "default" };
}
