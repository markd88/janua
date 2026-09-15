import type { BusinessInfo, ConversationMessage, LLMProvider, Message, QAPair } from "./types.js";

export interface BusinessIntentInput {
  businessInfo: BusinessInfo;
  qaPairs: QAPair[];
  history: ConversationMessage[];
  message: string;
  llm: LLMProvider;
}

export interface BusinessIntentResult {
  related: boolean;
  confidence: number;
  reason: string;
  redirectMessage: string | null;
  failed?: boolean;
}

export async function classifyBusinessIntent(input: BusinessIntentInput): Promise<BusinessIntentResult> {
  try {
    let content = "";
    for await (const chunk of input.llm.chat(buildBusinessIntentMessages(input), { temperature: 0, maxTokens: 220 })) {
      content += chunk.content;
    }
    return parseBusinessIntentResponse(content, input.businessInfo);
  } catch (error) {
    return {
      related: true,
      confidence: 0,
      reason: error instanceof Error ? `Intent classification failed: ${error.message}` : "Intent classification failed",
      redirectMessage: null,
      failed: true,
    };
  }
}

export function buildBusinessIntentMessages(input: Omit<BusinessIntentInput, "llm">): Message[] {
  return [
    {
      role: "system",
      content: [
        "You classify whether a visitor message is related to the configured business.",
        "Return only JSON in this exact shape:",
        "{\"related\": boolean, \"confidence\": number, \"reason\": string, \"redirectMessage\": string | null}",
        "",
        "Rules:",
        "- related=true if the message asks about this business, its services, products, policies, pricing, booking, availability, location, hours, staff, contact details, or follow-up.",
        "- related=true if the message is a normal conversational continuation of the recent conversation.",
        "- related=true if the business profile or Q&A indicates this topic may be part of the business.",
        "- related=false only when the request is clearly unrelated to the business.",
        "- If the message is unrelated, set related=false even when confidence is moderate.",
        "- If unsure whether the message is related, set related=true and use a low confidence score.",
        "- confidence is your certainty in the related/unrelated classification, not a switch for whether to reject.",
        "- Use confidence 0.90-1.00 for obvious cases, 0.70-0.89 for likely cases, 0.50-0.69 for moderate but still actionable cases, and below 0.50 only when genuinely uncertain.",
        "- If related=false, redirectMessage must politely decline the unrelated request and guide the visitor back to relevant business topics.",
        "- redirectMessage must be in the same language as the visitor message when possible.",
        "- redirectMessage must mention the business name when available.",
        "- redirectMessage must not answer the unrelated request.",
        "- redirectMessage must not invent business facts beyond the provided business profile and Q&A.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Business profile:\n${formatBusinessProfile(input.businessInfo)}`,
        `Known Q&A:\n${formatQASummary(input.qaPairs)}`,
        `Recent conversation:\n${formatRecentHistory(input.history)}`,
        `Visitor message:\n${input.message}`,
      ].join("\n\n"),
    },
  ];
}

export function parseBusinessIntentResponse(content: string, businessInfo: BusinessInfo): BusinessIntentResult {
  const jsonText = content.match(/\{[\s\S]*\}/)?.[0] ?? content;
  try {
    const parsed = JSON.parse(jsonText) as {
      related?: unknown;
      confidence?: unknown;
      reason?: unknown;
      redirectMessage?: unknown;
    };
    const related = parseRelated(parsed.related);
    const confidence = parseConfidence(parsed.confidence);
    const reason = typeof parsed.reason === "string" && parsed.reason.trim()
      ? parsed.reason.trim().slice(0, 500)
      : "Intent classification returned no reason";
    const redirectMessage = typeof parsed.redirectMessage === "string" && parsed.redirectMessage.trim()
      ? parsed.redirectMessage.trim().slice(0, 1_000)
      : related ? null : fallbackRedirectMessage(businessInfo);

    return {
      related,
      confidence,
      reason,
      redirectMessage,
    };
  } catch {
    return {
      related: true,
      confidence: 0,
      reason: "Intent classification returned invalid JSON",
      redirectMessage: null,
      failed: true,
    };
  }
}

export function fallbackRedirectMessage(businessInfo: BusinessInfo): string {
  const businessName = businessInfo.business_name || "this business";
  const serviceHint = businessInfo.services.trim()
    ? ` I can help with services like ${businessInfo.services.trim()}, as well as booking, pricing, hours, location, and contact details.`
    : " I can help with services, booking, pricing, hours, location, and contact details.";
  return `I'm here to help with questions about ${businessName}.${serviceHint} Could you ask something related to the business?`;
}

function formatBusinessProfile(businessInfo: BusinessInfo): string {
  const lines = [
    ["business_name", businessInfo.business_name],
    ["phone", businessInfo.phone],
    ["email", businessInfo.email],
    ["address", businessInfo.address],
    ["store_hours", businessInfo.store_hours],
    ["services", businessInfo.services],
    ...Object.entries(businessInfo.custom_fields),
  ].filter(([, value]) => value.trim().length > 0);

  return lines.length > 0
    ? lines.map(([field, value]) => `- ${field}: ${value}`).join("\n")
    : "No business profile has been configured.";
}

function formatQASummary(qaPairs: QAPair[]): string {
  if (qaPairs.length === 0) return "No Q&A has been configured.";
  return qaPairs
    .slice(0, 20)
    .map((pair) => {
      const tags = pair.tags.length > 0 ? ` Tags: ${pair.tags.join(", ")}` : "";
      const answer = pair.answer.length > 240 ? `${pair.answer.slice(0, 240)}...` : pair.answer;
      return `- Q: ${pair.question}\n  A: ${answer}${tags}`;
    })
    .join("\n");
}

function formatRecentHistory(history: ConversationMessage[]): string {
  if (history.length === 0) return "none";
  return history
    .slice(-6)
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function parseRelated(value: unknown): boolean {
  if (value === false) return false;
  if (typeof value === "string" && value.toLowerCase().trim() === "false") return false;
  return true;
}

function parseConfidence(value: unknown): number {
  if (typeof value === "number") return clampConfidence(value);
  if (typeof value !== "string") return 0;
  const parsed = Number.parseFloat(value);
  return clampConfidence(parsed > 1 ? parsed / 100 : parsed);
}
