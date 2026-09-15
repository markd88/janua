import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const knowledge = sqliteTable("knowledge", {
  id: text("id").primaryKey(),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  tags: text("tags").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  visitorId: text("visitor_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
  content: text("content").notNull(),
  sources: text("sources").notNull(),
  createdAt: text("created_at").notNull(),
});

export const leads = sqliteTable("leads", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  company: text("company"),
  message: text("message").notNull(),
  source: text("source").notNull(),
  status: text("status", { enum: ["new", "contacted", "not_interested"] }).notNull(),
  notificationStatus: text("notification_status", { enum: ["not_configured", "sent", "failed"] }).notNull(),
  lastNotifyError: text("last_notify_error"),
  createdAt: text("created_at").notNull(),
});

export const adminUsers = sqliteTable("admin_users", {
  username: text("username").primaryKey(),
  passwordHash: text("password_hash").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const adminSessions = sqliteTable("admin_sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  username: text("username")
    .notNull()
    .references(() => adminUsers.username, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
});
