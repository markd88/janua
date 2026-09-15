import { z } from "zod";

const idSchema = z.string().trim().min(1).max(128);
const shortTextSchema = z.string().trim().max(256);
const longTextSchema = z.string().trim().min(1).max(8_000);
const tagsSchema = z.array(z.string().trim().min(1).max(64)).max(20).default([]);

export const restoreConversationSchema = z.object({
  conversationId: idSchema,
  visitorId: idSchema,
  siteToken: idSchema,
});

export const chatSchema = restoreConversationSchema.extend({
  message: z.string().trim().min(1).max(4_000),
});

export const leadSchema = restoreConversationSchema.extend({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254).or(z.literal("")).optional(),
  phone: shortTextSchema.optional(),
  company: shortTextSchema.optional(),
  message: z.string().trim().min(1).max(2_000),
});

export const businessInfoSchema = z.object({
  business_name: z.string().trim().min(1).max(160),
  phone: shortTextSchema,
  email: z.string().trim().email().max(254).or(z.literal("")),
  address: z.string().trim().max(500),
  store_hours: z.string().trim().max(500),
  services: z.string().trim().max(4_000),
  custom_fields: z.record(z.string().trim().max(120), z.string().trim().max(1_000)).default({}),
});

export const leadStatusSchema = z.object({
  status: z.enum(["new", "contacted", "not_interested"]),
});

export const knowledgeSchema = z.object({
  question: z.string().trim().min(1).max(1_000),
  answer: longTextSchema,
  tags: tagsSchema,
});

export const adminLoginSchema = z.object({
  password: z.string().min(1).max(1_000),
});
