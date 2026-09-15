type WidgetConfig = {
  color: string;
  position: "bottom-right" | "bottom-left";
  greeting: string;
  avatarUrl: string;
  darkMode: "auto" | "light" | "dark";
  siteName: string;
  leadForm: LeadFormConfig;
};

type LeadFormFieldKey = "name" | "email" | "phone" | "company";

type LeadFormConfig = Record<
  LeadFormFieldKey,
  {
    enabled: boolean;
    required: boolean;
    label: string;
    placeholder: string;
  }
>;

type RestoredMessage = {
  role: "user" | "assistant";
  content: string;
};

const FIRST_TOKEN_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 5_000;
const MAX_AUTO_RETRIES = 3;
const LEAD_SUBMITTED_USER_MESSAGE = "I just submitted the form.";
const LEAD_SUBMITTED_ASSISTANT_MESSAGE = "We received your form and will contact you soon.";
const ASSISTANT_UNAVAILABLE_MESSAGE =
  "I'm not able to answer that right now. Please leave your contact details and we'll follow up.";

class JanuaWidget {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly conversationId: string;
  private readonly visitorId: string;
  private readonly leadSubmittedKey: string;
  private config: WidgetConfig = {
    color: "#4F46E5",
    position: "bottom-right",
    greeting: "Hi! How can I help today?",
    avatarUrl: "",
    darkMode: "auto",
    siteName: "Chat with us",
    leadForm: defaultLeadFormConfig(),
  };
  private root!: HTMLDivElement;
  private messages!: HTMLDivElement;
  private input!: HTMLInputElement;
  private sendButton!: HTMLButtonElement;
  private readonly handleOutsidePointerDown = (event: PointerEvent): void => {
    if (!this.root.contains(event.target as Node)) {
      this.close();
    }
  };

  constructor(options: { token: string; baseUrl: string }) {
    this.token = options.token;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.conversationId = getOrCreateId(this.token, "conversationId");
    this.visitorId = getOrCreateId(this.token, "visitorId");
    this.leadSubmittedKey = `janua:${this.token}:leadSubmitted`;
    this.injectStyles();
    this.render();
    void this.boot();
  }

  private async boot(): Promise<void> {
    await this.loadConfig().catch(() => undefined);
    await this.restoreConversation();
  }

