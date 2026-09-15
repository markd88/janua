import type { LeadFormConfig, LeadFormFieldConfig, LeadFormFieldKey } from "./types.js";

export const LEAD_FORM_FIELD_KEYS: LeadFormFieldKey[] = ["name", "phone", "email", "company"];

export const DEFAULT_LEAD_FORM_CONFIG: LeadFormConfig = {
  name: {
    enabled: true,
    required: true,
    label: "Name",
    placeholder: "Your name",
  },
  phone: {
    enabled: true,
    required: false,
    label: "Phone",
    placeholder: "Phone number",
  },
  email: {
    enabled: true,
    required: false,
    label: "Email",
    placeholder: "you@example.com",
  },
  company: {
    enabled: false,
    required: false,
    label: "Company",
    placeholder: "Company name",
  },
};

export function normalizeLeadFormConfig(value: unknown): LeadFormConfig {
  const input = isRecord(value) ? value : {};
  return Object.fromEntries(
    LEAD_FORM_FIELD_KEYS.map((key) => {
      const raw = isRecord(input[key]) ? input[key] : {};
      const fallback = DEFAULT_LEAD_FORM_CONFIG[key];
      const enabled = key === "name" || key === "email" || key === "phone" ? true : false;
      const required = key === "name" ? true : false;
      return [
        key,
        {
          enabled,
          required: required && enabled,
          label: textOrDefault(raw.label, fallback.label, 80),
          placeholder: textOrDefault(raw.placeholder, fallback.placeholder, 120),
        } satisfies LeadFormFieldConfig,
      ];
    }),
  ) as LeadFormConfig;
}

function textOrDefault(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
