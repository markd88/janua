export interface OllamaRuntimeOptions {
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
}

export interface OllamaHealth {
  ok: boolean;
  modelInstalled: boolean;
  message: string;
}

export interface OllamaBenchmark {
  ok: boolean;
  model: string;
  tokensPerSecond: number;
  durationMs: number;
  outputTokens: number;
  warning?: string;
}

export class OllamaRuntime {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OllamaRuntimeOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async health(): Promise<OllamaHealth> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/tags`);
      if (!response.ok) {
        return { ok: false, modelInstalled: false, message: `Ollama tags failed: ${response.status}` };
      }
      const body = (await response.json()) as { models?: Array<{ name?: string }> };
      const modelInstalled = (body.models ?? []).some((item) => item.name === this.options.model);
      return {
        ok: true,
        modelInstalled,
        message: modelInstalled ? "Ollama is ready" : `Model ${this.options.model} is not installed`,
      };
    } catch (error) {
      return { ok: false, modelInstalled: false, message: errorMessage(error) };
    }
  }

  async ensureModel(): Promise<OllamaHealth> {
    const health = await this.health();
    if (!health.ok || health.modelInstalled) return health;

    const response = await this.fetchImpl(`${this.baseUrl}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: this.options.model, stream: false }),
    });
    if (!response.ok) {
      return { ok: false, modelInstalled: false, message: `Ollama pull failed: ${response.status}` };
    }
    return this.health();
  }

  async prewarm(): Promise<OllamaHealth> {
    const ensured = await this.ensureModel();
    if (!ensured.ok || !ensured.modelInstalled) return ensured;

    const response = await this.fetchImpl(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.options.model, prompt: "ping", stream: false, keep_alive: "24h" }),
    });
    if (!response.ok) {
      return { ok: false, modelInstalled: true, message: `Ollama prewarm failed: ${response.status}` };
    }
    return { ok: true, modelInstalled: true, message: "Ollama model is loaded" };
  }

  async benchmark(): Promise<OllamaBenchmark> {
    const startedAt = Date.now();
    const response = await this.fetchImpl(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.options.model,
        prompt: "Write one concise sentence about a helpful AI assistant.",
        stream: false,
        keep_alive: "24h",
      }),
    });
    if (!response.ok) {
      throw new Error(`Ollama benchmark failed: ${response.status}`);
    }

    const durationMs = Math.max(1, Date.now() - startedAt);
    const body = (await response.json()) as { response?: string; eval_count?: number; eval_duration?: number };
    const outputTokens = body.eval_count ?? countApproxTokens(body.response ?? "");
    const seconds = body.eval_duration ? body.eval_duration / 1_000_000_000 : durationMs / 1_000;
    const tokensPerSecond = outputTokens / Math.max(seconds, 0.001);

    return {
      ok: true,
      model: this.options.model,
      tokensPerSecond: Number(tokensPerSecond.toFixed(2)),
      durationMs,
      outputTokens,
      warning: tokensPerSecond < 8 ? "This model may feel slow on your hardware. Consider OpenAI or a smaller Ollama model." : undefined,
    };
  }

  private get baseUrl(): string {
    return this.options.baseUrl.replace(/\/$/, "");
  }
}

function countApproxTokens(text: string): number {
  return Math.max(1, text.trim().split(/\s+/).filter(Boolean).length);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Ollama is unavailable";
}
