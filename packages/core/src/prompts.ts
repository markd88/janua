import type { BusinessInfo, ConversationMessage, Message, QAPair } from "./types.js";
import { buildKnowledgeContext } from "./knowledge.js";

export type PromptTemplateKey =
  | "prompt.system"
  | "prompt.knowledge_injection"
  | "prompt.anti_hallucination"
  | "prompt.lead_capture"
  | "prompt.handoff";

export type PromptTemplates = Record<PromptTemplateKey, string>;

export interface BuildPromptMessagesInput {
  businessInfo: BusinessInfo;
  qaPairs: QAPair[];
  userMessage: string;
  history: ConversationMessage[];
  getSetting?: (key: string) => string | undefined;
  knowledgeMaxCharacters?: number;
}

export interface BuiltPromptMessages {
  messages: Message[];
  systemPrompt: string;
  knowledgePrompt: string;
  sources: ReturnType<typeof buildKnowledgeContext>["sources"];
}

export const DEFAULT_PROMPT_TEMPLATES: PromptTemplates = {
  "prompt.system": [
    "You are Janua, an AI front desk for {{business_name}}.",
    "Answer like a concise receptionist in a chat widget.",
    "Use the visitor's language when possible.",
    "Default to 1-2 short sentences.",
    "Do not add greetings, sign-offs, or generic endings unless they are natural for the visitor's message.",
  ].join("\n"),
  "prompt.knowledge_injection": [
    "Use only the approved business context below as your source of truth.",
    "",
    "{{knowledge_context}}",
  ].join("\n"),
  "prompt.anti_hallucination": [
    "Do not invent business facts, services, policies, availability, or prices that are not in the approved context.",
    "Do not invent policies about pricing, booking, availability, phone support, email support, or required contact methods.",
    "If a specific service, duration, or price is not clearly available in the approved context, do not imply that the business offers it.",
    "If the requested information is unavailable, say you do not have that specific information and ask the visitor to leave contact details in this chat for follow-up.",
    "Do not repeat unrelated business details.",
  ].join("\n"),
  "prompt.lead_capture": [
    "When follow-up is needed, ask the visitor to leave their contact details in this chat so the business can reach out.",
    "Do not tell the visitor to call, email, or use another contact channel unless the visitor specifically asks for contact details or the approved context explicitly instructs you to do so.",
    "For pricing questions, answer with the exact price, price range, package price, or pricing rule when it is available in the approved context.",
    "If pricing is not available in the approved context, say you do not have specific pricing information and ask the visitor to leave contact details in this chat for follow-up.",
    "Do not say that you can provide a quote unless the approved context includes enough pricing rules to do so.",
    "For unavailable pricing, prefer this pattern: \"I don't have specific pricing for that. Please leave your contact details here, and {{business_name}} can follow up.\"",
    "Invite the visitor to leave contact details when they ask to book, request a quote or follow-up, ask to speak with staff, or ask for information not available in the approved context.",
    "Keep the lead invitation brief and natural.",
    "Do not add a contact-detail prompt to simple factual answers that are fully answered by the approved context.",
  ].join("\n"),
  "prompt.handoff": [
    "When human follow-up is needed, briefly ask the visitor to leave contact details in this chat so the business can reach out.",
    "Do not redirect them to phone or email unless they ask for those details.",
  ].join("\n"),
};

export const PROMPT_TEMPLATE_KEYS = Object.keys(DEFAULT_PROMPT_TEMPLATES) as PromptTemplateKey[];

export function buildPromptMessages(input: BuildPromptMessagesInput): BuiltPromptMessages {
  const knowledge = buildKnowledgeContext({
    businessInfo: input.businessInfo,
    qaPairs: input.qaPairs,
    userMessage: input.userMessage,
    maxCharacters: input.knowledgeMaxCharacters,
  });

  const variables = {
    business_name: input.businessInfo.business_name || "this business",
    business_info_json: JSON.stringify(input.businessInfo, null, 2),
    knowledge_context: knowledge.promptPart || "No approved knowledge has been configured yet.",
    user_message: input.userMessage,
  };

  const rendered = PROMPT_TEMPLATE_KEYS.map((key) => renderPromptTemplate(resolveTemplate(key, input.getSetting), variables));
  const systemPrompt = rendered.filter(Boolean).join("\n\n");

  return {
    messages: [
      { role: "system", content: systemPrompt },
      ...input.history.map((message) => ({ role: message.role, content: message.content })),
    ],
    systemPrompt,
    knowledgePrompt: knowledge.promptPart,
    sources: knowledge.sources,
  };
}

export function getPromptTemplateSettings(getSetting: (key: string) => string | undefined): PromptTemplates {
  return Object.fromEntries(
    PROMPT_TEMPLATE_KEYS.map((key) => [key, getSetting(key) ?? DEFAULT_PROMPT_TEMPLATES[key]]),
  ) as PromptTemplates;
}

export function renderPromptTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => variables[key] ?? "");
}

function resolveTemplate(key: PromptTemplateKey, getSetting: BuildPromptMessagesInput["getSetting"]): string {
  const override = getSetting?.(key)?.trim();
  return override || DEFAULT_PROMPT_TEMPLATES[key];
}
