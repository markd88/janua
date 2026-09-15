import {
  buildPromptMessages,
  DEFAULT_LEAD_FORM_CONFIG,
  DEFAULT_PROMPT_TEMPLATES,
  classifyBusinessIntent,
  deliverLeadWebhook,
  FakeLLMProvider,
  InMemoryStore,
  LeadCaptureFlow,
  AgentTraceLogger,
  PROMPT_TEMPLATE_KEYS,
  type BusinessInfo,
  type ConversationMessage,
  type JanuaStore,
  type KnowledgeSource,
  type LeadFormConfig,
  type LeadRecord,
  type LLMProvider,
  type QAPair,
} from "@janua/core";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_USERNAME,
  createAdminSession,
  ensureAdminAccount,
  hashSessionToken,
  verifyPassword,
} from "./admin-auth.js";
import { DEFAULT_ADMIN_KEY } from "./admin-defaults.js";
import { ZodError } from "zod";
import type { AgentRuntimeConfig } from "./agent-config.js";
import {
  apiError,
  createRateLimitMiddleware,
  createRequestLoggingMiddleware,
  createSecurityHeadersMiddleware,
  parseAllowedOrigins,
  resolveCorsOrigin,
  type RateLimitOptions,
} from "./security.js";
import {
  adminLoginSchema,
  businessInfoSchema,
  chatSchema,
  knowledgeSchema,
  leadSchema,
  leadStatusSchema,
  restoreConversationSchema,
} from "./validation.js";

const LEAD_SUBMITTED_USER_MESSAGE = "I just submitted the form.";
const LEAD_SUBMITTED_ASSISTANT_MESSAGE = "We received your form and will contact you soon.";
const CHAT_USER_DEDUPE_WINDOW_MS = 30_000;

export interface AppDependencies {
  store?: JanuaStore;
  llm?: LLMProvider;
  adminKey?: string;
  allowedOrigins?: string[];
  rateLimit?: RateLimitOptions;
  chatRateLimit?: RateLimitOptions;
  adminRateLimit?: RateLimitOptions;
  agentConfig?: AgentRuntimeConfig;
  leadNotifier?: (url: string, lead: LeadRecord) => Promise<void>;
  requestLogging?: boolean;
}

