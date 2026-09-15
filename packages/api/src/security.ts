import type { Context, MiddlewareHandler } from "hono";

export type ErrorCode =
  | "AUTH_INVALID"
  | "CORS_ORIGIN_DENIED"
  | "RATE_LIMITED"
  | "REQUEST_INVALID"
  | "SITE_TOKEN_INVALID"
  | "SERVER_ERROR";

export type ApiErrorBody = {
  error: {
    code: ErrorCode;
    message: string;
  };
};

export interface RateLimitOptions {
  enabled: boolean;
  windowMs: number;
  max: number;
  trustProxy: boolean;
  maxBuckets: number;
}

export interface RequestLogEntry {
  ts: string;
  level: "info" | "error";
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  errorCode?: ErrorCode;
}

export interface SecurityHeadersOptions {
  enabled: boolean;
}

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

export type RateLimitKeyResolver = (c: Context) => string | Promise<string>;

export function apiError(c: Context, status: 400 | 401 | 403 | 429 | 500, code: ErrorCode, message: string): Response {
  c.set("januaErrorCode", code);
  return c.json<ApiErrorBody>({ error: { code, message } }, status);
}

export function createRequestLoggingMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const startedAt = Date.now();
    const requestId = crypto.randomUUID();
    c.header("X-Request-Id", requestId);

    try {
      await next();
    } catch (error) {
      logRequest({
        ts: new Date().toISOString(),
        level: "error",
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: 500,
        durationMs: Date.now() - startedAt,
        errorCode: "SERVER_ERROR",
      });
      throw error;
    }

    const status = c.res.status;
    logRequest({
      ts: new Date().toISOString(),
      level: status >= 500 ? "error" : "info",
      requestId,
      method: c.req.method,
      path: c.req.path,
      status,
      durationMs: Date.now() - startedAt,
      errorCode: c.get("januaErrorCode") as ErrorCode | undefined,
    });
  };
}

export function createSecurityHeadersMiddleware(options: SecurityHeadersOptions = { enabled: true }): MiddlewareHandler {
  return async (c, next) => {
    if (options.enabled) {
      c.header("Content-Security-Policy", buildContentSecurityPolicy());
      c.header("X-Content-Type-Options", "nosniff");
      c.header("X-Frame-Options", "DENY");
      c.header("Referrer-Policy", "strict-origin-when-cross-origin");
      c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
      c.header("Cross-Origin-Opener-Policy", "same-origin");
    }

    await next();
  };
}

export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? "*")
    .split(",")
    .map((origin) => origin.trim())
    .map(normalizeAllowedOrigin)
    .filter(Boolean);
}

export function resolveCorsOrigin(allowedOrigins: string[]) {
  return (origin: string) => {
    if (allowedOrigins.includes("*")) return origin || "*";
    if (!origin) return "";
    return allowedOrigins.includes(origin) ? origin : "";
  };
}

export function createRateLimitMiddleware(options: RateLimitOptions, resolveKey?: RateLimitKeyResolver): MiddlewareHandler {
  const buckets = new Map<string, RateLimitBucket>();

  return async (c, next) => {
    if (!options.enabled || c.req.method === "OPTIONS") {
      await next();
      return;
    }

    const now = Date.now();
    if (options.maxBuckets > 0 && buckets.size >= options.maxBuckets) {
      evictExpiredBuckets(buckets, now);
      trimOldestBuckets(buckets, options.maxBuckets);
    }

    const resolvedKey = resolveKey ? await resolveKey(c) : clientKey(c, options.trustProxy);
    const key = `${resolvedKey}:${c.req.path}`;
    const current = buckets.get(key);
    const bucket = current && current.resetAt > now ? current : { count: 0, resetAt: now + options.windowMs };

    if (bucket.count >= options.max) {
      buckets.set(key, bucket);
      c.header("X-RateLimit-Limit", String(options.max));
      c.header("X-RateLimit-Remaining", "0");
      c.header("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
      return apiError(c, 429, "RATE_LIMITED", "Too many requests. Please try again later.");
    }

    bucket.count += 1;
    buckets.set(key, bucket);

    c.header("X-RateLimit-Limit", String(options.max));
    c.header("X-RateLimit-Remaining", String(Math.max(options.max - bucket.count, 0)));
    c.header("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

    await next();
  };
}

function evictExpiredBuckets(buckets: Map<string, RateLimitBucket>, now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

function trimOldestBuckets(buckets: Map<string, RateLimitBucket>, maxBuckets: number): void {
  while (buckets.size >= maxBuckets) {
    const oldestKey = buckets.keys().next().value as string | undefined;
    if (!oldestKey) return;
    buckets.delete(oldestKey);
  }
}

function clientKey(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwardedFor = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    return forwardedFor || c.req.header("x-real-ip") || "trusted-proxy";
  }
  return "direct";
}

function normalizeAllowedOrigin(origin: string): string {
  if (origin === "*") return origin;
  try {
    return new URL(origin).origin;
  } catch {
    return origin;
  }
}

function buildContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self' http: https:",
  ].join("; ");
}

function logRequest(entry: RequestLogEntry): void {
  console.log(JSON.stringify(entry));
}
