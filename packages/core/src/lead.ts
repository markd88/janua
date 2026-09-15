import type { BusinessInfo, ConversationMessage, LeadCaptureResult, LeadFormInput, LeadRecord, LLMProvider, Message } from "./types.js";
import type { JanuaStore } from "./store.js";

export interface LeadCaptureFlowOptions {
  triggerWords: string[];
  notify?: (lead: LeadRecord) => Promise<void>;
}

export interface LeadCaptureDecisionInput {
  message: string;
  history: ConversationMessage[];
  businessInfo: BusinessInfo;
  llm: LLMProvider;
}

export interface LeadCaptureDecision {
  shouldCapture: boolean;
  reason: "trigger_word" | "ai_judgement" | "none";
  detail?: string;
}

export class LeadCaptureFlow {
  constructor(
    private readonly store: JanuaStore,
    private readonly options: LeadCaptureFlowOptions,
  ) {}

  shouldCapture(message: string): boolean {
    const normalized = message.toLowerCase();
    return this.options.triggerWords.some((word) => normalized.includes(word.toLowerCase()));
  }

  async decideCapture(input: LeadCaptureDecisionInput): Promise<LeadCaptureDecision> {
    if (this.shouldCapture(input.message)) {
      return { shouldCapture: true, reason: "trigger_word" };
    }

    const aiDecision = await judgeLeadIntent(input);
    if (aiDecision.shouldCapture) {
      return { shouldCapture: true, reason: "ai_judgement", detail: aiDecision.reason };
    }

    return { shouldCapture: false, reason: "none", detail: aiDecision.reason };
  }

  async capture(input: LeadFormInput): Promise<LeadCaptureResult> {
    const lead: LeadRecord = {
      id: crypto.randomUUID(),
      ...input,
      source: "janua-widget",
      status: "new",
      notificationStatus: "not_configured",
      createdAt: new Date().toISOString(),
    };

    const result = this.store.upsertLead(lead);
    if (!this.options.notify) {
      return { ...result, notificationStatus: "not_configured" };
    }

    try {
      await this.options.notify(lead);
      this.store.updateLeadNotification(result.id, "sent");
      return { ...result, notificationStatus: "sent" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown notification error";
      this.store.updateLeadNotification(result.id, "failed", message);
      return { ...result, notificationStatus: "failed" };
    }
  }
}

export function parseTriggerWords(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((word): word is string => typeof word === "string") : [];
  } catch {
    return raw
      .split(",")
      .map((word) => word.trim())
      .filter(Boolean);
  }
}

async function judgeLeadIntent(input: LeadCaptureDecisionInput): Promise<{ shouldCapture: boolean; reason: string }> {
  try {
    let content = "";
    for await (const chunk of input.llm.chat(buildLeadJudgeMessages(input), { temperature: 0, maxTokens: 120 })) {
      content += chunk.content;
    }
    return parseLeadJudgeResponse(content);
  } catch {
    return { shouldCapture: false, reason: "AI lead judgement failed" };
  }
}

function buildLeadJudgeMessages(input: LeadCaptureDecisionInput): Message[] {
  const recentHistory = input.history
    .slice(-6)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
  return [
    {
      role: "system",
      content:
        "You decide whether a website visitor should be asked for contact details. " +
        "Return only JSON in this exact shape: {\"shouldCapture\": boolean, \"reason\": string}. " +
        "Return true when the visitor shows intent to book, buy, get pricing, request a quote, schedule an appointment, talk to staff, or receive follow-up. " +
        "Return false for general questions, casual greetings, or browsing.",
    },
    {
      role: "user",
      content: [
        `Business: ${input.businessInfo.business_name || "Unknown business"}`,
        recentHistory ? `Recent conversation:\n${recentHistory}` : "Recent conversation: none",
        `Latest visitor message: ${input.message}`,
      ].join("\n\n"),
    },
  ];
}

function parseLeadJudgeResponse(content: string): { shouldCapture: boolean; reason: string } {
  const jsonText = content.match(/\{[\s\S]*\}/)?.[0] ?? content;
  try {
    const parsed = JSON.parse(jsonText) as { shouldCapture?: unknown; reason?: unknown };
    return {
      shouldCapture: parsed.shouldCapture === true,
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 240) : "AI lead judgement",
    };
  } catch {
    return { shouldCapture: false, reason: "AI lead judgement returned invalid JSON" };
  }
}