export function createApp(deps: AppDependencies = {}) {
  const app = new Hono();
  const store = deps.store ?? new InMemoryStore();
  const llm = deps.llm ?? new FakeLLMProvider();
  const adminKey = deps.adminKey ?? DEFAULT_ADMIN_KEY;
  const allowedOrigins = parseAllowedOrigins(deps.allowedOrigins?.join(","));
  const rateLimit = deps.rateLimit ?? { enabled: true, windowMs: 60_000, max: 60, trustProxy: false, maxBuckets: 10_000 };
  const chatRateLimit = deps.chatRateLimit ?? { ...rateLimit, max: Math.min(rateLimit.max, 10) };
  const adminRateLimit = deps.adminRateLimit ?? { ...rateLimit, max: 120 };
  const agentConfig = deps.agentConfig ?? defaultAgentConfig();
  const leadWebhookUrl = agentConfig.leadCapture.webhookUrl.trim();
  const leadNotifier = deps.leadNotifier ?? deliverLeadWebhook;
  const traceLogger = new AgentTraceLogger();
  ensureAdminAccount(store, {
    configuredPassword: agentConfig.admin.password,
  });

  if (deps.requestLogging ?? process.env.NODE_ENV !== "test") {
    app.use("*", createRequestLoggingMiddleware());
  }
  app.use("*", createSecurityHeadersMiddleware({ enabled: process.env.JANUA_SECURITY_HEADERS_ENABLED !== "false" }));

  const publicApiCors = cors({
    origin: (origin) => resolveCorsOrigin(resolveAllowedOrigins(store, allowedOrigins))(origin),
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-API-Key"],
  });

  app.use("/api/widget.js", publicApiCors);
  app.use("/api/widget-config", publicApiCors);
  app.use("/api/conversation/restore", publicApiCors);
  app.use("/api/chat", publicApiCors);
  app.use("/api/lead", publicApiCors);

  app.use("/api/widget-config", createRateLimitMiddleware(rateLimit));
  app.use("/api/conversation/restore", createRateLimitMiddleware(rateLimit));
  app.use("/api/chat", createRateLimitMiddleware(chatRateLimit, createChatRateLimitKeyResolver(chatRateLimit.trustProxy)));
  app.use("/api/lead", createRateLimitMiddleware(rateLimit));

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/admin", (c) => c.html(readAsset("admin", "index.html")));
  app.get("/demo", (c) => c.html(demoHtml(store.getSetting("site_token") ?? "dev-site-token")));
  app.get("/admin/admin.js", (c) => {
    c.header("Content-Type", "application/javascript; charset=utf-8");
    return c.body(readAsset("admin", "admin.js"));
  });
  app.get("/admin/*", (c) => c.html(readAsset("admin", "index.html")));
  app.get("/widget.js", (c) => {
    c.header("Content-Type", "application/javascript; charset=utf-8");
    return c.body(readAsset("widget", "widget.js"));
  });
  app.get("/api/widget.js", (c) => {
    c.header("Content-Type", "application/javascript; charset=utf-8");
    return c.body(readAsset("widget", "widget.js"));
  });

  app.get("/api/widget-config", (c) => {
    try {
      store.assertSiteToken(c.req.query("siteToken"));
      return c.json({
        ...store.getPublicWidgetConfig(),
        leadForm: DEFAULT_LEAD_FORM_CONFIG,
      });
    } catch {
      return apiError(c, 401, "SITE_TOKEN_INVALID", "Invalid site token");
    }
  });

  app.post("/api/conversation/restore", async (c) => {
    const bodyResult = await parseJson(c, restoreConversationSchema);
    if (!bodyResult.ok) return bodyResult.response;
    const body = bodyResult.data;

    try {
      store.assertSiteToken(body.siteToken);
      const conversation = store.ensureConversation({
        conversationId: body.conversationId,
        visitorId: body.visitorId,
      });
      const messages = store.loadRecentMessages({
        conversationId: body.conversationId,
        visitorId: body.visitorId,
        limit: 50,
      });
      return c.json({ conversationId: body.conversationId, messages, expiresAt: conversation.expiresAt });
    } catch (error) {
      return apiError(c, 401, "SITE_TOKEN_INVALID", errorMessage(error));
    }
  });

  app.post("/api/chat", async (c) => {
    const bodyResult = await parseJson(c, chatSchema);
    if (!bodyResult.ok) return bodyResult.response;
    const body = bodyResult.data;
    const trace = traceLogger.startTurn({
      conversationId: body.conversationId,
      visitorId: body.visitorId,
      provider: agentConfig.llm.provider,
      model: selectedModelName(agentConfig),
    });
    trace.event(
      "chat.request",
      {
        inputChars: body.message.length,
        questionSignals: detectQuestionSignals(body.message),
      },
      {
        userMessage: body.message,
      },
    );

    try {
      store.assertSiteToken(body.siteToken);
      store.ensureConversation({ conversationId: body.conversationId, visitorId: body.visitorId });
    } catch (error) {
      trace.error("chat.auth_failed", error);
      return apiError(c, 401, "SITE_TOKEN_INVALID", errorMessage(error));
    }

    const recentMessages = store.loadRecentMessages({
      conversationId: body.conversationId,
      visitorId: body.visitorId,
      limit: 20,
    });
    const now = new Date();
    const duplicateTurn = findRecentDuplicateUserTurn(recentMessages, body.message, now);
    if (duplicateTurn?.assistantMessage) {
      const replayAssistant = duplicateTurn.assistantMessage;
      trace.event("message.deduplicated", {
        role: "user",
        contentChars: body.message.length,
        windowMs: CHAT_USER_DEDUPE_WINDOW_MS,
        replayedAssistant: true,
      });

      return streamSSE(c, async (stream) => {
        await stream.writeSSE({ event: "token", data: JSON.stringify({ content: replayAssistant.content }) });
        await stream.writeSSE({ event: "sources", data: JSON.stringify({ sources: replayAssistant.sources ?? [] }) });
        await stream.writeSSE({ event: "done", data: JSON.stringify({ ok: true, deduplicated: true }) });
        trace.event("chat.done", {
          inputChars: body.message.length,
          outputChars: replayAssistant.content.length,
          chunkCount: 1,
          sourcesCount: replayAssistant.sources?.length ?? 0,
          deduplicated: true,
        });
      });
    }

    let history = recentMessages;
    if (duplicateTurn) {
      trace.event("message.deduplicated", {
        role: "user",
        contentChars: body.message.length,
        windowMs: CHAT_USER_DEDUPE_WINDOW_MS,
      });
    } else {
      const userMessage = { role: "user" as const, content: body.message, createdAt: now.toISOString() };
      store.appendMessage({
        conversationId: body.conversationId,
        visitorId: body.visitorId,
        message: userMessage,
      });
      history = [...recentMessages, userMessage].slice(-20);
      trace.event("message.appended", {
        role: "user",
        contentChars: body.message.length,
      });
    }

    trace.event(
      "conversation.context_loaded",
      {
        historyCount: history.length,
        historyChars: history.reduce((total, message) => total + message.content.length, 0),
        historyWindowLimit: 20,
      },
      {
        history: history.map((message) => ({ role: message.role, content: message.content })),
      },
    );
    const businessInfo = store.getBusinessInfo();
    const qaPairs = store.listQAPairs();
    const intent = await classifyBusinessIntent({
      businessInfo,
      qaPairs,
      history,
      message: body.message,
      llm,
    });
    const shouldRejectOffTopic = !intent.failed && !intent.related && Boolean(intent.redirectMessage);
    const intentEvent = shouldRejectOffTopic ? trace.warn.bind(trace) : trace.event.bind(trace);
    intentEvent(
      "intent.assessment",
      {
        related: intent.related,
        confidence: intent.confidence,
        reason: intent.reason,
        failed: intent.failed === true,
        rejected: shouldRejectOffTopic,
      },
      {
        redirectMessage: intent.redirectMessage,
      },
    );

    if (shouldRejectOffTopic) {
      const content = intent.redirectMessage ?? "I'm here to help with questions about this business. Could you ask something related to the business?";
      trace.warn("intent.off_topic_rejected", {
        confidence: intent.confidence,
        reason: intent.reason,
        outputChars: content.length,
      });

      return streamSSE(c, async (stream) => {
        await stream.writeSSE({ event: "token", data: JSON.stringify({ content }) });
        store.appendMessage({
          conversationId: body.conversationId,
          visitorId: body.visitorId,
          message: {
            role: "assistant",
            content,
            sources: [],
            createdAt: new Date().toISOString(),
          },
        });
        trace.event("message.appended", {
          role: "assistant",
          contentChars: content.length,
          sourcesCount: 0,
          reason: "off_topic_redirect",
        });
        await stream.writeSSE({ event: "sources", data: JSON.stringify({ sources: [] }) });
        await stream.writeSSE({ event: "done", data: JSON.stringify({ ok: true }) });
        trace.event("chat.done", {
          inputChars: body.message.length,
          outputChars: content.length,
          chunkCount: 1,
          sourcesCount: 0,
          grounded: false,
          riskLevel: "not_assessed",
          leadTriggered: false,
          offTopicRejected: true,
        });
      });
    }
    const prompt = buildPromptMessages({
      businessInfo,
      qaPairs,
      userMessage: body.message,
      history,
      getSetting: (key) => agentConfig.prompts[key as keyof typeof agentConfig.prompts],
    });
    const sourceSummary = summarizeSources(prompt.sources);
    const questionSignals = detectQuestionSignals(body.message);
    const grounding = assessGrounding({
      questionSignals,
      sourcesCount: prompt.sources.length,
      knowledgeChars: prompt.knowledgePrompt.length,
    });
    trace.event(
      "knowledge.selected",
      {
        businessInfoFields: businessInfoFields(businessInfo),
        qaTotal: qaPairs.length,
        qaMatched: prompt.sources.filter((source) => source.type === "qa").length,
        sourcesCount: prompt.sources.length,
        sourceSummary,
        knowledgeChars: prompt.knowledgePrompt.length,
      },
      {
        sources: prompt.sources,
        knowledgeContext: prompt.knowledgePrompt,
      },
    );
    const groundingEvent = grounding.riskLevel === "high" ? trace.warn.bind(trace) : trace.event.bind(trace);
    groundingEvent("grounding.assessment", {
      ...grounding,
      sourceSummary,
    });
    trace.event(
      "prompt.built",
      {
        messageCount: prompt.messages.length,
        systemPromptChars: prompt.systemPrompt.length,
        knowledgeChars: prompt.knowledgePrompt.length,
        antiHallucinationEnabled: Boolean(agentConfig.prompts["prompt.anti_hallucination"].trim()),
        promptTemplateModes: promptTemplateModes(agentConfig),
      },
      {
        messages: prompt.messages,
      },
    );
    const leadFlow = new LeadCaptureFlow(store, {
      triggerWords: agentConfig.leadCapture.triggerWords,
    });

    return streamSSE(c, async (stream) => {
      let content = "";
      let chunkCount = 0;
      let totalTokens: number | undefined;
      let firstTokenMs: number | undefined;
      const startedAt = Date.now();
      trace.event("llm.stream.start", {
        messageCount: prompt.messages.length,
      });
      try {
        for await (const chunk of llm.chat(prompt.messages)) {
          if (chunk.usage?.totalTokens !== undefined) {
            totalTokens = chunk.usage.totalTokens;
          }
          if (chunk.content) {
            if (firstTokenMs === undefined) {
              firstTokenMs = Date.now() - startedAt;
              trace.event("llm.first_token", { firstTokenMs });
            }
            chunkCount += 1;
            content += chunk.content;
            await stream.writeSSE({ event: "token", data: JSON.stringify({ content: chunk.content }) });
          }
        }
        trace.event(
          "llm.output.final",
          {
            outputChars: content.length,
            chunkCount,
            totalTokens,
            firstTokenMs,
            durationMs: Date.now() - startedAt,
          },
          {
            assistantMessage: content,
          },
        );
        trace.event("answer.assessment", assessAnswer({
          answer: content,
          grounding,
          questionSignals,
        }));

        store.appendMessage({
          conversationId: body.conversationId,
          visitorId: body.visitorId,
          message: {
            role: "assistant",
            content,
            sources: prompt.sources,
            createdAt: new Date().toISOString(),
          },
        });
        trace.event("message.appended", {
          role: "assistant",
          contentChars: content.length,
          sourcesCount: prompt.sources.length,
        });

        await stream.writeSSE({ event: "sources", data: JSON.stringify({ sources: prompt.sources }) });
        const leadDecision = await leadFlow.decideCapture({
          message: body.message,
          history,
          businessInfo,
          llm,
        });
        trace.event("lead.decision", {
          shouldCapture: leadDecision.shouldCapture,
          reason: leadDecision.reason,
        });
        if (leadDecision.shouldCapture) {
          await stream.writeSSE({ event: "lead", data: JSON.stringify(leadDecision) });
        }
        await stream.writeSSE({ event: "done", data: JSON.stringify({ ok: true }) });
        trace.event("chat.done", {
          inputChars: body.message.length,
          outputChars: content.length,
          chunkCount,
          sourcesCount: prompt.sources.length,
          grounded: grounding.grounded,
          riskLevel: grounding.riskLevel,
          leadTriggered: leadDecision.shouldCapture,
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        trace.error("chat.error", error, {
          outputChars: content.length,
          chunkCount,
          durationMs: Date.now() - startedAt,
        });
        await stream.writeSSE({ event: "error", data: JSON.stringify({ message: errorMessage(error) }) });
      }
    });
  });

  app.post("/api/lead", async (c) => {
    const bodyResult = await parseJson(c, leadSchema);
    if (!bodyResult.ok) return bodyResult.response;
    const body = bodyResult.data;

    try {
      store.assertSiteToken(body.siteToken);
      store.ensureConversation({ conversationId: body.conversationId, visitorId: body.visitorId });
    } catch (error) {
      return apiError(c, 401, "SITE_TOKEN_INVALID", errorMessage(error));
    }

    const leadFormError = validateLeadFormInput(body, DEFAULT_LEAD_FORM_CONFIG);
    if (leadFormError) {
      return apiError(c, 400, "REQUEST_INVALID", leadFormError);
    }

    try {
      const webhookUrl = leadWebhookUrl || undefined;
      const leadFlow = new LeadCaptureFlow(store, {
        triggerWords: agentConfig.leadCapture.triggerWords,
        notify: webhookUrl ? (lead) => leadNotifier(webhookUrl, lead) : undefined,
      });
      const result = await leadFlow.capture(body);
      appendLeadSubmissionMessages(store, {
        conversationId: body.conversationId,
        visitorId: body.visitorId,
      });
      return c.json({ success: true, leadId: result.id, notificationStatus: result.notificationStatus });
    } catch (error) {
      return apiError(c, 500, "SERVER_ERROR", errorMessage(error));
    }
  });

  app.use("/api/admin/*", createRateLimitMiddleware(adminRateLimit, adminRateLimitKey));

  app.post("/api/admin/login", async (c) => {
    if (!isSameOriginAdminRequest(c)) {
      return apiError(c, 403, "CORS_ORIGIN_DENIED", "Admin API requires a same-origin request");
    }
    const bodyResult = await parseJson(c, adminLoginSchema);
    if (!bodyResult.ok) return bodyResult.response;
    const body = bodyResult.data;
    const user = store.getAdminUser(ADMIN_USERNAME);
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      return apiError(c, 401, "AUTH_INVALID", "Invalid admin password");
    }

    const { session, token } = createAdminSession(store, ADMIN_USERNAME);
    c.header("Set-Cookie", buildAdminSessionCookie(token, session.expiresAt));
    return c.json({ authenticated: true, expiresAt: session.expiresAt });
  });

  app.post("/api/admin/logout", (c) => {
    if (!isSameOriginAdminRequest(c)) {
      return apiError(c, 403, "CORS_ORIGIN_DENIED", "Admin API requires a same-origin request");
    }
    const token = readCookie(c, ADMIN_SESSION_COOKIE);
    if (token) store.deleteAdminSession(hashSessionToken(token));
    c.header("Set-Cookie", clearAdminSessionCookie());
    return c.json({ success: true });
  });

  app.use("/api/admin/*", async (c, next) => {
    if (!isSameOriginAdminRequest(c)) {
      return apiError(c, 403, "CORS_ORIGIN_DENIED", "Admin API requires a same-origin request");
    }

    const auth = authenticateAdminRequest(c, store, adminKey);
    if (!auth.authenticated) {
      return apiError(c, 401, "AUTH_INVALID", "Admin login required");
    }
    await next();
  });

  app.get("/api/admin/session", (c) => c.json({ authenticated: true }));

  app.get("/api/admin/leads", (c) => {
    const pagination = parsePagination(c);
    const page = paginate(store.listLeads(), pagination);
    return c.json({ leads: page.items, pagination: page.pagination });
  });

  app.patch("/api/admin/leads/:id/status", async (c) => {
    const bodyResult = await parseJson(c, leadStatusSchema);
    if (!bodyResult.ok) return bodyResult.response;
    const lead = store.updateLeadStatus(c.req.param("id"), bodyResult.data.status);
    if (!lead) return apiError(c, 400, "REQUEST_INVALID", "Lead not found");
    return c.json({ lead });
  });

  app.get("/api/admin/conversations/:id/messages", (c) => {
    const messages = store.loadConversationMessages(c.req.param("id"));
    return c.json({ messages });
  });

  app.get("/api/admin/business-info", (c) => c.json({ businessInfo: store.getBusinessInfo() }));

  app.put("/api/admin/business-info", async (c) => {
    const bodyResult = await parseJson(c, businessInfoSchema);
    if (!bodyResult.ok) return bodyResult.response;
    const body: BusinessInfo = bodyResult.data;
    store.setBusinessInfo(body);
    return c.json({ businessInfo: store.getBusinessInfo() });
  });

  app.get("/api/admin/settings", (c) => c.json({ settings: buildAdminSettings(store, c.req.url) }));

  app.get("/api/admin/site", (c) => c.json({ site: buildSiteSettings(store, c.req.url) }));

  app.get("/api/admin/knowledge", (c) => {
    const pagination = parsePagination(c);
    const page = paginate(store.listQAPairs(), pagination);
    return c.json({ qaPairs: page.items, pagination: page.pagination });
  });

  app.post("/api/admin/knowledge", async (c) => {
    const bodyResult = await parseJson(c, knowledgeSchema);
    if (!bodyResult.ok) return bodyResult.response;
    const body = bodyResult.data;
    const pair = store.upsertQAPair({
      question: body.question,
      answer: body.answer,
      tags: body.tags ?? [],
    });
    return c.json({ qaPair: pair }, 201);
  });

  app.put("/api/admin/knowledge/:id", async (c) => {
    const bodyResult = await parseJson(c, knowledgeSchema);
    if (!bodyResult.ok) return bodyResult.response;
    const body = bodyResult.data;
    const pair = store.upsertQAPair({
      id: c.req.param("id"),
      question: body.question,
      answer: body.answer,
      tags: body.tags ?? [],
    });
    return c.json({ qaPair: pair });
  });

  app.delete("/api/admin/knowledge/:id", (c) => {
    const deleted = store.deleteQAPair(c.req.param("id"));
    return c.json({ deleted });
  });

  return app;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}

function defaultAgentConfig(): AgentRuntimeConfig {
  return {
    admin: {
      password: "",
    },
    llm: {
      provider: "fake",
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "llama3.2:3b",
      openaiBaseUrl: "https://api.openai.com/v1",
      openaiModel: "gpt-4o-mini",
    },
    leadCapture: {
      triggerWords: ["talk to someone", "get a quote", "interested", "contact me"],
      webhookUrl: "",
    },
    prompts: DEFAULT_PROMPT_TEMPLATES,
  };
}

function selectedModelName(agentConfig: AgentRuntimeConfig): string {
  if (agentConfig.llm.provider === "ollama") return agentConfig.llm.ollamaModel;
  if (agentConfig.llm.provider === "openai") return agentConfig.llm.openaiModel;
  return "fake";
}

function detectQuestionSignals(message: string) {
  const normalized = message.toLowerCase();
  const pricing = includesAny(normalized, ["price", "pricing", "quote", "cost", "fee", "多少钱", "价格", "报价", "费用"]);
  const deployment = includesAny(normalized, ["deploy", "deployment", "self-host", "private", "私有化", "部署", "本地"]);
  const contact = includesAny(normalized, ["phone", "email", "contact", "address", "电话", "邮箱", "联系", "地址"]);
  const booking = includesAny(normalized, ["book", "appointment", "schedule", "预约", "预订"]);
  return {
    pricing,
    deployment,
    contact,
    booking,
    requiresBusinessFact: pricing || deployment || contact || booking,
  };
}

function includesAny(value: string, candidates: string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}

function businessInfoFields(businessInfo: BusinessInfo): string[] {
  return [
    ["business_name", businessInfo.business_name],
    ["phone", businessInfo.phone],
    ["email", businessInfo.email],
    ["address", businessInfo.address],
    ["store_hours", businessInfo.store_hours],
    ["services", businessInfo.services],
    ...Object.entries(businessInfo.custom_fields),
  ].flatMap(([field, value]) => value.trim().length > 0 ? [field] : []);
}

function summarizeSources(sources: KnowledgeSource[]) {
  return {
    businessInfoCount: sources.filter((source) => source.type === "business_info").length,
    qaCount: sources.filter((source) => source.type === "qa").length,
    fields: sources.flatMap((source) => source.type === "business_info" && source.field ? [source.field] : []),
    qaIds: sources.flatMap((source) => source.type === "qa" && source.id ? [source.id] : []),
  };
}

function assessGrounding(input: {
  questionSignals: ReturnType<typeof detectQuestionSignals>;
  sourcesCount: number;
  knowledgeChars: number;
}) {
  const riskReasons: string[] = [];
  if (input.sourcesCount === 0) riskReasons.push("no_relevant_source");
  if (input.knowledgeChars === 0) riskReasons.push("empty_knowledge_context");
  if (input.questionSignals.requiresBusinessFact && input.sourcesCount === 0) {
    riskReasons.push("business_fact_question_without_source");
  }
  if (input.questionSignals.pricing && input.sourcesCount === 0) {
    riskReasons.push("pricing_question_without_source");
  }

  const riskLevel = riskReasons.length === 0 ? "low" : input.questionSignals.requiresBusinessFact ? "high" : "medium";
  return {
    grounded: input.sourcesCount > 0 && input.knowledgeChars > 0,
    riskLevel,
    riskReasons,
    recommendedBehavior: riskLevel === "high" ? "answer_with_uncertainty_or_handoff" : "answer_normally",
  };
}

function promptTemplateModes(agentConfig: AgentRuntimeConfig): Record<string, "default" | "custom"> {
  return Object.fromEntries(
    PROMPT_TEMPLATE_KEYS.map((key) => [
      key,
      agentConfig.prompts[key] === DEFAULT_PROMPT_TEMPLATES[key] ? "default" : "custom",
    ]),
  );
}

function assessAnswer(input: {
  answer: string;
  grounding: ReturnType<typeof assessGrounding>;
  questionSignals: ReturnType<typeof detectQuestionSignals>;
}) {
  const normalizedAnswer = input.answer.toLowerCase();
  const uncertaintySignals = includesAny(normalizedAnswer, [
    "do not have",
    "don't have",
    "not available",
    "没有",
    "不清楚",
    "无法确认",
    "需要进一步确认",
  ]);
  const containsPricingClaim = input.questionSignals.pricing && /\d|[$¥€£]/.test(input.answer);
  const shouldHaveQualified = input.grounding.riskLevel === "high";

  return {
    grounded: input.grounding.grounded,
    riskLevel: input.grounding.riskLevel,
    containsPricingClaim,
    containsUncertaintyQualifier: uncertaintySignals,
    shouldHaveQualified,
    answeredWithoutQualifier: shouldHaveQualified && !uncertaintySignals,
  };
}

function resolveAllowedOrigins(_store: JanuaStore, fallback: string[]): string[] {
  return fallback;
}

function isSameOriginAdminRequest(c: Context): boolean {
  const fetchSite = c.req.header("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;

  const origin = c.req.header("Origin");
  if (!origin) return true;

  try {
    return new URL(origin).origin === new URL(c.req.url).origin;
  } catch {
    return false;
  }
}

function authenticateAdminRequest(c: Context, store: JanuaStore, adminKey: string): { authenticated: boolean; username?: string } {
  const token = readCookie(c, ADMIN_SESSION_COOKIE);
  if (token) {
    const tokenHash = hashSessionToken(token);
    const session = store.getAdminSession(tokenHash, new Date());
    if (session) {
      store.touchAdminSession(tokenHash, new Date());
      return { authenticated: true, username: session.username };
    }
  }

  const authorization = c.req.header("Authorization");
  const bearerToken = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  const apiKey = c.req.header("x-api-key");
  return (bearerToken ?? apiKey) === adminKey ? { authenticated: true } : { authenticated: false };
}

function readCookie(c: Context, name: string): string | undefined {
  const header = c.req.header("Cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rawValue.join("="));
  }
  return undefined;
}

function buildAdminSessionCookie(token: string, expiresAt: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000));
  return `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function clearAdminSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function adminRateLimitKey(c: Context): string {
  const sessionToken = readCookie(c, ADMIN_SESSION_COOKIE);
  if (sessionToken) return `admin-session:${hashSessionToken(sessionToken).slice(0, 16)}`;
  const authorization = c.req.header("Authorization");
  const bearerToken = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  const token = bearerToken ?? c.req.header("x-api-key");
  if (!token) return "admin:anonymous";
  return `admin:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
}

