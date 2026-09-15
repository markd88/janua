import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname, resolve } from "node:path";

export type AgentTraceLevel = "info" | "warn" | "error";

export interface AgentTraceEvent {
  level?: AgentTraceLevel;
  event: string;
  fields?: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

export interface AgentTraceLoggerOptions {
  enabled?: boolean;
  includeRaw?: boolean;
  logPath?: string;
}

export interface AgentTraceTurnInput {
  conversationId?: string;
  visitorId?: string;
  provider?: string;
  model?: string;
}

export class AgentTraceLogger {
  private readonly enabled: boolean;
  private readonly includeRaw: boolean;
  private readonly logPath: string;
  private stream?: WriteStream;

  constructor(options: AgentTraceLoggerOptions = {}) {
    this.enabled = options.enabled ?? process.env.JANUA_AGENT_TRACE === "1";
    this.includeRaw = options.includeRaw ?? process.env.JANUA_AGENT_TRACE_RAW === "1";
    this.logPath = options.logPath ?? process.env.JANUA_AGENT_TRACE_PATH ?? resolve(process.cwd(), "logs/agent-trace.ndjson");
  }

  startTurn(input: AgentTraceTurnInput = {}): AgentTraceTurn {
    return new AgentTraceTurn(this, {
      traceId: randomUUID(),
      turnId: randomUUID(),
      conversationIdHash: hashTraceId(input.conversationId),
      visitorIdHash: hashTraceId(input.visitorId),
      provider: input.provider,
      model: input.model,
    });
  }

  write(context: AgentTraceContext, input: AgentTraceEvent): void {
    if (!this.enabled) return;

    const payload = stripUndefined({
      ts: new Date().toISOString(),
      level: input.level ?? "info",
      event: input.event,
      ...context,
      ...input.fields,
      raw: this.includeRaw ? input.raw : undefined,
    });

    try {
      this.ensureStream().write(`${JSON.stringify(payload)}\n`);
    } catch {
      // Tracing is dev-only and must never affect the product path.
    }
  }

  private ensureStream(): WriteStream {
    if (!this.stream) {
      mkdirSync(dirname(this.logPath), { recursive: true });
      this.stream = createWriteStream(this.logPath, { flags: "a" });
    }
    return this.stream;
  }
}

interface AgentTraceContext {
  traceId: string;
  turnId: string;
  conversationIdHash?: string;
  visitorIdHash?: string;
  provider?: string;
  model?: string;
}

export class AgentTraceTurn {
  constructor(
    private readonly logger: AgentTraceLogger,
    private readonly context: AgentTraceContext,
  ) {}

  event(event: string, fields: Record<string, unknown> = {}, raw?: Record<string, unknown>): void {
    this.logger.write(this.context, { event, fields, raw });
  }

  warn(event: string, fields: Record<string, unknown> = {}, raw?: Record<string, unknown>): void {
    this.logger.write(this.context, { level: "warn", event, fields, raw });
  }

  error(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
    this.logger.write(this.context, {
      level: "error",
      event,
      fields: {
        ...fields,
        errorType: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

export function hashTraceId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