  private async loadConfig(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/widget-config?siteToken=${encodeURIComponent(this.token)}`);
    if (!response.ok) return;
    this.config = { ...this.config, ...(await response.json()) };
    this.root.style.setProperty("--janua-color", this.config.color);
    this.root.classList.toggle("janua-widget--left", this.config.position === "bottom-left");
    this.root.classList.toggle("janua-widget--light", this.config.darkMode === "light");
    this.root.classList.toggle("janua-widget--dark", this.config.darkMode === "dark");
    this.root.querySelector(".janua-widget__title")!.textContent = this.config.siteName;
  }

  private async restoreConversation(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/conversation/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: this.conversationId,
        visitorId: this.visitorId,
        siteToken: this.token,
      }),
    });

    if (!response.ok) {
      this.addMessage("assistant", this.config.greeting);
      return;
    }

    const body = (await response.json()) as { messages: RestoredMessage[] };
    if (body.messages.length === 0) {
      this.addMessage("assistant", this.config.greeting);
      return;
    }

    for (const message of body.messages) {
      this.addMessage(message.role, message.content);
    }
  }

  private render(): void {
    this.root = document.createElement("div");
    this.root.className = "janua-widget";
    this.root.innerHTML = `
      <button class="janua-widget__bubble" aria-label="Open chat">
        <span class="janua-widget__bubble-orb" aria-hidden="true">
          <svg viewBox="0 0 24 24" role="img">
            <path d="M12 3.25l1.15 4.1a4.2 4.2 0 0 0 2.95 2.95L20.2 11.45l-4.1 1.15a4.2 4.2 0 0 0-2.95 2.95L12 19.65l-1.15-4.1A4.2 4.2 0 0 0 7.9 12.6l-4.1-1.15 4.1-1.15a4.2 4.2 0 0 0 2.95-2.95L12 3.25z" />
          </svg>
        </span>
        <span class="janua-widget__bubble-copy">
          <strong>Need help?</strong>
          <small>Quick answers</small>
        </span>
        <span class="janua-widget__bubble-status" aria-hidden="true"></span>
      </button>
      <section class="janua-widget__panel" hidden>
        <header class="janua-widget__header">
          <div class="janua-widget__identity">
            <span class="janua-widget__identity-mark" aria-hidden="true"></span>
            <div>
              <strong class="janua-widget__title">Janua</strong>
            </div>
          </div>
          <button class="janua-widget__close" aria-label="Close chat">x</button>
        </header>
        <div class="janua-widget__messages"></div>
        <form class="janua-widget__composer">
          <input class="janua-widget__input" placeholder="Ask a question..." />
          <button class="janua-widget__send" type="submit">Send</button>
        </form>
      </section>
    `;
    document.body.appendChild(this.root);
    this.messages = this.root.querySelector(".janua-widget__messages")!;
    this.input = this.root.querySelector(".janua-widget__input")!;
    this.sendButton = this.root.querySelector(".janua-widget__send")!;
    this.root.querySelector(".janua-widget__bubble")!.addEventListener("click", () => this.open());
    this.root.querySelector(".janua-widget__close")!.addEventListener("click", () => this.close());
    this.root.querySelector(".janua-widget__composer")!.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.sendMessage();
    });
  }

  private open(): void {
    this.root.querySelector<HTMLElement>(".janua-widget__panel")!.hidden = false;
    this.root.querySelector<HTMLElement>(".janua-widget__bubble")!.hidden = true;
    window.setTimeout(() => {
      document.addEventListener("pointerdown", this.handleOutsidePointerDown);
    }, 0);
    this.input.focus();
  }

  private close(): void {
    this.root.querySelector<HTMLElement>(".janua-widget__panel")!.hidden = true;
    this.root.querySelector<HTMLElement>(".janua-widget__bubble")!.hidden = false;
    document.removeEventListener("pointerdown", this.handleOutsidePointerDown);
  }

  private async sendMessage(): Promise<void> {
    const message = this.input.value.trim();
    if (!message) return;
    this.input.value = "";
    this.setSending(true);
    this.addMessage("user", message);
    const assistantBubble = this.addTypingMessage();

    try {
      await this.streamAssistant(message, assistantBubble);
    } finally {
      this.setSending(false);
    }
  }

  private async streamAssistant(message: string, assistantBubble: HTMLDivElement, attempt = 0): Promise<void> {
    const controller = new AbortController();
    let receivedFirstToken = false;
    const timeout = window.setTimeout(() => {
      if (!receivedFirstToken) controller.abort("first-token-timeout");
    }, FIRST_TOKEN_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          conversationId: this.conversationId,
          visitorId: this.visitorId,
          siteToken: this.token,
          message,
        }),
      });

      if (!response.ok || !response.body) {
        await this.retryOrFail(message, assistantBubble, attempt);
        return;
      }

      let content = "";
      for await (const event of readSSE(response.body)) {
        if (event.event === "token") {
          if (!receivedFirstToken) {
            assistantBubble.removeAttribute("aria-label");
            assistantBubble.textContent = "";
            receivedFirstToken = true;
          }
          const token = safeJson<{ content: string }>(event.data, { content: "" }).content;
          content += token;
          assistantBubble.textContent += token;
          this.scrollToBottom();
        }
        if (event.event === "sources") {
          continue;
        }
        if (event.event === "lead") {
          this.showLeadForm(message);
        }
        if (event.event === "error") {
          throw new Error(
            safeJson<{ message: string }>(event.data, {
            message: "The AI service is unavailable.",
            }).message,
          );
        }
      }
      if (!content.trim()) {
        assistantBubble.removeAttribute("aria-label");
        assistantBubble.textContent = `I can help you learn about ${this.config.siteName}. What would you like to know?`;
      }
    } catch (error) {
      if (isAbortError(error)) {
        assistantBubble.removeAttribute("aria-label");
        assistantBubble.textContent = ASSISTANT_UNAVAILABLE_MESSAGE;
        this.showLeadForm(message);
        return;
      }
      await this.retryOrFail(message, assistantBubble, attempt);
    } finally {
      window.clearTimeout(timeout);
    }
  }

  private async retryOrFail(message: string, assistantBubble: HTMLDivElement, attempt: number): Promise<void> {
    if (attempt >= MAX_AUTO_RETRIES) {
      assistantBubble.removeAttribute("aria-label");
      assistantBubble.textContent = ASSISTANT_UNAVAILABLE_MESSAGE;
      this.showLeadForm(message);
      return;
    }
    this.showTypingIndicator(assistantBubble);
    await delay(RETRY_DELAY_MS);
    this.showTypingIndicator(assistantBubble);
    await this.streamAssistant(message, assistantBubble, attempt + 1);
  }

  private showLeadForm(message: string): void {
    if (this.hasSubmittedLead()) return;
    this.root.querySelector(".janua-widget__lead-form")?.remove();
    const form = document.createElement("form");
    form.className = "janua-widget__lead-form";
    const title = document.createElement("strong");
    title.textContent = "Want us to follow up?";
    form.appendChild(title);
    for (const key of leadFormFieldKeys()) {
      const field = this.config.leadForm[key];
      if (!field.enabled) continue;
      const label = document.createElement("label");
      label.className = "janua-widget__lead-field";
      const labelText = document.createElement("span");
      labelText.textContent = `${field.label}${field.required ? " *" : ""}`;
      const input = document.createElement("input");
      input.name = key;
      input.placeholder = field.placeholder;
      input.required = field.required;
      if (key === "email") input.type = "email";
      input.setAttribute("aria-label", field.label);
      label.append(labelText, input);
      form.appendChild(label);
    }
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Send contact";
    form.appendChild(submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(form);
      void this.submitLead({
        name: String(data.get("name") ?? ""),
        email: String(data.get("email") ?? ""),
        phone: String(data.get("phone") ?? ""),
        company: String(data.get("company") ?? ""),
        message,
      });
      form.remove();
    });
    this.messages.appendChild(form);
    this.scrollToBottom();
  }

  private async submitLead(input: { name: string; email: string; phone?: string; company?: string; message: string }): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/lead`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...input,
        conversationId: this.conversationId,
        visitorId: this.visitorId,
        siteToken: this.token,
      }),
    });
    if (response.ok) {
      this.markLeadSubmitted();
    }
    if (response.ok) {
      this.addMessage("user", LEAD_SUBMITTED_USER_MESSAGE);
      this.addMessage("assistant", LEAD_SUBMITTED_ASSISTANT_MESSAGE);
      return;
    }
    this.addMessage("assistant", "Sorry, we could not save that lead.");
  }

  private hasSubmittedLead(): boolean {
    return localStorage.getItem(this.leadSubmittedKey) === "true";
  }

  private markLeadSubmitted(): void {
    localStorage.setItem(this.leadSubmittedKey, "true");
  }

  private addMessage(role: "user" | "assistant", content: string): HTMLDivElement {
    const bubble = document.createElement("div");
    bubble.className = `janua-widget__message janua-widget__message--${role}`;
    bubble.textContent = content;
    this.messages.appendChild(bubble);
    this.scrollToBottom();
    return bubble;
  }

  private addTypingMessage(): HTMLDivElement {
    const bubble = document.createElement("div");
    bubble.className = "janua-widget__message janua-widget__message--assistant";
    this.showTypingIndicator(bubble);
    this.messages.appendChild(bubble);
    this.scrollToBottom();
    return bubble;
  }

  private showTypingIndicator(bubble: HTMLDivElement): void {
    bubble.setAttribute("aria-label", "Assistant is typing");
    bubble.innerHTML = `<span class="janua-widget__loader" aria-hidden="true"><span></span><span></span><span></span></span>`;
    this.scrollToBottom();
  }

  private setSending(isSending: boolean): void {
    this.input.disabled = isSending;
    this.sendButton.disabled = isSending;
    this.sendButton.textContent = isSending ? "Sending..." : "Send";
  }

  private scrollToBottom(): void {
    this.messages.scrollTop = this.messages.scrollHeight;
  }

  private injectStyles(): void {
    if (document.getElementById("janua-widget-styles")) return;
    const style = document.createElement("style");
    style.id = "janua-widget-styles";
    style.textContent = `
      .janua-widget { --janua-color: #4F46E5; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; }
      .janua-widget--left { left: 20px; right: auto; }
      .janua-widget__bubble[hidden], .janua-widget__panel[hidden] { display: none !important; }
      .janua-widget__bubble { position: relative; display: inline-flex; align-items: center; gap: 12px; min-width: 168px; min-height: 58px; padding: 10px 18px 10px 10px; border-radius: 999px; border: 1px solid rgba(255, 255, 255, .32); color: white; background: radial-gradient(circle at 24% 20%, rgba(255,255,255,.38), transparent 30%), linear-gradient(135deg, var(--janua-color), #111827 78%); box-shadow: 0 18px 45px rgba(15, 23, 42, .28), 0 0 0 1px rgba(255,255,255,.12) inset, 0 0 32px color-mix(in srgb, var(--janua-color) 45%, transparent); font: inherit; cursor: pointer; overflow: hidden; transition: transform 180ms ease, box-shadow 180ms ease, filter 180ms ease; animation: janua-widget-attention 3.8s ease-in-out infinite; }
      .janua-widget__bubble::before { content: ""; position: absolute; inset: -80% -40%; background: linear-gradient(110deg, transparent 36%, rgba(255,255,255,.18) 46%, transparent 56%); transform: translateX(-36%); pointer-events: none; }
      .janua-widget__bubble:hover { transform: translateY(-2px); filter: saturate(1.08); box-shadow: 0 24px 58px rgba(15, 23, 42, .34), 0 0 0 1px rgba(255,255,255,.16) inset, 0 0 42px color-mix(in srgb, var(--janua-color) 58%, transparent); }
      .janua-widget__bubble:focus-visible { outline: 3px solid color-mix(in srgb, var(--janua-color) 34%, white); outline-offset: 4px; }
      .janua-widget__bubble-orb { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 38px; border-radius: 999px; background: rgba(255,255,255,.16); box-shadow: 0 0 0 1px rgba(255,255,255,.2) inset; flex: 0 0 auto; }
      .janua-widget__bubble-orb::before { content: ""; position: absolute; inset: 7px; border-radius: 999px; background: rgba(255,255,255,.16); filter: blur(6px); }
      .janua-widget__bubble-orb svg { position: relative; width: 20px; height: 20px; fill: white; }
      .janua-widget__bubble-copy { display: grid; gap: 1px; text-align: left; line-height: 1.05; }
      .janua-widget__bubble-copy strong { font-size: 15px; font-weight: 850; letter-spacing: .01em; }
      .janua-widget__bubble-copy small { color: rgba(255,255,255,.72); font-size: 11px; font-weight: 700; letter-spacing: .02em; }
      .janua-widget__bubble-status { position: absolute; right: 12px; top: 10px; width: 9px; height: 9px; border-radius: 999px; background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.2), 0 0 14px rgba(34,197,94,.9); }
      .janua-widget__panel { display: flex; flex-direction: column; width: min(390px, calc(100vw - 32px)); height: 560px; max-height: calc(100vh - 40px); border-radius: 26px; overflow: hidden; background: linear-gradient(180deg, #ffffff 0%, #f8fafc 42%, #f1f5f9 100%); box-shadow: 0 24px 80px rgba(15, 23, 42, .24), 0 0 0 1px rgba(255,255,255,.7) inset; border: 1px solid rgba(15, 23, 42, .08); }
      .janua-widget__header { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px 10px; color: #111827; background: transparent; border-bottom: 0; }
      .janua-widget__identity { display: flex; align-items: center; gap: 10px; min-width: 0; }
      .janua-widget__identity-mark { width: 34px; height: 34px; border-radius: 14px; background: radial-gradient(circle at 35% 28%, rgba(255,255,255,.8), transparent 32%), linear-gradient(135deg, var(--janua-color), #111827); box-shadow: 0 10px 24px color-mix(in srgb, var(--janua-color) 25%, transparent); flex: 0 0 auto; }
      .janua-widget__header span:not(.janua-widget__identity-mark) { display: block; color: #64748b; font-size: 12px; margin-top: 2px; }
      .janua-widget__close { color: #475569; background: #f1f5f9; border: 1px solid rgba(15,23,42,.06); border-radius: 999px; width: 32px; height: 32px; cursor: pointer; font-size: 16px; line-height: 1; }
      .janua-widget__close:hover { background: #e2e8f0; color: #0f172a; }
      .janua-widget__messages { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 16px 16px; background: transparent; }
      .janua-widget__message { max-width: 82%; padding: 10px 12px; margin: 0 0 10px; border-radius: 16px; line-height: 1.4; font-size: 14px; white-space: pre-wrap; }
      .janua-widget__message--assistant { background: white; color: #111827; border: 1px solid #e5e7eb; }
      .janua-widget__message--user { margin-left: auto; background: var(--janua-color); color: white; }
      .janua-widget__composer { display: flex; gap: 8px; padding: 12px; border-top: 1px solid rgba(15, 23, 42, .07); background: rgba(255,255,255,.5); backdrop-filter: blur(18px); }
      .janua-widget__input, .janua-widget__lead-form input { flex: 1; border: 1px solid rgba(148, 163, 184, .55); border-radius: 14px; padding: 10px 12px; font: inherit; background: rgba(255,255,255,.86); }
      .janua-widget__send, .janua-widget__lead-form button { border: 0; border-radius: 12px; background: var(--janua-color); color: white; padding: 10px 14px; font-weight: 700; cursor: pointer; }
      .janua-widget__send:disabled, .janua-widget__input:disabled { opacity: .65; cursor: not-allowed; }
      .janua-widget__lead-form { display: grid; gap: 8px; padding: 12px; margin: 0 0 10px; background: #fff; border: 1px solid #c7d2fe; border-radius: 16px; }
      .janua-widget__lead-field { display: grid; gap: 4px; color: #334155; font-size: 12px; font-weight: 700; }
      .janua-widget__loader { display: inline-flex; gap: 4px; margin-left: 6px; vertical-align: middle; }
      .janua-widget__loader span { width: 6px; height: 6px; border-radius: 999px; background: var(--janua-color); animation: janua-widget-pulse 900ms ease-in-out infinite; }
      .janua-widget__loader span:nth-child(2) { animation-delay: 120ms; }
      .janua-widget__loader span:nth-child(3) { animation-delay: 240ms; }
      @keyframes janua-widget-attention { 0%, 72%, 100% { transform: translateY(0) scale(1); } 78% { transform: translateY(-2px) scale(1.015); } 84% { transform: translateY(0) scale(1); } }
      .janua-widget--dark .janua-widget__panel { background: linear-gradient(180deg, #0f172a 0%, #0b1120 48%, #020617 100%); border-color: rgba(148, 163, 184, .24); }
      .janua-widget--dark .janua-widget__header { background: transparent; color: #f8fafc; border-color: transparent; }
      .janua-widget--dark .janua-widget__header span:not(.janua-widget__identity-mark) { color: #94a3b8; }
      .janua-widget--dark .janua-widget__close { background: rgba(148, 163, 184, .14); color: #e2e8f0; border-color: rgba(148, 163, 184, .2); }
      .janua-widget--dark .janua-widget__messages { background: transparent; }
      .janua-widget--dark .janua-widget__message--assistant,
      .janua-widget--dark .janua-widget__lead-form { background: #111827; color: #f8fafc; border-color: rgba(148, 163, 184, .25); }
      .janua-widget--dark .janua-widget__composer { background: rgba(15, 23, 42, .56); border-color: rgba(148, 163, 184, .18); }
      .janua-widget--dark .janua-widget__input,
      .janua-widget--dark .janua-widget__lead-form input { background: #020617; color: #f8fafc; border-color: rgba(148, 163, 184, .35); }
      @keyframes janua-widget-pulse { 0%, 80%, 100% { transform: translateY(0); opacity: .35; } 40% { transform: translateY(-5px); opacity: 1; } }
      @media (prefers-reduced-motion: reduce) {
        .janua-widget__bubble, .janua-widget__loader span { animation: none; transition: none; }
      }
      @media (prefers-color-scheme: dark) {
        .janua-widget:not(.janua-widget--light) .janua-widget__panel { background: linear-gradient(180deg, #0f172a 0%, #0b1120 48%, #020617 100%); border-color: rgba(148, 163, 184, .24); }
        .janua-widget:not(.janua-widget--light) .janua-widget__header { background: transparent; color: #f8fafc; border-color: transparent; }
        .janua-widget:not(.janua-widget--light) .janua-widget__header span:not(.janua-widget__identity-mark) { color: #94a3b8; }
        .janua-widget:not(.janua-widget--light) .janua-widget__close { background: rgba(148, 163, 184, .14); color: #e2e8f0; border-color: rgba(148, 163, 184, .2); }
        .janua-widget:not(.janua-widget--light) .janua-widget__messages { background: transparent; }
        .janua-widget:not(.janua-widget--light) .janua-widget__message--assistant,
        .janua-widget:not(.janua-widget--light) .janua-widget__lead-form { background: #111827; color: #f8fafc; border-color: rgba(148, 163, 184, .25); }
        .janua-widget:not(.janua-widget--light) .janua-widget__composer { background: rgba(15, 23, 42, .56); border-color: rgba(148, 163, 184, .18); }
        .janua-widget:not(.janua-widget--light) .janua-widget__input,
        .janua-widget:not(.janua-widget--light) .janua-widget__lead-form input { background: #020617; color: #f8fafc; border-color: rgba(148, 163, 184, .35); }
      }
      @media (max-height: 640px) {
        .janua-widget__panel { height: calc(100vh - 24px); max-height: calc(100vh - 24px); }
      }
      @media (max-width: 420px) {
        .janua-widget { left: 12px; right: 12px; bottom: 12px; }
        .janua-widget__bubble { min-width: 100%; justify-content: center; }
        .janua-widget__panel { width: 100%; border-radius: 22px; }
        .janua-widget__composer { flex-direction: column; }
        .janua-widget__send { width: 100%; }
      }
    `;
    document.head.appendChild(style);
  }
}

