import type {
  BusinessInfo,
  ConversationMessage,
  ConversationRecord,
  AdminSession,
  AdminUser,
  LeadRecord,
  PublicWidgetConfig,
  QAPair,
} from "./types.js";
import { normalizeBusinessInfo } from "./business-info.js";
import { DEFAULT_LEAD_FORM_CONFIG } from "./lead-form.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface JanuaStore {
  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
  getBusinessInfo(): BusinessInfo;
  setBusinessInfo(info: BusinessInfo): void;
  listQAPairs(): QAPair[];
  upsertQAPair(input: Pick<QAPair, "question" | "answer" | "tags"> & { id?: string }): QAPair;
  deleteQAPair(id: string): boolean;
  getPublicWidgetConfig(): PublicWidgetConfig;
  setPublicWidgetConfig(config: PublicWidgetConfig): void;
  assertSiteToken(siteToken: string | undefined): void;
  ensureConversation(input: { conversationId: string; visitorId: string }): ConversationRecord;
  appendMessage(input: {
    conversationId: string;
    visitorId: string;
    message: ConversationMessage;
  }): void;
  loadRecentMessages(input: {
    conversationId: string;
    visitorId: string;
    limit: number;
  }): ConversationMessage[];
  loadConversationMessages(conversationId: string): ConversationMessage[];
  getConversation(conversationId: string): ConversationRecord | undefined;
  cleanupExpiredConversations(now: Date): { conversationsDeleted: number; messagesDeleted: number };
  upsertLead(input: LeadRecord): { id: string; isUpdate: boolean };
  updateLeadStatus(id: string, status: LeadRecord["status"]): LeadRecord | undefined;
  updateLeadNotification(id: string, status: LeadRecord["notificationStatus"], error?: string): void;
  listLeads(): LeadRecord[];
  getAdminUser(username: string): AdminUser | undefined;
  upsertAdminUser(input: AdminUser): AdminUser;
  createAdminSession(input: AdminSession): AdminSession;
  getAdminSession(tokenHash: string, now: Date): AdminSession | undefined;
  touchAdminSession(tokenHash: string, now: Date): void;
  deleteAdminSession(tokenHash: string): boolean;
  cleanupExpiredAdminSessions(now: Date): number;
}

