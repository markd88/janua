export type Role = "user" | "assistant" | "system";

export interface Message {
  role: Role;
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatChunk {
  content: string;
  done: boolean;
  usage?: { totalTokens: number };
}

export interface LLMProvider {
  chat(messages: Message[], options?: ChatOptions): AsyncIterable<ChatChunk>;
}

export interface BusinessInfo {
  business_name: string;
  phone: string;
  email: string;
  address: string;
  store_hours: string;
  services: string;
  custom_fields: Record<string, string>;
}

export interface QAPair {
  id: string;
  question: string;
  answer: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeSource {
  type: "qa" | "business_info";
  id?: string;
  question?: string;
  field?: string;
}

export interface KnowledgeContext {
  promptPart: string;
  sources: KnowledgeSource[];
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  sources?: KnowledgeSource[];
  createdAt: string;
}

export interface ConversationRecord {
  id: string;
  visitorId: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface LeadFormInput {
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  message: string;
  conversationId: string;
}

export interface AdminUser {
  username: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSession {
  id: string;
  tokenHash: string;
  username: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
}

export interface LeadRecord extends LeadFormInput {
  id: string;
  source: "janua-widget";
  status: "new" | "contacted" | "not_interested";
  notificationStatus: "not_configured" | "sent" | "failed";
  lastNotifyError?: string;
  createdAt: string;
}

export interface LeadCaptureResult {
  id: string;
  isUpdate: boolean;
  notificationStatus: LeadRecord["notificationStatus"];
}

export type LeadFormFieldKey = "name" | "email" | "phone" | "company";

export interface LeadFormFieldConfig {
  enabled: boolean;
  required: boolean;
  label: string;
  placeholder: string;
}

export type LeadFormConfig = Record<LeadFormFieldKey, LeadFormFieldConfig>;

export interface PublicWidgetConfig {
  color: string;
  position: "bottom-right" | "bottom-left";
  greeting: string;
  avatarUrl: string;
  darkMode: "auto" | "light" | "dark";
  siteName: string;
  leadForm: LeadFormConfig;
}
