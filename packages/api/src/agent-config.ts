import {
  DEFAULT_PROMPT_TEMPLATES,
  type PromptTemplates,
} from "@janua/core";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type LlmProviderName = "fake" | "ollama" | "openai";

export interface ResolvedLlmConfig {
  provider: LlmProviderName;
  ollamaBaseUrl: string;
  ollamaModel: string;
  openaiBaseUrl: string;
  openaiModel: string;
}

export interface AgentRuntimeConfig {
  sourcePath?: string;
  admin: {
    password: string;
  };
  llm: ResolvedLlmConfig;
  leadCapture: {
    triggerWords: string[];
    webhookUrl: string;
  };
  prompts: PromptTemplates;
}

interface LoadAgentConfigOptions {
  configDir: string;
  env?: NodeJS.ProcessEnv;
}

export function loadAgentConfig(options: LoadAgentConfigOptions): AgentRuntimeConfig {
  const env = options.env ?? process.env;
  const sourcePath = env.JANUA_AGENT_CONFIG_PATH ?? join(options.configDir, "agent-config.json");
  const fileConfig = existsSync(sourcePath) ? parseAgentConfigFile(sourcePath) : {};
  const admin = readObject(fileConfig.admin);
  const llm = readObject(fileConfig.llm);
  const leadCapture = readObject(fileConfig.leadCapture);

  return {
    sourcePath: existsSync(sourcePath) ? sourcePath : undefined,
    admin: {
      password: readString(admin.password) ?? "",
    },
    llm: {
      provider: resolveProvider(readString(llm.provider) ?? env.JANUA_LLM_PROVIDER),
      ollamaBaseUrl: readString(llm.ollamaBaseUrl) ?? env.OLLAMA_BASE_URL ?? "http://localhost:11434",
      ollamaModel: readString(llm.ollamaModel) ?? env.OLLAMA_MODEL ?? "llama3.2:3b",
      openaiBaseUrl: readString(llm.openaiBaseUrl) ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      openaiModel: readString(llm.openaiModel) ?? env.OPENAI_MODEL ?? "gpt-4o-mini",
    },
    leadCapture: {
      triggerWords: readStringArray(leadCapture.triggerWords) ?? defaultTriggerWords(env),
      webhookUrl: readString(leadCapture.webhookUrl) ?? env.LEAD_WEBHOOK_URL ?? "",
    },
    prompts: {
      ...DEFAULT_PROMPT_TEMPLATES,
      ...readPromptTemplates(fileConfig.prompts),
    },
  };
}

function parseAgentConfigFile(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return readObject(parsed);
  } catch (error) {
    throw new Error(`Failed to read agent config at ${path}: ${error instanceof Error ? error.message : "invalid JSON"}`);
  }
}

function resolveProvider(value: string | undefined): LlmProviderName {
  if (value === "ollama" || value === "openai") return value;
  return "fake";
}

function defaultTriggerWords(env: NodeJS.ProcessEnv): string[] {
  return readStringArrayFromText(env.JANUA_INTENT_TRIGGER_WORDS) ?? [
    "talk to someone",
    "get a quote",
    "interested",
    "contact me",
    "book",
    "appointment",
    "pricing",
  ];
}

function readPromptTemplates(value: unknown): Partial<PromptTemplates> {
  const input = readObject(value);
  return Object.fromEntries(
    Object.keys(DEFAULT_PROMPT_TEMPLATES).flatMap((key) => {
      const template = readString(input[key]);
      return template ? [[key, template]] : [];
    }),
  ) as Partial<PromptTemplates>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    const text = readString(item);
    return text ? [text] : [];
  });
}

function readStringArrayFromText(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
