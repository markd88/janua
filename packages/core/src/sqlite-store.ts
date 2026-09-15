import { dirname, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./db/schema.js";
import type {
  AdminSession,
  AdminUser,
  BusinessInfo,
  ConversationMessage,
  ConversationRecord,
  LeadRecord,
  PublicWidgetConfig,
  QAPair,
} from "./types.js";
import type { JanuaStore } from "./store.js";
import { normalizeBusinessInfo } from "./business-info.js";
import { DEFAULT_LEAD_FORM_CONFIG } from "./lead-form.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SqliteStoreOptions {
  filename: string;
  seedDefaultSiteToken?: boolean;
  migrationsFolder?: string;
}

export class SqliteStore implements JanuaStore {
  private constructor(
    private readonly db: Database.Database,
    private readonly orm: BetterSQLite3Database<typeof schema>,
  ) {}

  static create(options: SqliteStoreOptions): SqliteStore {
    if (options.filename !== ":memory:") {
      mkdirSync(dirname(options.filename), { recursive: true });
    }
    const db = new Database(options.filename);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    const store = new SqliteStore(db, drizzle(db, { schema }));
    store.initialize({
      seedDefaultSiteToken: options.seedDefaultSiteToken ?? true,
      migrationsFolder: options.migrationsFolder ?? findMigrationsFolder(),
    });
    return store;
  }