async function* readSSE(stream: ReadableStream<Uint8Array>): AsyncIterable<{ event: string; data: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const event = parseSSE(part);
      if (event) yield event;
    }
  }
}

function parseSSE(block: string): { event: string; data: string } | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function isAbortError(error: unknown): boolean {
  return error === "first-token-timeout" || (error instanceof DOMException && error.name === "AbortError");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function leadFormFieldKeys(): LeadFormFieldKey[] {
  return ["name", "phone", "email", "company"];
}

function defaultLeadFormConfig(): LeadFormConfig {
  return {
    name: { enabled: true, required: true, label: "Name", placeholder: "Your name" },
    phone: { enabled: true, required: false, label: "Phone", placeholder: "Phone number" },
    email: { enabled: true, required: false, label: "Email", placeholder: "you@example.com" },
    company: { enabled: false, required: false, label: "Company", placeholder: "Company name" },
  };
}

function getOrCreateId(siteToken: string, name: "conversationId" | "visitorId"): string {
  const key = `janua:${siteToken}:${name}`;
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const value = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  localStorage.setItem(key, value);
  return value;
}

const bootScript = document.currentScript as HTMLScriptElement | null;

function boot(): void {
  const script = bootScript ?? document.querySelector<HTMLScriptElement>("script[data-token][src]");
  const token = script?.dataset.token ?? "dev-site-token";
  const baseUrl = resolveBaseUrl(script);
  new JanuaWidget({ token, baseUrl });
}

function resolveBaseUrl(script: HTMLScriptElement | null | undefined): string {
  const configuredBaseUrl = script?.dataset.baseUrl?.trim();
  if (configuredBaseUrl) return configuredBaseUrl;
  if (script?.src) return new URL(script.src).origin;
  return window.location.origin;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
