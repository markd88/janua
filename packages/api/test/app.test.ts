import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { ChatChunk, LeadRecord, LLMProvider, Message, PromptTemplates } from "@janua/core";
import { DEFAULT_PROMPT_TEMPLATES, InMemoryStore, SqliteStore } from "@janua/core";
import { createApp } from "../src/app.js";
import { loadAgentConfig, type AgentRuntimeConfig } from "../src/agent-config.js";
import { ensureAdminAccount } from "../src/admin-auth.js";
import { DEFAULT_ADMIN_KEY } from "../src/admin-defaults.js";
import { resolveAdminKey } from "../src/config.js";
import { runFirstRunSetup } from "../src/first-run.js";

describe("Janua API", () => {
  it("returns widget config for a valid site token", async () => {
    const app = createApp();
    const response = await app.request("/api/widget-config?siteToken=dev-site-token");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      siteName: "Chat with us",
      leadForm: {
        name: { enabled: true, required: true },
        email: { enabled: true, required: false },
        phone: { enabled: true, required: false },
        company: { enabled: false, required: false },
      },
    });
  });

  it("adds baseline security headers", async () => {
    const app = createApp();
    const response = await app.request("/health");
    const csp = response.headers.get("content-security-policy") ?? "";

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("loads product-internal agent config from startup JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "janua-agent-config-"));
    const configPath = join(dir, "agent-config.json");

    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          admin: {
            password: "config-admin-key",
          },
          llm: {
            provider: "ollama",
            ollamaBaseUrl: "http://ollama.internal:11434",
            ollamaModel: "qwen2.5:7b",
          },
          leadCapture: {
            triggerWords: ["book demo"],
            webhookUrl: "https://hooks.example/leads",
            leadForm: {
              company: { enabled: true, required: true, label: "Company", placeholder: "Company name" },
              email: { enabled: true, required: true, label: "Email", placeholder: "Email" },
            },
          },
          prompts: {
            "prompt.system": "Internal prompt for {{business_name}}.",
          },
        }),
      );

      const config = loadAgentConfig({
        configDir: dir,
        env: {
          JANUA_AGENT_CONFIG_PATH: configPath,
          JANUA_LLM_PROVIDER: "fake",
        },
      });

      expect(config.sourcePath).toBe(configPath);
      expect(config.admin.password).toBe("config-admin-key");
      expect(config.llm).toMatchObject({
        provider: "ollama",
        ollamaBaseUrl: "http://ollama.internal:11434",
        ollamaModel: "qwen2.5:7b",
      });
      expect(config.leadCapture.triggerWords).toEqual(["book demo"]);
      expect(config.leadCapture.webhookUrl).toBe("https://hooks.example/leads");
      expect("leadForm" in config.leadCapture).toBe(false);
      expect(config.prompts["prompt.system"]).toBe("Internal prompt for {{business_name}}.");
      expect(config.prompts["prompt.handoff"]).toBe(DEFAULT_PROMPT_TEMPLATES["prompt.handoff"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves the Admin SPA for deep links", async () => {
    const app = createApp();
    const response = await app.request("/admin/knowledge");
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(text).toContain('<div id="app"></div>');
  });

  it("streams chat events and restores messages for the same visitor", async () => {
    const app = createApp();
    const body = {
      conversationId: "conv_api_1",
      visitorId: "visitor_api_1",
      siteToken: "dev-site-token",
      message: "I want to get a quote",
    };

    const chat = await app.request("/api/chat", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const text = await chat.text();

    expect(chat.status).toBe(200);
    expect(text).toContain("event: token");
    expect(text).toContain("event: lead");

    const restore = await app.request("/api/conversation/restore", {
      method: "POST",
      body: JSON.stringify({
        conversationId: body.conversationId,
        visitorId: body.visitorId,
        siteToken: body.siteToken,
      }),
      headers: { "Content-Type": "application/json" },
    });
    const restored = await restore.json();

    expect(restore.status).toBe(200);
    expect(restored.messages).toHaveLength(2);
  });

  it("deduplicates retried chat requests before the assistant replies", async () => {
    const store = new InMemoryStore();
    const app = createApp({ store });
    const body = {
      conversationId: "conv_retry_duplicate",
      visitorId: "visitor_retry_duplicate",
      siteToken: "dev-site-token",
      message: "What do you sell?",
    };
    store.ensureConversation({ conversationId: body.conversationId, visitorId: body.visitorId });
    store.appendMessage({
      conversationId: body.conversationId,
      visitorId: body.visitorId,
      message: { role: "user", content: body.message, createdAt: new Date().toISOString() },
    });

    const retry = await app.request("/api/chat", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    await retry.text();
    const messages = store.loadConversationMessages(body.conversationId);

    expect(retry.status).toBe(200);
    expect(messages.filter((message) => message.role === "user" && message.content === body.message)).toHaveLength(1);
    expect(messages.some((message) => message.role === "assistant")).toBe(true);
  });

  it("replays the existing assistant reply for retried completed chat requests", async () => {
    const store = new InMemoryStore();
    const llm = new QueuedLLMProvider([]);
    const app = createApp({ store, llm });
    const body = {
      conversationId: "conv_completed_retry",
      visitorId: "visitor_completed_retry",
      siteToken: "dev-site-token",
      message: "What do you sell?",
    };
    const assistantReply = "We offer massages and facials.";
    store.ensureConversation({ conversationId: body.conversationId, visitorId: body.visitorId });
    store.appendMessage({
      conversationId: body.conversationId,
      visitorId: body.visitorId,
      message: { role: "user", content: body.message, createdAt: new Date().toISOString() },
    });
    store.appendMessage({
      conversationId: body.conversationId,
      visitorId: body.visitorId,
      message: {
        role: "assistant",
        content: assistantReply,
        sources: [{ type: "business_info", field: "services" }],
        createdAt: new Date().toISOString(),
      },
    });

    const retry = await app.request("/api/chat", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const text = await retry.text();
    const messages = store.loadConversationMessages(body.conversationId);

    expect(retry.status).toBe(200);
    expect(text).toContain(assistantReply);
    expect(text).toContain('"deduplicated":true');
    expect(llm.calls).toBe(0);
    expect(messages).toHaveLength(2);
  });

  it("returns and stores an AI-generated redirect for unrelated messages regardless of confidence", async () => {
    const store = new InMemoryStore();
    const redirectMessage = "I'm here to help with questions about Janua Spa. Please ask about our services or bookings.";
    const llm = new QueuedLLMProvider([
      JSON.stringify({
        related: false,
        confidence: 0.5,
        reason: "The visitor asks for an unrelated essay.",
        redirectMessage,
      }),
    ]);
    const app = createApp({ store, llm });
    const body = {
      conversationId: "conv_off_topic",
      visitorId: "visitor_off_topic",
      siteToken: "dev-site-token",
      message: "Write an essay about the Roman Empire",
    };

    const chat = await app.request("/api/chat", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    const text = await chat.text();
    const messages = store.loadConversationMessages(body.conversationId);

    expect(chat.status).toBe(200);
    expect(text).toContain("event: token");
    expect(text).toContain(redirectMessage);
    expect(text).toContain("event: sources");
    expect(text).toContain("event: done");
    expect(text).not.toContain("event: lead");
    expect(llm.calls).toBe(1);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: "assistant", content: redirectMessage, sources: [] });
  });

  it("falls back to the main LLM when intent classification is invalid", async () => {
    const llm = new QueuedLLMProvider(["not json", "Business answer"]);
    const app = createApp({ llm });

    const chat = await app.request("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        conversationId: "conv_intent_fallback",
        visitorId: "visitor_intent_fallback",
        siteToken: "dev-site-token",
        message: "I want to get a quote",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const text = await chat.text();

    expect(chat.status).toBe(200);
    expect(text).toContain("Business answer");
    expect(text).toContain("event: lead");
    expect(llm.calls).toBe(2);
  });

  it("streams a lead event when AI judges that follow-up is useful", async () => {
    const llm = new QueuedLLMProvider([
      JSON.stringify({ related: true, confidence: 0.93, reason: "The visitor asks about massage booking.", redirectMessage: null }),
      "We offer relaxing facials and massages.",
      JSON.stringify({ shouldCapture: true, reason: "The visitor is asking about booking." }),
    ]);
    const app = createApp({
      llm,
      agentConfig: testAgentConfig({ triggerWords: ["never-match-this-message"] }),
    });

    const chat = await app.request("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        conversationId: "conv_ai_lead",
        visitorId: "visitor_ai_lead",
        siteToken: "dev-site-token",
        message: "Can I reserve a couples massage for Saturday?",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const text = await chat.text();

    expect(chat.status).toBe(200);
    expect(text).toContain("event: lead");
    expect(text).toContain('"reason":"ai_judgement"');
    expect(llm.calls).toBe(3);
  });

  it("uses trigger words before asking AI to judge lead intent", async () => {
    const llm = new QueuedLLMProvider([
      JSON.stringify({ related: true, confidence: 0.93, reason: "The visitor asks about pricing.", redirectMessage: null }),
      "ok",
    ]);
    const app = createApp({ llm });

    const chat = await app.request("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        conversationId: "conv_trigger_lead",
        visitorId: "visitor_trigger_lead",
        siteToken: "dev-site-token",
        message: "I want to get a quote",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const text = await chat.text();

    expect(chat.status).toBe(200);
    expect(text).toContain("event: lead");
    expect(text).toContain('"reason":"trigger_word"');
    expect(llm.calls).toBe(2);
  });

  it("rejects restore for a mismatched visitor", async () => {
    const app = createApp();
    await app.request("/api/conversation/restore", {
      method: "POST",
      body: JSON.stringify({
        conversationId: "conv_api_2",
        visitorId: "visitor_api_1",
        siteToken: "dev-site-token",
      }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await app.request("/api/conversation/restore", {
      method: "POST",
      body: JSON.stringify({
        conversationId: "conv_api_2",
        visitorId: "visitor_api_2",
        siteToken: "dev-site-token",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(401);
  });

  it("captures leads", async () => {
    const app = createApp();
    const response = await app.request("/api/lead", {
      method: "POST",
      body: JSON.stringify({
        conversationId: "conv_api_3",
        visitorId: "visitor_api_3",
        siteToken: "dev-site-token",
        name: "Ada",
        email: "ada@example.com",
        message: "Please contact me",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, notificationStatus: "not_configured" });
  });

  it("records lead form submission in the conversation transcript", async () => {
    const app = createApp();
    const response = await app.request("/api/lead", {
      method: "POST",
      body: JSON.stringify({
        conversationId: "conv_lead_transcript",
        visitorId: "visitor_lead_transcript",
        siteToken: "dev-site-token",
        name: "Ada",
        email: "ada@example.com",
        message: "Please contact me",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const transcript = await app.request("/api/admin/conversations/conv_lead_transcript/messages", {
      headers: adminHeaders(),
    });
    const body = await transcript.json();

    expect(response.status).toBe(200);
    expect(transcript.status).toBe(200);
    expect(body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "I just submitted the form." }),
        expect.objectContaining({ role: "assistant", content: "We received your form and will contact you soon." }),
      ]),
    );
  });

  it("updates lead status from the admin API", async () => {
    const app = createApp();
    const captured = await app.request("/api/lead", {
      method: "POST",
      body: JSON.stringify({
        conversationId: "conv_lead_status",
        visitorId: "visitor_lead_status",
        siteToken: "dev-site-token",
        name: "Mina",
        email: "mina@example.com",
        message: "Please contact me",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const capturedBody = await captured.json();

    const updated = await app.request(`/api/admin/leads/${capturedBody.leadId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: "contacted" }),
      headers: adminHeaders(),
    });
    const updatedBody = await updated.json();

    expect(updated.status).toBe(200);
    expect(updatedBody.lead.status).toBe("contacted");
  });

  it("paginates admin leads", async () => {
    const app = createApp();
    for (const index of [1, 2, 3]) {
      await app.request("/api/lead", {
        method: "POST",
        body: JSON.stringify({
          conversationId: `conv_page_${index}`,
          visitorId: `visitor_page_${index}`,
          siteToken: "dev-site-token",
          name: `Lead ${index}`,
          email: `lead-${index}@example.com`,
          message: "Please contact me",
        }),
        headers: { "Content-Type": "application/json" },
      });
    }

    const response = await app.request("/api/admin/leads?page=2&limit=2", { headers: adminHeaders() });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.leads).toHaveLength(1);
    expect(body.pagination).toEqual({ page: 2, limit: 2, total: 3 });
  });

  it("sends configured lead webhooks", async () => {
    const delivered: Array<{ url: string; lead: LeadRecord }> = [];
    const app = createApp({
      agentConfig: testAgentConfig({ webhookUrl: "https://hooks.example/leads" }),
      leadNotifier: async (url, lead) => {
        delivered.push({ url, lead });
      },
    });

    const response = await app.request("/api/lead", {
      method: "POST",
      body: JSON.stringify({
        conversationId: "conv_webhook_sent",
        visitorId: "visitor_webhook_sent",
        siteToken: "dev-site-token",
        name: "Grace",
        email: "grace@example.com",
        message: "Please follow up",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.notificationStatus).toBe("sent");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      url: "https://hooks.example/leads",
      lead: { name: "Grace", email: "grace@example.com" },
    });
  });

  it("uses the startup-configured lead webhook URL", async () => {
    const delivered: Array<{ url: string; lead: LeadRecord }> = [];
    const app = createApp({
      agentConfig: testAgentConfig({ webhookUrl: "https://hooks.example/startup-configured" }),
      leadNotifier: async (url, lead) => {
        delivered.push({ url, lead });
      },
    });

    const response = await app.request("/api/lead", {
      method: "POST",
      body: JSON.stringify({
        conversationId: "conv_webhook_admin",
        visitorId: "visitor_webhook_admin",
        siteToken: "dev-site-token",
        name: "Katherine",
        email: "katherine@example.com",
        message: "Please follow up",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(delivered[0]?.url).toBe("https://hooks.example/startup-configured");
  });

  it("records failed lead webhook delivery errors", async () => {
    const app = createApp({
      agentConfig: testAgentConfig({ webhookUrl: "https://hooks.example/leads" }),
      leadNotifier: async () => {
        throw new Error("Webhook returned 500");
      },
    });

    const response = await app.request("/api/lead", {
      method: "POST",
      body: JSON.stringify({
        conversationId: "conv_webhook_failed",
        visitorId: "visitor_webhook_failed",
        siteToken: "dev-site-token",
        name: "Lin",
        email: "lin@example.com",
        message: "Please follow up",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const body = await response.json();
    const leadsResponse = await app.request("/api/admin/leads", { headers: adminHeaders() });
    const leadsBody = await leadsResponse.json();

    expect(response.status).toBe(200);
    expect(body.notificationStatus).toBe("failed");
    expect(leadsBody.leads[0]).toMatchObject({
      notificationStatus: "failed",
      lastNotifyError: "Webhook returned 500",
    });
  });

  it("returns conversation transcript for admin", async () => {
    const app = createApp();
    const chat = await app.request("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        conversationId: "conv_transcript",
        visitorId: "visitor_transcript",
        siteToken: "dev-site-token",
        message: "What services do you offer?",
      }),
      headers: { "Content-Type": "application/json" },
    });
    await chat.text();

    const response = await app.request("/api/admin/conversations/conv_transcript/messages", {
      headers: adminHeaders(),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant"]);
  });

  it("updates business info and uses it in widget-safe config paths", async () => {
    const app = createApp();
    const response = await app.request("/api/admin/business-info", {
      method: "PUT",
      body: JSON.stringify({
        business_name: "Ada Repairs",
        phone: "+1-555-0199",
        email: "hello@adarepairs.test",
        address: "42 Analytical Engine Way",
        store_hours: "Always",
        services: "Ada Repairs fixes analytical engines and related equipment.",
        custom_fields: { warranty: "90 days" },
      }),
      headers: adminHeaders(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ businessInfo: { business_name: "Ada Repairs" } });

    const widgetConfig = await app.request("/api/widget-config?siteToken=dev-site-token");
    await expect(widgetConfig.json()).resolves.toMatchObject({ siteName: "Ada Repairs" });
  });

  it("reads site install settings from server configuration", async () => {
    const app = createApp({ allowedOrigins: ["https://initial.example"] });

    const read = await app.request("/api/admin/site", { headers: adminHeaders() });
    const initial = await read.json();

    expect(read.status).toBe(200);
    expect(initial.site.embedCode).toContain('/api/widget.js"');
    expect(initial.site.embedCode).toContain('data-token="dev-site-token"');
    expect(initial.site.embedCode).toContain("defer");
    expect(initial.site.embedCode).not.toContain("data-base-url=");
    expect(initial.site.baseUrl).toBe("http://localhost");
    expect(initial.site.widgetScriptUrl).toBe("http://localhost/api/widget.js");
    expect(initial.site.siteToken).toBeUndefined();
    expect(initial.site.allowedOrigins).toBeUndefined();
    expect(initial.site.widgetConfig).toBeUndefined();
  });

  it("does not expose an admin site settings write API in v0.1", async () => {
    const app = createApp();
    const update = await app.request("/api/admin/site", {
      method: "PUT",
      body: JSON.stringify({
        siteName: "Ada Repairs",
        allowedOrigins: ["https://ada.example", "http://localhost:5173"],
      }),
      headers: adminHeaders(),
    });

    expect(update.status).toBe(404);
  });

  it("returns unified admin settings with masked secret metadata", async () => {
    const app = createApp({
      adminKey: "super-secret-admin-key-1234",
      allowedOrigins: ["https://allowed.example"],
    });

    const response = await app.request("/api/admin/settings", {
      headers: { Authorization: "Bearer super-secret-admin-key-1234" },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.settings).toMatchObject({
      businessInfo: { business_name: "Janua Spa" },
      site: {},
      runtime: {
        rateLimitEnabled: true,
        securityHeadersEnabled: true,
      },
      secrets: {},
    });
    expect(JSON.stringify(body)).not.toContain("super-secret-admin-key-1234");
    expect(body.settings.agent).toBeUndefined();
    expect(body.settings.runtime.hardware).toBeUndefined();
    expect(body.settings.site.embedCode).toContain('/api/widget.js"');
    expect(body.settings.site.embedCode).toContain('data-token="dev-site-token"');
    expect(body.settings.site.embedCode).not.toContain("data-base-url=");
    expect(body.settings.site.siteToken).toBeUndefined();
    expect(body.settings.site.allowedOrigins).toBeUndefined();
    expect(body.settings.site.widgetConfig).toBeUndefined();
    expect(body.settings.secrets.openaiApiKey).toBeUndefined();
    expect(body.settings.secrets.leadWebhookUrl).toBeUndefined();
  });

  it("applies server-configured site origins to public API CORS", async () => {
    const app = createApp({ allowedOrigins: ["https://allowed-from-server.example"] });
    const allowed = await app.request("/api/widget-config?siteToken=dev-site-token", {
      headers: { Origin: "https://allowed-from-server.example" },
    });
    const denied = await app.request("/api/widget-config?siteToken=dev-site-token", {
      headers: { Origin: "https://initial.example" },
    });

    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://allowed-from-server.example");
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("creates, updates, and deletes Q&A pairs", async () => {
    const app = createApp();
    const create = await app.request("/api/admin/knowledge", {
      method: "POST",
      body: JSON.stringify({ question: "Do you repair clocks?", answer: "Yes.", tags: ["repair"] }),
      headers: adminHeaders(),
    });
    const created = await create.json();

    expect(create.status).toBe(201);
    expect(created.qaPair.question).toBe("Do you repair clocks?");

    const update = await app.request(`/api/admin/knowledge/${created.qaPair.id}`, {
      method: "PUT",
      body: JSON.stringify({ question: "Do you repair clocks?", answer: "Yes, every weekday.", tags: ["repair"] }),
      headers: adminHeaders(),
    });
    const updated = await update.json();

    expect(update.status).toBe(200);
    expect(updated.qaPair.answer).toBe("Yes, every weekday.");

    const remove = await app.request(`/api/admin/knowledge/${created.qaPair.id}`, {
      method: "DELETE",
      headers: adminHeaders(),
    });
    await expect(remove.json()).resolves.toEqual({ deleted: true });
  });

  it("paginates FAQ pairs", async () => {
    const app = createApp();
    await app.request("/api/admin/knowledge", {
      method: "POST",
      body: JSON.stringify({ question: "Do you offer emergency plumbing?", answer: "Yes.", tags: ["urgent"] }),
      headers: adminHeaders(),
    });
    await app.request("/api/admin/knowledge", {
      method: "POST",
      body: JSON.stringify({ question: "Do you install cabinets?", answer: "Yes.", tags: ["renovation"] }),
      headers: adminHeaders(),
    });

    const response = await app.request("/api/admin/knowledge?page=1&limit=1", {
      headers: adminHeaders(),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.qaPairs).toHaveLength(1);
    expect(body.pagination).toEqual({ page: 1, limit: 1, total: 3 });
  });

  it("does not expose merchant admin agent settings", async () => {
    const app = createApp();
    const read = await app.request("/api/admin/agent-settings", {
      headers: adminHeaders(),
    });
    const update = await app.request("/api/admin/agent-settings", {
      method: "PUT",
      body: JSON.stringify({ llmProvider: "ollama" }),
      headers: adminHeaders(),
    });

    expect(read.status).toBe(404);
    expect(update.status).toBe(404);
  });

  it("uses the fixed lead form: name required, phone and email optional", async () => {
    const app = createApp({
      agentConfig: testAgentConfig({
        webhookUrl: "https://hooks.example/leads",
      }),
      leadNotifier: async () => undefined,
    });

    const missingName = await app.request("/api/lead", {
      method: "POST",
      body: JSON.stringify({
        conversationId: "conv_required_company",
        visitorId: "visitor_required_company",
        siteToken: "dev-site-token",
        message: "Please contact me",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const missingNameBody = await missingName.json();

    expect(missingName.status).toBe(400);
    expect(missingNameBody.error).toMatchObject({ code: "REQUEST_INVALID" });

    const optionalContact = await app.request("/api/lead", {
      method: "POST",
      body: JSON.stringify({
        conversationId: "conv_optional_contact",
        visitorId: "visitor_optional_contact",
        siteToken: "dev-site-token",
        name: "Ada",
        message: "Please contact me",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(optionalContact.status).toBe(200);
  });

  it("does not expose merchant admin LLM benchmark operations", async () => {
    const app = createApp();
    const response = await app.request("/api/admin/llm/benchmark", {
      method: "POST",
      body: JSON.stringify({}),
      headers: adminHeaders(),
    });

    expect(response.status).toBe(404);
  });

  it("uses startup-configured prompt templates for chat", async () => {
    const llm = new CapturingLLMProvider();
    const app = createApp({
      llm,
      agentConfig: testAgentConfig({
        prompts: {
          "prompt.system": "Custom concierge for {{business_name}}.",
        },
      }),
    });

    const chat = await app.request("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        conversationId: "conv_prompt",
        visitorId: "visitor_prompt",
        siteToken: "dev-site-token",
        message: "hello",
      }),
      headers: { "Content-Type": "application/json" },
    });
    await chat.text();

    expect(llm.calls[0]?.[0]?.content).toContain("You classify whether a visitor message is related");
    expect(llm.calls[1]?.[0]?.content).toContain("Custom concierge for Janua Spa.");
  });

  it("rejects admin requests without the admin key", async () => {
    const app = createApp();
    const response = await app.request("/api/admin/leads");
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.code).toBe("AUTH_INVALID");
  });

  it("supports admin login sessions with httpOnly cookies", async () => {
    const app = createApp();

    const failed = await app.request("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: "wrong" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(failed.status).toBe(401);

    const login = await app.request("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: DEFAULT_ADMIN_KEY }),
      headers: { "Content-Type": "application/json" },
    });
    const loginBody = await login.json();
    const cookie = login.headers.get("set-cookie") ?? "";

    expect(login.status).toBe(200);
    expect(loginBody).toMatchObject({ authenticated: true });
    expect(cookie).toContain("janua_admin_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");

    const settings = await app.request("/api/admin/settings", {
      headers: { Cookie: cookie },
    });
    expect(settings.status).toBe(200);

    const logout = await app.request("/api/admin/logout", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    const cleared = logout.headers.get("set-cookie") ?? "";
    expect(logout.status).toBe(200);
    expect(cleared).toContain("Max-Age=0");

    const afterLogout = await app.request("/api/admin/session", {
      headers: { Cookie: cookie },
    });
    expect(afterLogout.status).toBe(401);
  });

  it("uses the default admin password when no password is configured", () => {
    const store = new InMemoryStore();

    const first = ensureAdminAccount(store, { env: {} });
    const second = ensureAdminAccount(store, { env: {} });

    expect(first).toEqual({ username: "admin", source: "default" });
    expect(second).toEqual({ username: "admin", source: "existing" });
  });

  it("uses configured agent admin password for login", async () => {
    const app = createApp({
      agentConfig: testAgentConfig({ adminPassword: "configured-admin-password" }),
    });

    const defaultPassword = await app.request("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: DEFAULT_ADMIN_KEY }),
      headers: { "Content-Type": "application/json" },
    });
    const configuredPassword = await app.request("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: "configured-admin-password" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(defaultPassword.status).toBe(401);
    expect(configuredPassword.status).toBe(200);
  });

  it("lets configured admin password replace an existing default password", async () => {
    const store = new InMemoryStore();
    ensureAdminAccount(store, { env: {} });
    ensureAdminAccount(store, { env: {}, configuredPassword: "configured-admin-password" });
    const app = createApp({
      store,
      agentConfig: testAgentConfig(),
    });

    const defaultPassword = await app.request("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: DEFAULT_ADMIN_KEY }),
      headers: { "Content-Type": "application/json" },
    });
    const configuredPassword = await app.request("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ password: "configured-admin-password" }),
      headers: { "Content-Type": "application/json" },
    });

    expect(defaultPassword.status).toBe(401);
    expect(configuredPassword.status).toBe(200);
  });

  it("accepts x-api-key for design-compatible admin auth", async () => {
    const app = createApp();
    const response = await app.request("/api/admin/leads", {
      headers: { "x-api-key": DEFAULT_ADMIN_KEY },
    });

    expect(response.status).toBe(200);
  });

  it("rejects the deprecated x-admin-key header", async () => {
    const app = createApp();
    const response = await app.request("/api/admin/leads", {
      headers: { "x-admin-key": DEFAULT_ADMIN_KEY },
    });

    expect(response.status).toBe(401);
  });

  it("rate limits admin requests per admin key", async () => {
    const app = createApp({
      adminRateLimit: { enabled: true, windowMs: 60_000, max: 1, trustProxy: false, maxBuckets: 10 },
    });

    const first = await app.request("/api/admin/leads", { headers: adminHeaders() });
    const second = await app.request("/api/admin/leads", { headers: adminHeaders() });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  it("allows same-origin admin requests", async () => {
    const app = createApp();
    const response = await app.request("https://janua.example/api/admin/leads", {
      headers: { ...adminHeaders(), Origin: "https://janua.example" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects cross-origin admin requests even with a valid admin key", async () => {
    const app = createApp({ allowedOrigins: ["https://customer-site.example"] });
    const response = await app.request("https://janua.example/api/admin/leads", {
      headers: { ...adminHeaders(), Origin: "https://evil.example" },
    });
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(body.error.code).toBe("CORS_ORIGIN_DENIED");
  });

  it("rejects invalid public request bodies with structured validation errors", async () => {
    const app = createApp();
    const response = await app.request("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        conversationId: "conv_invalid",
        visitorId: "visitor_invalid",
        siteToken: "dev-site-token",
        message: "",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("REQUEST_INVALID");
  });

  it("rate limits public widget endpoints", async () => {
    const app = createApp({ rateLimit: { enabled: true, windowMs: 60_000, max: 1, trustProxy: true, maxBuckets: 10 } });
    const headers = { "x-forwarded-for": "203.0.113.10" };

    const first = await app.request("/api/widget-config?siteToken=dev-site-token", { headers });
    const second = await app.request("/api/widget-config?siteToken=dev-site-token", { headers });
    const body = await second.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(body.error.code).toBe("RATE_LIMITED");
  });

  it("does not trust spoofed proxy headers unless explicitly configured", async () => {
    const app = createApp({ rateLimit: { enabled: true, windowMs: 60_000, max: 1, trustProxy: false, maxBuckets: 10 } });

    const first = await app.request("/api/widget-config?siteToken=dev-site-token", {
      headers: { "x-forwarded-for": "203.0.113.20" },
    });
    const second = await app.request("/api/widget-config?siteToken=dev-site-token", {
      headers: { "x-forwarded-for": "203.0.113.21" },
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  it("applies a stricter rate limit to repeated chat turns", async () => {
    const app = createApp({
      chatRateLimit: { enabled: true, windowMs: 60_000, max: 1, trustProxy: true, maxBuckets: 10 },
    });
    const body = {
      conversationId: "conv_rate_limit",
      visitorId: "visitor_rate_limit",
      siteToken: "dev-site-token",
      message: "Can I book a massage?",
    };
    const headers = { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.30" };

    const first = await app.request("/api/chat", {
      method: "POST",
      body: JSON.stringify(body),
      headers,
    });
    const second = await app.request("/api/chat", {
      method: "POST",
      body: JSON.stringify({ ...body, message: "Can I book now?" }),
      headers,
    });
    const error = await second.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(error.error.code).toBe("RATE_LIMITED");
  });

  it("applies the configured CORS allowlist", async () => {
    const app = createApp({ allowedOrigins: ["https://allowed.example"] });

    const allowed = await app.request("/api/widget-config?siteToken=dev-site-token", {
      headers: { Origin: "https://allowed.example" },
    });
    const denied = await app.request("/api/widget-config?siteToken=dev-site-token", {
      headers: { Origin: "https://evil.example", "x-forwarded-for": "203.0.113.11" },
    });

    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://allowed.example");
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("normalizes allowed origin trailing slashes", async () => {
    const app = createApp({ allowedOrigins: ["https://allowed.example/"] });
    const publicApi = await app.request("/api/widget-config?siteToken=dev-site-token", {
      headers: { Origin: "https://allowed.example" },
    });

    expect(publicApi.headers.get("access-control-allow-origin")).toBe("https://allowed.example");
  });

  it("uses the default admin key when no API key is configured", () => {
    expect(resolveAdminKey({ NODE_ENV: "production", ADMIN_API_KEY: undefined })).toEqual({
      key: DEFAULT_ADMIN_KEY,
      source: "default",
    });
    expect(resolveAdminKey({ NODE_ENV: "production", ADMIN_API_KEY: "prod-secret" })).toMatchObject({
      key: "prod-secret",
      source: "env",
    });
  });

  it("reuses a production admin key file when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "janua-admin-key-"));
    const keyFile = join(dir, "admin-key");

    try {
      writeFileSync(keyFile, `${DEFAULT_ADMIN_KEY}\n`);
      const resolved = resolveAdminKey({ NODE_ENV: "production", ADMIN_API_KEY: undefined }, { keyFile });

      expect(resolved).toEqual({ key: DEFAULT_ADMIN_KEY, source: "file" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps an existing production site token and logs install instructions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "janua-first-run-"));
    const store = new InMemoryStore();
    const adminKey = { key: "prod-secret", source: "env" as const };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const result = await runFirstRunSetup(store, {
        publicBaseUrl: "https://janua.example",
        llmProvider: "fake",
        adminKey,
        production: true,
      });

      expect(result.siteToken).toBe("dev-site-token");
      expect(store.getSetting("site_token")).toBe(result.siteToken);
      expect(logSpy).toHaveBeenCalledWith("Demo chat: https://janua.example/demo");
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Embed snippet: <script src=\"https://janua.example/api/widget.js\""));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("production is using the default dev-site-token"));
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("generates a production site token only when none exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "janua-first-run-empty-"));
    const store = new InMemoryStore();
    store.setSetting("site_token", "");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const result = await runFirstRunSetup(store, {
        publicBaseUrl: "https://janua.example",
        llmProvider: "fake",
        adminKey: { key: "prod-secret", source: "env" },
        production: true,
      });

      expect(result.siteToken).not.toBe("dev-site-token");
      expect(store.getSetting("site_token")).toBe(result.siteToken);
    } finally {
      logSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("generates a random production site token for a fresh SQLite database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "janua-first-run-sqlite-"));
    const store = SqliteStore.create({ filename: join(dir, "janua.db"), seedDefaultSiteToken: false });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const result = await runFirstRunSetup(store, {
        publicBaseUrl: "https://janua.example",
        llmProvider: "fake",
        adminKey: { key: "prod-secret", source: "env" },
        production: true,
      });

      expect(result.siteToken).not.toBe("dev-site-token");
      expect(store.getSetting("site_token")).toBe(result.siteToken);
    } finally {
      logSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves admin and widget assets after build", async () => {
    const store = new InMemoryStore();
    store.setSetting("site_token", "real-demo-token");
    const app = createApp({ store });

    const admin = await app.request("/admin");
    const demo = await app.request("/demo");
    const widget = await app.request("/widget.js");
    const widgetAlias = await app.request("/api/widget.js");

    expect(admin.status).toBe(200);
    expect(await admin.text()).toContain("Janua Admin");
    expect(demo.status).toBe(200);
    const demoHtml = await demo.text();
    expect(demoHtml).toContain("Welcome to Janua Spa");
    expect(demoHtml).toContain('<a href="/admin/knowledge">Open Business Knowledge</a>');
    expect(demoHtml).toContain("in Admin and fill in your business info");
    expect(demoHtml).toContain("use the AI chat in the bottom-right corner");
    expect(demoHtml).toContain("go back to Admin to check the captured lead");
    expect(demoHtml).toContain('data-token="real-demo-token"');
    expect(demoHtml).not.toContain('data-token="dev-site-token"');
    expect(widget.status).toBe(200);
    expect(await widget.text()).toContain("JanuaWidget");
    expect(widgetAlias.status).toBe(200);
    expect(await widgetAlias.text()).toContain("JanuaWidget");
  });
});

function adminHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${DEFAULT_ADMIN_KEY}` };
}

function testAgentConfig(
  overrides: {
    adminPassword?: string;
    webhookUrl?: string;
    triggerWords?: string[];
    prompts?: Partial<PromptTemplates>;
  } = {},
): AgentRuntimeConfig {
  return {
    admin: {
      password: overrides.adminPassword ?? "",
    },
    llm: {
      provider: "fake",
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "llama3.2:3b",
      openaiBaseUrl: "https://api.openai.com/v1",
      openaiModel: "gpt-4o-mini",
    },
    leadCapture: {
      triggerWords: overrides.triggerWords ?? ["talk to someone", "get a quote", "interested", "contact me"],
      webhookUrl: overrides.webhookUrl ?? "",
    },
    prompts: {
      ...DEFAULT_PROMPT_TEMPLATES,
      ...overrides.prompts,
    },
  };
}

class CapturingLLMProvider implements LLMProvider {
  lastMessages: Message[] = [];
  calls: Message[][] = [];

  async *chat(messages: Message[]): AsyncIterable<ChatChunk> {
    this.lastMessages = messages;
    this.calls.push(messages);
    yield { content: "ok", done: false };
    yield { content: "", done: true };
  }
}

class QueuedLLMProvider implements LLMProvider {
  calls = 0;

  constructor(private readonly responses: string[]) {}

  async *chat(): AsyncIterable<ChatChunk> {
    const response = this.responses[this.calls] ?? "";
    this.calls += 1;
    yield { content: response, done: false };
    yield { content: "", done: true };
  }
}