  getSetting(key: string): string | undefined {
    const row = this.orm.select({ value: schema.settings.value }).from(schema.settings).where(eq(schema.settings.key, key)).get();
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.orm
      .insert(schema.settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
      .run();
  }

  getBusinessInfo(): BusinessInfo {
    const raw = this.getSetting("business_info");
    if (!raw) return defaultBusinessInfo();
    return normalizeBusinessInfo(JSON.parse(raw));
  }

  setBusinessInfo(info: BusinessInfo): void {
    this.setSetting("business_info", JSON.stringify(normalizeBusinessInfo(info)));
  }

  listQAPairs(): QAPair[] {
    const rows = this.orm.select().from(schema.knowledge).orderBy(desc(schema.knowledge.updatedAt)).all();
    return rows.map((row) => ({
      id: row.id,
      question: row.question,
      answer: row.answer,
      tags: JSON.parse(row.tags) as string[],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  upsertQAPair(input: Pick<QAPair, "question" | "answer" | "tags"> & { id?: string }): QAPair {
    const now = new Date().toISOString();
    const id = input.id ?? crypto.randomUUID();
    const existing = input.id ? this.findQAPair(input.id) : undefined;
    const createdAt = existing?.createdAt ?? now;
    this.orm
      .insert(schema.knowledge)
      .values({
        id,
        question: input.question,
        answer: input.answer,
        tags: JSON.stringify(input.tags),
        createdAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.knowledge.id,
        set: {
          question: input.question,
          answer: input.answer,
          tags: JSON.stringify(input.tags),
          updatedAt: now,
        },
      })
      .run();
    return { id, question: input.question, answer: input.answer, tags: input.tags, createdAt, updatedAt: now };
  }

  deleteQAPair(id: string): boolean {
    const result = this.orm.delete(schema.knowledge).where(eq(schema.knowledge.id, id)).run();
    return result.changes > 0;
  }

  getPublicWidgetConfig(): PublicWidgetConfig {
    return {
      color: this.getSetting("widget.color") ?? "#4F46E5",
      position: (this.getSetting("widget.position") as PublicWidgetConfig["position"]) ?? "bottom-right",
      greeting: this.getSetting("widget.greeting") ?? "Hi! How can I help today?",
      avatarUrl: this.getSetting("widget.avatar_url") ?? "",
      darkMode: (this.getSetting("widget.dark_mode") as PublicWidgetConfig["darkMode"]) ?? "auto",
      siteName: publicWidgetSiteName(this.getBusinessInfo().business_name),
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
    const existing = this.getConversation(input.conversationId);
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * DAY_MS).toISOString();

    if (existing) {
      if (existing.visitorId !== input.visitorId) {
        throw new Error("Conversation visitor mismatch");
      }
      this.orm
        .update(schema.conversations)
        .set({ updatedAt: now, expiresAt })
        .where(eq(schema.conversations.id, input.conversationId))
        .run();
      return { ...existing, updatedAt: now, expiresAt };
    }

    const conversation: ConversationRecord = {
      id: input.conversationId,
      visitorId: input.visitorId,
      createdAt: now,
      updatedAt: now,
      expiresAt,
    };
    this.orm.insert(schema.conversations).values(conversation).run();
    return conversation;
  }

  appendMessage(input: {
    conversationId: string;
    visitorId: string;
    message: ConversationMessage;
  }): void {
    this.ensureConversation({ conversationId: input.conversationId, visitorId: input.visitorId });
    this.orm
      .insert(schema.messages)
      .values({
        id: crypto.randomUUID(),
        conversationId: input.conversationId,
        role: input.message.role,
        content: input.message.content,
        sources: JSON.stringify(input.message.sources ?? []),
        createdAt: input.message.createdAt,
      })
      .run();
  }

  loadRecentMessages(input: {
    conversationId: string;
    visitorId: string;
    limit: number;
  }): ConversationMessage[] {
    this.ensureConversation({ conversationId: input.conversationId, visitorId: input.visitorId });
    const rows = this.orm
      .select({
        role: schema.messages.role,
        content: schema.messages.content,
        sources: schema.messages.sources,
        createdAt: schema.messages.createdAt,
      })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, input.conversationId))
      .orderBy(desc(schema.messages.createdAt))
      .limit(input.limit)
      .all();
    return rows.map(rowToConversationMessage).reverse();
  }

  loadConversationMessages(conversationId: string): ConversationMessage[] {
    const rows = this.orm
      .select({
        role: schema.messages.role,
        content: schema.messages.content,
        sources: schema.messages.sources,
        createdAt: schema.messages.createdAt,
      })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .orderBy(schema.messages.createdAt)
      .all();
    return rows.map(rowToConversationMessage);
  }

  getConversation(conversationId: string): ConversationRecord | undefined {
    const row = this.orm
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conversationId))
      .get();
    if (!row) return undefined;
    return {
      id: row.id,
      visitorId: row.visitorId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      expiresAt: row.expiresAt,
    };
  }

  cleanupExpiredConversations(now: Date): { conversationsDeleted: number; messagesDeleted: number } {
    const cutoff = now.toISOString();
    const transaction = this.db.transaction(() => {
      const expiredIds = this.orm
        .select({ id: schema.conversations.id })
        .from(schema.conversations)
        .where(lt(schema.conversations.expiresAt, cutoff))
        .all()
        .map((row) => row.id);
      const messagesDeleted = expiredIds.length
        ? this.orm.delete(schema.messages).where(inArray(schema.messages.conversationId, expiredIds)).run().changes
        : 0;
      const conversationsDeleted = expiredIds.length
        ? this.orm.delete(schema.conversations).where(inArray(schema.conversations.id, expiredIds)).run().changes
        : 0;
      return { conversationsDeleted, messagesDeleted };
    });
    return transaction();
  }

  upsertLead(input: LeadRecord): { id: string; isUpdate: boolean } {
    const since = new Date(Date.now() - DAY_MS).toISOString();
    const existing = input.email
      ? this.orm
          .select({
            id: schema.leads.id,
            status: schema.leads.status,
            createdAt: schema.leads.createdAt,
          })
          .from(schema.leads)
          .where(and(eq(schema.leads.email, input.email), gte(schema.leads.createdAt, since)))
          .limit(1)
          .get()
      : undefined;
    const id = existing?.id ?? input.id;
    const createdAt = existing?.createdAt ?? input.createdAt;
    const status = existing?.status ?? input.status;

    this.orm
      .insert(schema.leads)
      .values({
        id,
        conversationId: input.conversationId,
        name: input.name,
        email: input.email ?? "",
        phone: input.phone ?? "",
        company: input.company ?? "",
        message: input.message,
        source: input.source,
        status,
        notificationStatus: input.notificationStatus,
        lastNotifyError: input.lastNotifyError ?? "",
        createdAt,
      })
      .onConflictDoUpdate({
        target: schema.leads.id,
        set: {
          conversationId: input.conversationId,
          name: input.name,
          phone: input.phone ?? "",
          company: input.company ?? "",
          message: input.message,
          status,
          notificationStatus: input.notificationStatus,
          lastNotifyError: input.lastNotifyError ?? "",
        },
      })
      .run();
    return { id, isUpdate: Boolean(existing) };
  }

  updateLeadStatus(id: string, status: LeadRecord["status"]): LeadRecord | undefined {
    const result = this.orm.update(schema.leads).set({ status }).where(eq(schema.leads.id, id)).run();
    if (result.changes === 0) return undefined;
    const row = this.orm.select().from(schema.leads).where(eq(schema.leads.id, id)).limit(1).get();
    return row ? rowToLeadRecord(row) : undefined;
  }

  updateLeadNotification(id: string, status: LeadRecord["notificationStatus"], error?: string): void {
    this.orm
      .update(schema.leads)
      .set({ notificationStatus: status, lastNotifyError: error ?? "" })
      .where(eq(schema.leads.id, id))
      .run();
  }

  listLeads(): LeadRecord[] {
    const rows = this.orm.select().from(schema.leads).orderBy(desc(schema.leads.createdAt)).all();
    return rows.map(rowToLeadRecord);
  }

  getAdminUser(username: string): AdminUser | undefined {
    return this.orm.select().from(schema.adminUsers).where(eq(schema.adminUsers.username, username)).limit(1).get();
  }

  upsertAdminUser(input: AdminUser): AdminUser {
    this.orm
      .insert(schema.adminUsers)
      .values(input)
      .onConflictDoUpdate({
        target: schema.adminUsers.username,
        set: {
          passwordHash: input.passwordHash,
          updatedAt: input.updatedAt,
        },
      })
      .run();
    return input;
  }

  createAdminSession(input: AdminSession): AdminSession {
    this.orm.insert(schema.adminSessions).values(input).run();
    return input;
  }

  getAdminSession(tokenHash: string, now: Date): AdminSession | undefined {
    const row = this.orm
      .select()
      .from(schema.adminSessions)
      .where(and(eq(schema.adminSessions.tokenHash, tokenHash), gte(schema.adminSessions.expiresAt, now.toISOString())))
      .limit(1)
      .get();
    return row;
  }

  touchAdminSession(tokenHash: string, now: Date): void {
    this.orm
      .update(schema.adminSessions)
      .set({ lastSeenAt: now.toISOString() })
      .where(eq(schema.adminSessions.tokenHash, tokenHash))
      .run();
  }

  deleteAdminSession(tokenHash: string): boolean {
    return this.orm.delete(schema.adminSessions).where(eq(schema.adminSessions.tokenHash, tokenHash)).run().changes > 0;
  }

  cleanupExpiredAdminSessions(now: Date): number {
    return this.orm.delete(schema.adminSessions).where(lt(schema.adminSessions.expiresAt, now.toISOString())).run().changes;
  }

  private initialize(options: { seedDefaultSiteToken: boolean; migrationsFolder?: string }): void {
    // The initial migration uses plain CREATE TABLE statements, so only fresh databases can run it safely.
    // Existing v0.1 databases stay on compatibility DDL until a baseline migration strategy is added.
    if (!this.tableExists("settings") && options.migrationsFolder) {
      migrate(this.orm, { migrationsFolder: options.migrationsFolder });
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS knowledge (
        id TEXT PRIMARY KEY,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        tags TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        visitor_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        sources TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS leads (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT,
        company TEXT,
        message TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        notification_status TEXT NOT NULL,
        last_notify_error TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admin_users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admin_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        username TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        FOREIGN KEY (username) REFERENCES admin_users(username) ON DELETE CASCADE
      );
    `);
    this.seedDefaults(options);
  }

  private seedDefaults(options: { seedDefaultSiteToken: boolean }): void {
    const defaults: Record<string, string> = {
      site_name: "Janua Spa",
      "widget.color": "#4F46E5",
      "widget.position": "bottom-right",
      "widget.greeting": "Hi! How can I help today?",
      "widget.avatar_url": "",
      "widget.dark_mode": "auto",
      intent_trigger_words: JSON.stringify([
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
      business_info: JSON.stringify(defaultBusinessInfo()),
    };
    if (options.seedDefaultSiteToken) {
      defaults.site_token = "dev-site-token";
    }

    for (const [key, value] of Object.entries(defaults)) {
      this.orm.insert(schema.settings).values({ key, value }).onConflictDoNothing().run();
    }
    this.upgradeLegacyDemoDefaults();

    const firstPair = this.orm.select({ id: schema.knowledge.id }).from(schema.knowledge).limit(1).get();
    if (!firstPair) {
      const now = new Date().toISOString();
      this.orm
        .insert(schema.knowledge)
        .values({
          id: "qa_demo_1",
          question: "What services do you offer?",
          answer: "Janua Spa offers massage therapy, facials, body treatments, and gift cards.",
          tags: JSON.stringify([]),
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
  }

  private upgradeLegacyDemoDefaults(): void {
    if (this.getSetting("site_name") === "Janua Demo") {
      this.setSetting("site_name", "Janua Spa");
    }

    const rawBusinessInfo = this.getSetting("business_info");
    if (rawBusinessInfo && isLegacyDemoBusinessInfo(rawBusinessInfo)) {
      this.setBusinessInfo(defaultBusinessInfo());
    }

    const demoPair = this.findQAPair("qa_demo_1");
    if (demoPair?.question === "What services do you offer?" && demoPair.answer === LEGACY_DEMO_FAQ_ANSWER) {
      this.upsertQAPair({
        id: "qa_demo_1",
        question: "What services do you offer?",
        answer: "Janua Spa offers massage therapy, facials, body treatments, and gift cards.",
        tags: [],
      });
    }
  }

  private findQAPair(id: string): QAPair | undefined {
    return this.listQAPairs().find((pair) => pair.id === id);
  }

  private tableExists(name: string): boolean {
    return Boolean(this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  }
}

type LeadRow = typeof schema.leads.$inferSelect;

function rowToLeadRecord(row: LeadRow): LeadRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    name: row.name,
    email: row.email,
    phone: row.phone || undefined,
    company: row.company || undefined,
    message: row.message,
    source: row.source as LeadRecord["source"],
    status: row.status as LeadRecord["status"],
    notificationStatus: row.notificationStatus as LeadRecord["notificationStatus"],
    lastNotifyError: row.lastNotifyError || undefined,
    createdAt: row.createdAt,
  };
}

function findMigrationsFolder(): string | undefined {
  const candidates = [
    process.env.JANUA_MIGRATIONS_DIR,
    join(process.cwd(), "packages/core/drizzle"),
    join(process.cwd(), "../core/drizzle"),
  ].filter(Boolean) as string[];
  return candidates.find((candidate) => existsSync(candidate));
}

function defaultBusinessInfo(): BusinessInfo {
  return {
    business_name: "Janua Spa",
    phone: "+1-555-0130",
    email: "hello@januaspa.example",
    address: "123 Wellness Avenue",
    store_hours: "Mon-Sat 10am-7pm",
    services: "Janua Spa offers massage therapy, facials, body treatments, and gift cards.",
    custom_fields: {},
  };
}

function publicWidgetSiteName(businessName: string): string {
  const name = businessName.trim();
  if (!name || name === "Janua Spa") return "Chat with us";
  return name;
}

const LEGACY_DEMO_FAQ_ANSWER = "We offer consultations, quotes, and customer support.";

function isLegacyDemoBusinessInfo(raw: string): boolean {
  try {
    const info = JSON.parse(raw) as Partial<BusinessInfo>;
    return (
      info.business_name === "Janua Demo Business" &&
      info.phone === "+1-555-0100" &&
      info.email === "hello@example.com" &&
      info.address === "123 Demo Street" &&
      info.store_hours === "Mon-Fri 9am-5pm" &&
      Array.isArray(info.services) &&
      info.services.join("|") === "consultation|quotes|support"
    );
  } catch {
    return false;
  }
}

function rowToConversationMessage(row: {
  role: "user" | "assistant" | "system";
  content: string;
  sources: string;
  createdAt: string;
}): ConversationMessage {
  return {
    role: row.role === "system" ? "assistant" : row.role,
    content: row.content,
    sources: JSON.parse(row.sources) as ConversationMessage["sources"],
    createdAt: row.createdAt,
  };
}