function buildAdminSettings(store: JanuaStore, requestUrl: string) {
  return {
    businessInfo: store.getBusinessInfo(),
    site: buildSiteSettings(store, requestUrl),
    runtime: {
      nodeEnv: process.env.NODE_ENV ?? "development",
      publicBaseUrl: process.env.JANUA_PUBLIC_BASE_URL ?? "",
      databaseConfigured: Boolean(process.env.JANUA_DB_PATH),
      rateLimitEnabled: process.env.JANUA_RATE_LIMIT_ENABLED !== "false",
      trustProxy: process.env.JANUA_TRUST_PROXY === "true",
      securityHeadersEnabled: process.env.JANUA_SECURITY_HEADERS_ENABLED !== "false",
      conversationCleanupEnabled: process.env.JANUA_CONVERSATION_CLEANUP_ENABLED !== "false",
    },
    secrets: {},
  };
}

function buildSiteSettings(store: JanuaStore, requestUrl: string) {
  const publicBaseUrl = (process.env.JANUA_PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const baseUrl = publicBaseUrl || new URL(requestUrl).origin;
  const widgetScriptUrl = `${baseUrl}/api/widget.js`;
  const siteToken = store.getSetting("site_token") ?? "";
  return {
    baseUrl,
    widgetScriptUrl,
    embedCode: `<script
  src="${widgetScriptUrl}"
  data-token="${siteToken}"
  defer
></script>`,
  };
}

function createChatRateLimitKeyResolver(trustProxy: boolean) {
  return async (c: Context): Promise<string> => {
    const client = requestClientKey(c, trustProxy);
    const body = await c.req.raw
      .clone()
      .json()
      .catch(() => null);

    if (!isRateLimitChatBody(body)) return `chat:${client}`;
    return `chat:${body.siteToken}:${body.visitorId}:${body.conversationId}:${client}`;
  };
}

function isRateLimitChatBody(value: unknown): value is { siteToken: string; visitorId: string; conversationId: string } {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.siteToken === "string" &&
    typeof candidate.visitorId === "string" &&
    typeof candidate.conversationId === "string"
  );
}

