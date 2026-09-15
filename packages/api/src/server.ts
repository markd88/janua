import { serve } from "@hono/node-server";
import { dirname } from "node:path";
import { cpus, totalmem } from "node:os";
import {
  FakeLLMProvider,
  OllamaProvider,
  OllamaRuntime,
  OpenAIProvider,
  SqliteStore,
  recommendOllamaModel,
  type JanuaStore,
  type LLMProvider,
} from "@janua/core";
import { loadAgentConfig, type ResolvedLlmConfig } from "./agent-config.js";
import { ensureAdminAccount } from "./admin-auth.js";
import { createApp } from "./app.js";
import { resolveAdminKey } from "./config.js";
import { runFirstRunSetup } from "./first-run.js";
import { parseAllowedOrigins } from "./security.js";

const port = Number(process.env.PORT ?? 3000);
const databasePath = process.env.JANUA_DB_PATH ?? "data/janua.db";
const dataDir = process.env.JANUA_DATA_DIR ?? dirname(databasePath);
const configDir = process.env.JANUA_CONFIG_DIR ?? "config";
const production = process.env.NODE_ENV === "production";
const store = await SqliteStore.create({ filename: databasePath, seedDefaultSiteToken: !production });
const agentConfig = loadAgentConfig({ configDir });
const llmConfig = agentConfig.llm;
const llm = createLLMProvider(llmConfig);
const ollamaRuntime = createOllamaRuntime(llmConfig);
const hardwareRecommendation = detectHardwareRecommendation();
const adminKey = resolveAdminKey(process.env, { keyFile: process.env.JANUA_ADMIN_KEY_FILE ?? `${dataDir}/admin-key` });
const allowedOrigins = parseAllowedOrigins(process.env.JANUA_ALLOWED_ORIGINS);
const rateLimit = {
  enabled: process.env.JANUA_RATE_LIMIT_ENABLED !== "false",
  windowMs: Number(process.env.JANUA_RATE_LIMIT_WINDOW_MS ?? 60_000),
  max: Number(process.env.JANUA_RATE_LIMIT_MAX ?? 60),
  trustProxy: process.env.JANUA_TRUST_PROXY === "true",
  maxBuckets: Number(process.env.JANUA_RATE_LIMIT_MAX_BUCKETS ?? 10_000),
};
const adminRateLimit = {
  ...rateLimit,
  max: Number(process.env.JANUA_ADMIN_RATE_LIMIT_MAX ?? 120),
};
const chatRateLimit = {
  ...rateLimit,
  windowMs: Number(process.env.JANUA_CHAT_RATE_LIMIT_WINDOW_MS ?? rateLimit.windowMs),
  max: Number(process.env.JANUA_CHAT_RATE_LIMIT_MAX ?? Math.min(rateLimit.max, 10)),
};
const publicBaseUrl = (process.env.JANUA_PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const adminAccount = ensureAdminAccount(store, {
  configuredPassword: agentConfig.admin.password,
});

await runFirstRunSetup(store, {
  publicBaseUrl,
  llmProvider: llmConfig.provider,
  ollamaBaseUrl: llmConfig.ollamaBaseUrl,
  ollamaModel: llmConfig.ollamaModel,
  adminKey,
  adminAccount,
  production,
});
startConversationCleanup(store);

serve(
  {
    fetch: createApp({
      store,
      llm,
      adminKey: adminKey.key,
      allowedOrigins,
      rateLimit,
      chatRateLimit,
      adminRateLimit,
      agentConfig,
    }).fetch,
    port,
  },
  (info) => {
    console.log(`Janua API listening on http://localhost:${info.port}`);
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "agent.config",
      source: agentConfig.sourcePath ?? "env/defaults",
      provider: agentConfig.llm.provider,
    }));
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", event: "hardware.recommendation", ...hardwareRecommendation }));
    if (ollamaRuntime && process.env.JANUA_OLLAMA_PREWARM !== "false") {
      void ollamaRuntime.prewarm().then((result) => {
        console.log(JSON.stringify({ ts: new Date().toISOString(), level: result.ok ? "info" : "error", event: "ollama.prewarm", ...result }));
      });
    }
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        event: "admin.auth",
        source: adminAccount.source,
      }),
    );
  },
);

function createLLMProvider(config: ResolvedLlmConfig): LLMProvider {
  if (config.provider === "ollama") {
    return new OllamaProvider({
      baseUrl: config.ollamaBaseUrl,
      model: config.ollamaModel,
    });
  }
  if (config.provider === "openai") {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required when the OpenAI provider is selected");
    }
    return new OpenAIProvider({
      apiKey: process.env.OPENAI_API_KEY,
      model: config.openaiModel,
      baseUrl: config.openaiBaseUrl,
    });
  }
  return new FakeLLMProvider();
}

function createOllamaRuntime(config: ResolvedLlmConfig): OllamaRuntime | undefined {
  if (config.provider !== "ollama") return undefined;
  return new OllamaRuntime({
    baseUrl: config.ollamaBaseUrl,
    model: config.ollamaModel,
  });
}

function detectHardwareRecommendation() {
  const profile = {
    cpuCount: Math.max(cpus().length, 1),
    totalMemoryGb: Number((totalmem() / 1024 / 1024 / 1024).toFixed(1)),
  };
  return {
    profile,
    recommendation: recommendOllamaModel(profile),
  };
}

function startConversationCleanup(store: JanuaStore): void {
  if (process.env.JANUA_CONVERSATION_CLEANUP_ENABLED === "false") return;
  runConversationCleanup(store);

  const intervalMs = Number(process.env.JANUA_CONVERSATION_CLEANUP_INTERVAL_MS ?? 60 * 60 * 1000);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;

  const timer = setInterval(() => runConversationCleanup(store), intervalMs);
  timer.unref?.();
}

function runConversationCleanup(store: JanuaStore): void {
  const result = store.cleanupExpiredConversations(new Date());
  const adminSessionsDeleted = store.cleanupExpiredAdminSessions(new Date());
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "conversation.cleanup",
      ...result,
      adminSessionsDeleted,
    }),
  );
}
