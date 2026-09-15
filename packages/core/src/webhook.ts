import type { LeadRecord } from "./types.js";

export interface LeadCapturedEvent {
  event: "lead.captured";
  occurredAt: string;
  lead: LeadRecord;
}

export interface DeliverLeadWebhookOptions {
  timeoutMs?: number;
  allowPrivateNetwork?: boolean;
}

export async function deliverLeadWebhook(
  url: string,
  lead: LeadRecord,
  options: DeliverLeadWebhookOptions = {},
): Promise<void> {
  const target = url.trim();
  if (!target) {
    throw new Error("Lead webhook URL is empty");
  }
  assertSafeWebhookUrl(target, options);

  const response = await fetch(target, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildLeadCapturedEvent(lead)),
    signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
  });

  if (!response.ok) {
    throw new Error(`Lead webhook failed with HTTP ${response.status}`);
  }
}

export function assertSafeWebhookUrl(url: string, options: Pick<DeliverLeadWebhookOptions, "allowPrivateNetwork"> = {}): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Lead webhook URL must use http or https");
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLocalHostname(hostname)) {
    throw new Error("Lead webhook URL must not target local hostnames");
  }

  const ipAddress = parseIpAddress(hostname);
  if (!options.allowPrivateNetwork && ipAddress && isPrivateIpAddress(ipAddress)) {
    throw new Error("Lead webhook URL must not target private or link-local IP ranges");
  }
}

export function buildLeadCapturedEvent(lead: LeadRecord): LeadCapturedEvent {
  return {
    event: "lead.captured",
    occurredAt: new Date().toISOString(),
    lead,
  };
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

function parseIpAddress(hostname: string): { family: 4 | 6; value: string } | undefined {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    const parts = hostname.split(".").map(Number);
    if (parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
      return { family: 4, value: parts.join(".") };
    }
  }

  if (hostname.includes(":")) {
    return { family: 6, value: hostname };
  }

  return undefined;
}

function isPrivateIpAddress(address: { family: 4 | 6; value: string }): boolean {
  if (address.family === 6) {
    const value = address.value.toLowerCase();
    return (
      value === "::1" ||
      value.startsWith("fc") ||
      value.startsWith("fd") ||
      value.startsWith("fe80:") ||
      value === "::" ||
      value.startsWith("0:")
    );
  }

  const [first = 0, second = 0] = address.value.split(".").map(Number);
  return (
    first === 10 ||
    first === 127 ||
    first === 0 ||
    first === 169 && second === 254 ||
    first === 172 && second >= 16 && second <= 31 ||
    first === 192 && second === 168 ||
    first >= 224
  );
}
