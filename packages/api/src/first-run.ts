import { randomUUID } from "node:crypto";
import type { JanuaStore } from "@janua/core";
import type { ResolvedAdminKey } from "./config.js";
import type { AdminAccountSetupResult } from "./admin-auth.js";

export interface FirstRunOptions {
  publicBaseUrl: string;
  llmProvider: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  adminKey: ResolvedAdminKey;
  adminAccount?: AdminAccountSetupResult;
  production: boolean;
}

export interface FirstRunResult {
  siteToken: string;
  ollamaReachable?: boolean;
}

export async function runFirstRunSetup(store: JanuaStore, options: FirstRunOptions): Promise<FirstRunResult> {
  const siteToken = ensureSiteToken(store, options.production);
  const ollamaReachable =
    options.llmProvider === "ollama" ? await checkOllama(options.ollamaBaseUrl ?? "http://localhost:11434") : undefined;

  logStartupInstructions({
    ...options,
    siteToken,
    ollamaReachable,
  });

  return { siteToken, ollamaReachable };
}

function ensureSiteToken(store: JanuaStore, production: boolean): string {
  const current = store.getSetting("site_token");
  if (current) {
    if (production && current === "dev-site-token") {
      console.warn(
        "Janua warning: production is using the default dev-site-token. Rotate it from Admin Site Install after updating embedded widgets.",
      );
    }
    return current;
  }

  const next = production ? randomUUID() : (current ?? "dev-site-token");
  store.setSetting("site_token", next);
  return next;
}

async function checkOllama(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function logStartupInstructions(
  options: FirstRunOptions & { siteToken: string; ollamaReachable?: boolean },
): void {
  const adminUrl = `${options.publicBaseUrl}/admin`;
  const demoUrl = `${options.publicBaseUrl}/demo`;
  const embedCode = `<script src="${options.publicBaseUrl}/api/widget.js" data-token="${options.siteToken}" defer></script>`;

  console.log("");
  console.log("Janua is ready.");
  console.log(`Admin: ${adminUrl}`);
  console.log(`Demo chat: ${demoUrl}`);
  if (options.adminAccount) {
    console.log(`Admin password source: ${options.adminAccount.source}`);
  }
  console.log(`Admin API key source: ${options.adminKey.source}`);
  console.log(`Site token: ${options.siteToken}`);
  console.log(`Embed snippet: ${embedCode}`);
  if (options.llmProvider === "ollama") {
    console.log(
      options.ollamaReachable
        ? `Ollama reachable at ${options.ollamaBaseUrl}; model=${options.ollamaModel}`
        : `Ollama is not reachable at ${options.ollamaBaseUrl}. Start it and pull ${options.ollamaModel}.`,
    );
  }
  console.log("");
}
