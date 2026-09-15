import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import {
  buildKnowledgeContext,
  buildPromptMessages,
  assertSafeWebhookUrl,
  InMemoryStore,
  LeadCaptureFlow,
  normalizeLeadFormConfig,
  OpenAIProvider,
  OllamaRuntime,
  parseTriggerWords,
  recommendOllamaModel,
  SqliteStore,
} from "../src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ConversationStore", () => {
  it("restores messages for the same visitor and rejects mismatched visitors", () => {
    const store = new InMemoryStore();
    store.appendMessage({
      conversationId: "conv_1",
      visitorId: "visitor_1",
      message: { role: "user", content: "hello", createdAt: new Date().toISOString() },
    });

    expect(store.loadRecentMessages({ conversationId: "conv_1", visitorId: "visitor_1", limit: 50 })).toHaveLength(1);
    expect(() => store.loadRecentMessages({ conversationId: "conv_1", visitorId: "visitor_2", limit: 50 })).toThrow(
      "Conversation visitor mismatch",
    );
  });

  it("cleans expired in-memory conversations and messages", () => {
    const store = new InMemoryStore();
    store.appendMessage({
      conversationId: "conv_expired_memory",
      visitorId: "visitor_expired_memory",
      message: { role: "user", content: "hello", createdAt: new Date().toISOString() },
    });

    const result = store.cleanupExpiredConversations(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000));

    expect(result).toEqual({ conversationsDeleted: 1, messagesDeleted: 1 });
    expect(store.getConversation("conv_expired_memory")).toBeUndefined();
    expect(store.loadConversationMessages("conv_expired_memory")).toHaveLength(0);
  });

  it("persists conversations and knowledge to a SQLite file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "janua-sqlite-"));
    const filename = join(dir, "janua.db");

    try {
      const first = await SqliteStore.create({ filename });
      first.appendMessage({
        conversationId: "conv_sqlite",
        visitorId: "visitor_sqlite",
        message: { role: "user", content: "hello sqlite", createdAt: new Date().toISOString() },
      });
      first.upsertQAPair({ id: "qa_sqlite", question: "Persist?", answer: "Yes.", tags: ["db"] });

      const second = await SqliteStore.create({ filename });

      expect(second.loadRecentMessages({ conversationId: "conv_sqlite", visitorId: "visitor_sqlite", limit: 50 })).toHaveLength(
        1,
      );
      expect(second.listQAPairs().some((pair) => pair.id === "qa_sqlite")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies Drizzle migrations for a fresh SQLite file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "janua-sqlite-migrate-"));
    const filename = join(dir, "janua.db");

    try {
      await SqliteStore.create({ filename });
      const db = new Database(filename, { readonly: true });
      const migrationTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
        .get();
      db.close();

      expect(migrationTable).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upgrades untouched legacy demo defaults in SQLite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "janua-sqlite-demo-upgrade-"));
    const filename = join(dir, "janua.db");

    try {
      const first = await SqliteStore.create({ filename });
      first.setSetting("site_name", "Janua Demo");
      first.setSetting("business_info", JSON.stringify({
        business_name: "Janua Demo Business",
        phone: "+1-555-0100",
        email: "hello@example.com",
        address: "123 Demo Street",
        store_hours: "Mon-Fri 9am-5pm",
        services: ["consultation", "quotes", "support"],
        service_area: "Local area",
        custom_fields: {},
      }));
      first.upsertQAPair({
        id: "qa_demo_1",
        question: "What services do you offer?",
        answer: "We offer consultations, quotes, and customer support.",
        tags: ["services"],
      });

      const upgraded = await SqliteStore.create({ filename });

      expect(upgraded.getSetting("site_name")).toBe("Janua Spa");
      expect(upgraded.getBusinessInfo().business_name).toBe("Janua Spa");
      expect(upgraded.listQAPairs().find((pair) => pair.id === "qa_demo_1")?.answer).toContain("Janua Spa");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps customized business info when upgrading SQLite defaults", async () => {
    const dir = mkdtempSync(join(tmpdir(), "janua-sqlite-custom-info-"));
    const filename = join(dir, "janua.db");

    try {
      const first = await SqliteStore.create({ filename });
      first.setSetting("site_name", "Custom Wellness");
      first.setBusinessInfo({
        business_name: "Custom Wellness",
        phone: "+1-555-0199",
        email: "hello@custom.example",
        address: "99 Custom Street",
        store_hours: "Daily 9am-6pm",
        services: "Custom Wellness offers massage services.",
        custom_fields: {},
      });

      const upgraded = await SqliteStore.create({ filename });

      expect(upgraded.getSetting("site_name")).toBe("Custom Wellness");
      expect(upgraded.getBusinessInfo().business_name).toBe("Custom Wellness");
      expect(upgraded.getBusinessInfo().phone).toBe("+1-555-0199");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("updates and returns a single SQLite lead status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "janua-sqlite-lead-status-"));
    const filename = join(dir, "janua.db");

    try {
      const store = await SqliteStore.create({ filename });
      store.upsertLead({
        id: "lead_sqlite_status",
        conversationId: "conv_sqlite_status",
        name: "Ada",
        email: "ada-status@example.com",
        message: "Please call me",
        source: "janua-widget",
        status: "new",
        notificationStatus: "not_configured",
        createdAt: new Date().toISOString(),
      });

      const updated = store.updateLeadStatus("lead_sqlite_status", "contacted");

      expect(updated?.status).toBe("contacted");
      expect(updated?.email).toBe("ada-status@example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cleans expired SQLite conversations and messages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "janua-sqlite-cleanup-"));
    const filename = join(dir, "janua.db");

    try {
      const store = await SqliteStore.create({ filename });
      store.appendMessage({
        conversationId: "conv_expired_sqlite",
        visitorId: "visitor_expired_sqlite",
        message: { role: "user", content: "hello sqlite", createdAt: new Date().toISOString() },
      });

      const result = store.cleanupExpiredConversations(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000));

      expect(result).toEqual({ conversationsDeleted: 1, messagesDeleted: 1 });
      expect(store.getConversation("conv_expired_sqlite")).toBeUndefined();
      expect(store.loadConversationMessages("conv_expired_sqlite")).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("KnowledgeContextBuilder", () => {
  it("returns prompt text and provenance before generation", () => {
    const store = new InMemoryStore();
    const context = buildKnowledgeContext({
      businessInfo: store.getBusinessInfo(),
      qaPairs: store.listQAPairs(),
      userMessage: "What services do you offer?",
    });

    expect(context.promptPart).toContain("Business Info:");
    expect(context.promptPart).toContain("Q&A:");
    expect(context.sources.some((source) => source.type === "qa")).toBe(true);
  });
});

describe("PromptTemplateBuilder", () => {
  it("builds LLM messages from default templates and approved knowledge", () => {
    const store = new InMemoryStore();
    const prompt = buildPromptMessages({
      businessInfo: store.getBusinessInfo(),
      qaPairs: store.listQAPairs(),
      userMessage: "What services do you offer?",
      history: [{ role: "user", content: "hello", createdAt: new Date().toISOString() }],
    });

    expect(prompt.messages[0]).toMatchObject({ role: "system" });
    expect(prompt.systemPrompt).toContain("Janua Spa");
    expect(prompt.systemPrompt).toContain("Business Info:");
    expect(prompt.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(prompt.sources.some((source) => source.type === "qa")).toBe(true);
  });

  it("uses settings overrides for prompt templates", () => {
    const store = new InMemoryStore();
    store.setSetting("prompt.system", "You are the concierge for {{business_name}}.");
    const prompt = buildPromptMessages({
      businessInfo: store.getBusinessInfo(),
      qaPairs: store.listQAPairs(),
      userMessage: "hello",
      history: [],
      getSetting: (key) => store.getSetting(key),
    });

    expect(prompt.systemPrompt).toContain("You are the concierge for Janua Spa.");
  });

  it("respects knowledge character budget before prompt rendering", () => {
    const store = new InMemoryStore();
    store.upsertQAPair({
      question: "A very specific long policy question",
      answer: "x".repeat(5_000),
      tags: ["long"],
    });

    const prompt = buildPromptMessages({
      businessInfo: store.getBusinessInfo(),
      qaPairs: store.listQAPairs(),
      userMessage: "long policy",
      history: [],
      knowledgeMaxCharacters: 500,
    });

    expect(prompt.knowledgePrompt.length).toBeLessThanOrEqual(500);
    expect(prompt.systemPrompt).not.toContain("x".repeat(1_000));
  });
});

describe("LeadCaptureFlow", () => {
  it("normalizes fixed lead form fields", () => {
    const config = normalizeLeadFormConfig({
      name: { enabled: false, required: false, label: "Full name", placeholder: "Jane" },
      email: { enabled: false, required: false, label: "Email", placeholder: "jane@example.com" },
      phone: { enabled: true, required: true, label: "Phone", placeholder: "Call number" },
      company: { enabled: false, required: true, label: "Company", placeholder: "Company name" },
    });

    expect(config.name).toMatchObject({ enabled: true, required: true, label: "Full name" });
    expect(config.email).toMatchObject({ enabled: true, required: false });
    expect(config.phone).toMatchObject({ enabled: true, required: false });
    expect(config.company).toMatchObject({ enabled: false, required: false });
  });

  it("detects trigger words and deduplicates same email within 24h", async () => {
    const store = new InMemoryStore();
    const flow = new LeadCaptureFlow(store, { triggerWords: parseTriggerWords('["get a quote"]') });

    expect(flow.shouldCapture("I want to get a quote")).toBe(true);

    const first = await flow.capture({
      conversationId: "conv_1",
      name: "Ada",
      email: "ada@example.com",
      message: "Need pricing",
    });
    const second = await flow.capture({
      conversationId: "conv_1",
      name: "Ada Lovelace",
      email: "ada@example.com",
      message: "Following up",
    });

    expect(first.isUpdate).toBe(false);
    expect(second.isUpdate).toBe(true);
    expect(store.listLeads()).toHaveLength(1);
  });
});

describe("HardwareModelRecommendation", () => {
  it("recommends small local models for constrained hardware", () => {
    const result = recommendOllamaModel({ cpuCount: 2, totalMemoryGb: 8 });

    expect(result).toMatchObject({
      provider: "ollama",
      model: "llama3.2:3b",
    });
    expect(result.warning).toContain("Responses may still feel slow");
  });

  it("recommends OpenAI below the local model baseline", () => {
    const result = recommendOllamaModel({ cpuCount: 1, totalMemoryGb: 2 });

    expect(result).toMatchObject({
      provider: "openai",
      model: "gpt-4o-mini",
    });
  });

  it("recommends larger local models on stronger hardware", () => {
    expect(recommendOllamaModel({ cpuCount: 4, totalMemoryGb: 12 }).model).toBe("qwen2.5:7b");
    expect(recommendOllamaModel({ cpuCount: 8, totalMemoryGb: 24 }).model).toBe("qwen2.5:14b");
  });
});

describe("OpenAIProvider", () => {
  it("streams chat completion deltas", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  [
                    'data: {"choices":[{"delta":{"content":"Hello"}}]}',
                    "",
                    'data: {"choices":[{"delta":{"content":" world"}}]}',
                    "",
                    "data: [DONE]",
                    "",
                    "",
                  ].join("\n"),
                ),
              );
              controller.close();
            },
          }),
          { status: 200 },
        );
      }),
    );

    const provider = new OpenAIProvider({ apiKey: "test-key", model: "gpt-test" });
    const chunks = [];
    for await (const chunk of provider.chat([{ role: "user", content: "hello" }])) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.content).join("")).toBe("Hello world");
    expect(fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      }),
    );
  });

  it("includes OpenAI error response messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 })),
    );

    const provider = new OpenAIProvider({ apiKey: "bad-key", model: "gpt-test" });

    await expect(async () => {
      for await (const _chunk of provider.chat([{ role: "user", content: "hello" }])) {
        // Consume the stream to trigger provider errors.
      }
    }).rejects.toThrow("OpenAI request failed: 401 - Invalid API key");
  });
});

