import type { ChatChunk, LLMProvider, Message } from "./types.js";

export class FakeLLMProvider implements LLMProvider {
  async *chat(messages: Message[]): AsyncIterable<ChatChunk> {
    if (messages[0]?.content.includes("You classify whether a visitor message is related")) {
      yield {
        content: JSON.stringify({
          related: true,
          confidence: 0.9,
          reason: "Fake provider treats test messages as related by default.",
          redirectMessage: null,
        }),
        done: false,
      };
      yield { content: "", done: true };
      return;
    }

    const lastUserMessage = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
    const response =
      `I can help with that. Based on the business info I have, here is a quick answer to "${lastUserMessage}". ` +
      "If you want pricing or a follow-up, I can collect your contact details.";

    const words = response.split(/(\s+)/).filter(Boolean);
    for (const word of words) {
      await delay(20);
      yield { content: word, done: false };
    }
    yield { content: "", done: true, usage: { totalTokens: words.length } };
  }
}

export interface OllamaProviderOptions {
  baseUrl: string;
  model: string;
}

export class OllamaProvider implements LLMProvider {
  constructor(private readonly options: OllamaProviderOptions) {}

  async *chat(messages: Message[]): AsyncIterable<ChatChunk> {
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.options.model,
        stream: true,
        messages: messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error(`Ollama request failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
        if (parsed.message?.content) {
          yield { content: parsed.message.content, done: false };
        }
        if (parsed.done) {
          yield { content: "", done: true };
          return;
        }
      }
    }
  }
}

export interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export class OpenAIProvider implements LLMProvider {
  constructor(private readonly options: OpenAIProviderOptions) {}

  async *chat(messages: Message[]): AsyncIterable<ChatChunk> {
    const response = await fetch(`${(this.options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.options.model,
        stream: true,
        messages: messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI request failed: ${response.status}${await responseErrorSuffix(response)}`);
    }
    if (!response.body) {
      throw new Error(`OpenAI request failed: ${response.status} missing response body`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";

      for (const event of events) {
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.replace(/^data:\s*/, ""))
          .join("");
        if (!data || data === "[DONE]") {
          continue;
        }

        const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) {
          yield { content, done: false };
        }
      }
    }

    yield { content: "", done: true };
  }
}

async function responseErrorSuffix(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  if (!body) return "";

  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    const message = parsed.error?.message?.trim();
    return message ? ` - ${message}` : "";
  } catch {
    return ` - ${body.slice(0, 500)}`;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