function requestClientKey(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwardedFor = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    return forwardedFor || c.req.header("x-real-ip") || "trusted-proxy";
  }
  return "direct";
}

function findRecentDuplicateUserTurn(
  messages: ConversationMessage[],
  content: string,
  now: Date,
): { userMessage: ConversationMessage; assistantMessage?: ConversationMessage } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "user" || message.content !== content) continue;
    const createdAt = Date.parse(message.createdAt);
    if (Number.isNaN(createdAt) || now.getTime() - createdAt > CHAT_USER_DEDUPE_WINDOW_MS) continue;

    return {
      userMessage: message,
      assistantMessage: messages.slice(index + 1).find((candidate) => candidate.role === "assistant"),
    };
  }

  return undefined;
}

interface PaginationInput {
  page: number;
  limit: number;
}

function parsePagination(c: Context): PaginationInput {
  return {
    page: clampInteger(c.req.query("page"), 1, 10_000, 1),
    limit: clampInteger(c.req.query("limit"), 1, 100, 20),
  };
}

function paginate<T>(items: T[], input: PaginationInput): { items: T[]; pagination: PaginationInput & { total: number } } {
  const start = (input.page - 1) * input.limit;
  return {
    items: items.slice(start, start + input.limit),
    pagination: { ...input, total: items.length },
  };
}