describe("LeadWebhook", () => {
  it("rejects local and private network targets by default", () => {
    expect(() => assertSafeWebhookUrl("http://localhost/hooks")).toThrow("local hostnames");
    expect(() => assertSafeWebhookUrl("http://127.0.0.1/hooks")).toThrow("private or link-local");
    expect(() => assertSafeWebhookUrl("http://10.0.0.1/hooks")).toThrow("private or link-local");
    expect(() => assertSafeWebhookUrl("http://172.16.0.1/hooks")).toThrow("private or link-local");
    expect(() => assertSafeWebhookUrl("http://192.168.0.1/hooks")).toThrow("private or link-local");
    expect(() => assertSafeWebhookUrl("http://169.254.169.254/latest/meta-data")).toThrow("private or link-local");
    expect(() => assertSafeWebhookUrl("http://[::1]/hooks")).toThrow("private or link-local");
  });

  it("allows public HTTP(S) webhook targets", () => {
    expect(() => assertSafeWebhookUrl("https://hooks.example/leads")).not.toThrow();
  });
});

describe("OllamaRuntime", () => {
  it("pulls a missing model before prewarming", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "success" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: "llama3.2:3b" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ response: "pong" }), { status: 200 }));

    const runtime = new OllamaRuntime({ baseUrl: "http://ollama.local", model: "llama3.2:3b", fetchImpl });
    const result = await runtime.prewarm();

    expect(result).toMatchObject({ ok: true, modelInstalled: true });
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://ollama.local/api/pull",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      4,
      "http://ollama.local/api/generate",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("reports benchmark throughput and slow warnings", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ response: "hello world", eval_count: 4, eval_duration: 1_000_000_000 }), {
        status: 200,
      }),
    );
    const runtime = new OllamaRuntime({ baseUrl: "http://ollama.local", model: "tiny", fetchImpl });

    const result = await runtime.benchmark();

    expect(result.tokensPerSecond).toBe(4);
    expect(result.warning).toContain("may feel slow");
  });
});