export class InMemoryStore implements JanuaStore {
  private readonly conversations = new Map<string, ConversationRecord>();
  private readonly messages = new Map<string, ConversationMessage[]>();
  private readonly leads = new Map<string, LeadRecord>();
  private readonly adminUsers = new Map<string, AdminUser>();
  private readonly adminSessions = new Map<string, AdminSession>();
  private businessInfo: BusinessInfo = {
    business_name: "Janua Spa",
    phone: "+1-555-0130",
    email: "hello@januaspa.example",
    address: "123 Wellness Avenue",
    store_hours: "Mon-Sat 10am-7pm",
    services: "Janua Spa offers massage therapy, facials, body treatments, and gift cards.",
    custom_fields: {},
  };
  private qaPairs: QAPair[] = [
    {
      id: "qa_demo_1",
      question: "What services do you offer?",
      answer: "Janua Spa offers massage therapy, facials, body treatments, and gift cards.",
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];
  private settings = new Map<string, string>([
    ["site_token", "dev-site-token"],
    ["site_name", "Janua Spa"],
    ["widget.color", "#4F46E5"],
    ["widget.position", "bottom-right"],
    ["widget.greeting", "Hi! How can I help today?"],
    ["widget.avatar_url", ""],
    ["widget.dark_mode", "auto"],
    [
      "intent_trigger_words",
      JSON.stringify([
        "talk to someone",
        "get a quote",
        "interested",
        "contact me",
        "speak with",
        "need help",
        "想聊聊",
        "要报价",
        "感兴趣",
        "联系我",
      ]),
    ],
  ]);

  getSetting(key: string): string | undefined {
    return this.settings.get(key);
  }

  setSetting(key: string, value: string): void {
    this.settings.set(key, value);
  }

  getBusinessInfo(): BusinessInfo {
    return this.businessInfo;
  }

  setBusinessInfo(info: BusinessInfo): void {
    this.businessInfo = normalizeBusinessInfo(info);
  }

  listQAPairs(): QAPair[] {
    return [...this.qaPairs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  upsertQAPair(input: Pick<QAPair, "question" | "answer" | "tags"> & { id?: string }): QAPair {
    const now = new Date().toISOString();
    const existing = input.id ? this.qaPairs.find((pair) => pair.id === input.id) : undefined;
    if (existing) {
      existing.question = input.question;
      existing.answer = input.answer;
      existing.tags = input.tags;
      existing.updatedAt = now;
      return existing;
    }

    const pair: QAPair = {
      id: input.id ?? crypto.randomUUID(),
      question: input.question,
      answer: input.answer,
      tags: input.tags,
      createdAt: now,
      updatedAt: now,
    };
    this.qaPairs.push(pair);
    return pair;
  }

  deleteQAPair(id: string): boolean {
    const before = this.qaPairs.length;
    this.qaPairs = this.qaPairs.filter((pair) => pair.id !== id);
    return this.qaPairs.length !== before;
  }

  getPublicWidgetConfig(): PublicWidgetConfig {
    return {
      color: this.getSetting("widget.color") ?? "#4F46E5",
      position: (this.getSetting("widget.position") as PublicWidgetConfig["position"]) ?? "bottom-right",
      greeting: this.getSetting("widget.greeting") ?? "Hi! How can I help today?",
      avatarUrl: this.getSetting("widget.avatar_url") ?? "",
      darkMode: (this.getSetting("widget.dark_mode") as PublicWidgetConfig["darkMode"]) ?? "auto",
      siteName: publicWidgetSiteName(this.businessInfo.business_name),
      leadForm: DEFAULT_LEAD_FORM_CONFIG,
    };
  }

  setPublicWidgetConfig(config: PublicWidgetConfig): void {
    this.setSetting("widget.color", config.color);
    this.setSetting("widget.position", config.position);
    this.setSetting("widget.greeting", config.greeting);
    this.setSetting("widget.avatar_url", config.avatarUrl);
    this.setSetting("widget.dark_mode", config.darkMode);
    this.setSetting("site_name", config.siteName);
  }

  assertSiteToken(siteToken: string | undefined): void {
    if (!siteToken || siteToken !== this.getSetting("site_token")) {
      throw new Error("Invalid site token");
    }
  }

  ensureConversation(input: { conversationId: string; visitorId: string }): ConversationRecord {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * DAY_MS).toISOString();
    const existing = this.conversations.get(input.conversationId);
    if (existing) {
      if (existing.visitorId !== input.visitorId) {
        throw new Error("Conversation visitor mismatch");
      }
      existing.updatedAt = now;
      existing.expiresAt = expiresAt;
      return existing;
    }

    const conversation: ConversationRecord = {
      id: input.conversationId,
      visitorId: input.visitorId,
      createdAt: now,
      updatedAt: now,
      expiresAt,
    };
    this.conversations.set(input.conversationId, conversation);
    this.messages.set(input.conversationId, []);
    return conversation;
  }

  appendMessage(input: {
    conversationId: string;
    visitorId: string;
    message: ConversationMessage;
  }): void {
    this.ensureConversation({ conversationId: input.conversationId, visitorId: input.visitorId });
    this.messages.get(input.conversationId)?.push(input.message);
  }

  loadRecentMessages(input: {
    conversationId: string;
    visitorId: string;
    limit: number;
  }): ConversationMessage[] {
    this.ensureConversation({ conversationId: input.conversationId, visitorId: input.visitorId });
    const all = this.messages.get(input.conversationId) ?? [];
    return all.slice(-input.limit);
  }

  loadConversationMessages(conversationId: string): ConversationMessage[] {
    return [...(this.messages.get(conversationId) ?? [])];
  }

  getConversation(conversationId: string): ConversationRecord | undefined {
    return this.conversations.get(conversationId);
  }

  cleanupExpiredConversations(now: Date): { conversationsDeleted: number; messagesDeleted: number } {
    const cutoff = now.toISOString();
    let conversationsDeleted = 0;
    let messagesDeleted = 0;
    for (const [id, conversation] of this.conversations) {
      if (conversation.expiresAt < cutoff) {
        conversationsDeleted += 1;
        messagesDeleted += this.messages.get(id)?.length ?? 0;
        this.conversations.delete(id);
        this.messages.delete(id);
      }
    }
    return { conversationsDeleted, messagesDeleted };
  }

  upsertLead(input: LeadRecord): { id: string; isUpdate: boolean } {
    const since = Date.now() - DAY_MS;
    const existing = input.email
      ? [...this.leads.values()].find((lead) => lead.email === input.email && Date.parse(lead.createdAt) >= since)
      : undefined;
    if (existing) {
      const updated = { ...existing, ...input, id: existing.id, status: existing.status, createdAt: existing.createdAt };
      this.leads.set(existing.id, updated);
      return { id: existing.id, isUpdate: true };
    }

    this.leads.set(input.id, input);
    return { id: input.id, isUpdate: false };
  }

  updateLeadStatus(id: string, status: LeadRecord["status"]): LeadRecord | undefined {
    const lead = this.leads.get(id);
    if (!lead) return undefined;
    lead.status = status;
    return lead;
  }

  updateLeadNotification(id: string, status: LeadRecord["notificationStatus"], error?: string): void {
    const lead = this.leads.get(id);
    if (!lead) return;
    lead.notificationStatus = status;
    lead.lastNotifyError = error;
  }

  listLeads(): LeadRecord[] {
    return [...this.leads.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getAdminUser(username: string): AdminUser | undefined {
    return this.adminUsers.get(username);
  }

  upsertAdminUser(input: AdminUser): AdminUser {
    this.adminUsers.set(input.username, input);
    return input;
  }

  createAdminSession(input: AdminSession): AdminSession {
    this.adminSessions.set(input.tokenHash, input);
    return input;
  }

  getAdminSession(tokenHash: string, now: Date): AdminSession | undefined {
    const session = this.adminSessions.get(tokenHash);
    if (!session) return undefined;
    if (session.expiresAt <= now.toISOString()) {
      this.adminSessions.delete(tokenHash);
      return undefined;
    }
    return session;
  }

  touchAdminSession(tokenHash: string, now: Date): void {
    const session = this.adminSessions.get(tokenHash);
    if (!session) return;
    this.adminSessions.set(tokenHash, { ...session, lastSeenAt: now.toISOString() });
  }

  deleteAdminSession(tokenHash: string): boolean {
    return this.adminSessions.delete(tokenHash);
  }

  cleanupExpiredAdminSessions(now: Date): number {
    const cutoff = now.toISOString();
    let deleted = 0;
    for (const [tokenHash, session] of this.adminSessions) {
      if (session.expiresAt <= cutoff) {
        this.adminSessions.delete(tokenHash);
        deleted += 1;
      }
    }
    return deleted;
  }
}

function publicWidgetSiteName(businessName: string): string {
  const name = businessName.trim();
  if (!name || name === "Janua Spa") return "Chat with us";
  return name;
}