function clampInteger(value: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function validateLeadFormInput(
  input: { name: string; email?: string; phone?: string; company?: string },
  config: LeadFormConfig,
): string | undefined {
  for (const key of ["name", "email", "phone", "company"] as const) {
    if (config[key].required && !input[key]?.trim()) {
      return `${config[key].label} is required`;
    }
  }
  return undefined;
}

function appendLeadSubmissionMessages(
  store: JanuaStore,
  input: { conversationId: string; visitorId: string },
): void {
  const submittedAt = new Date().toISOString();
  store.appendMessage({
    conversationId: input.conversationId,
    visitorId: input.visitorId,
    message: {
      role: "user",
      content: LEAD_SUBMITTED_USER_MESSAGE,
      createdAt: submittedAt,
    },
  });
  store.appendMessage({
    conversationId: input.conversationId,
    visitorId: input.visitorId,
    message: {
      role: "assistant",
      content: LEAD_SUBMITTED_ASSISTANT_MESSAGE,
      createdAt: new Date().toISOString(),
    },
  });
}

type ParseResult<T> = { ok: true; data: T } | { ok: false; response: Response };

async function parseJson<T>(c: Context, schema: { parse(value: unknown): T }): Promise<ParseResult<T>> {
  try {
    return { ok: true, data: schema.parse(await c.req.json()) };
  } catch (error) {
    return { ok: false, response: errorResponse(c, error, "REQUEST_INVALID", 400) };
  }
}

function errorResponse(
  c: Context,
  error: unknown,
  fallbackCode: "REQUEST_INVALID" | "SITE_TOKEN_INVALID",
  fallbackStatus: 400 | 401,
): Response {
  if (error instanceof ZodError) {
    return apiError(c, 400, "REQUEST_INVALID", error.issues[0]?.message ?? "Invalid request body");
  }
  return apiError(c, fallbackStatus, fallbackCode, errorMessage(error));
}

function readAsset(packageName: "admin" | "widget", fileName: string): string {
  const overrideDir =
    packageName === "admin" ? process.env.JANUA_ADMIN_DIST_DIR : process.env.JANUA_WIDGET_DIST_DIR;
  const candidates = [
    overrideDir ? join(overrideDir, fileName) : "",
    join(process.cwd(), `../${packageName}/dist`, fileName),
    join(process.cwd(), `packages/${packageName}/dist`, fileName),
  ].filter(Boolean);

  const asset = candidates.find((candidate) => existsSync(candidate));
  if (!asset) {
    throw new Error(`Missing ${packageName} asset ${fileName}. Run pnpm build first.`);
  }
  return readFileSync(asset, "utf8");
}

function demoHtml(siteToken: string): string {
  const escapedSiteToken = escapeHtmlAttribute(siteToken);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Welcome to Janua Spa</title>
    <style>
      body { margin: 0; min-height: 100vh; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: linear-gradient(135deg, #eef2ff, #f8fafc); color: #111827; }
      main { max-width: 900px; margin: 0 auto; padding: 80px 24px; }
      section { padding: 48px; border-radius: 32px; background: rgba(255,255,255,.82); border: 1px solid rgba(15,23,42,.08); box-shadow: 0 24px 80px rgba(15,23,42,.12); }
      ol { display: grid; gap: 16px; padding-left: 24px; font-size: 18px; line-height: 1.6; }
      a { color: #4f46e5; font-weight: 800; }
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>Welcome to Janua Spa</h1>
        <ol>
          <li><a href="/admin/knowledge">Open Business Knowledge</a> in Admin and fill in your business info so the AI knows what business it is answering for.</li>
          <li>Come back to this demo page and use the AI chat in the bottom-right corner.</li>
          <li>Try asking <strong>What spa services do you offer?</strong> or <strong>I want to book a massage</strong>, then go back to Admin to check the captured lead.</li>
        </ol>
      </section>
    </main>
    <script src="/widget.js" data-token="${escapedSiteToken}" data-base-url=""></script>
  </body>
</html>`;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
