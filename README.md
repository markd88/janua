# Janua — 24/7 self-hosted AI lead capture for your website

<a href="https://github.com/markd88/janua#top" title="Back to the top to star this repository">
  <img src="./assets/github-readme-star-cta.svg" width="100%" alt="Help grow the Janua community. Star this repo.">
</a>

## Introduction

Janua helps small businesses turn website visitors into leads they can actually call back. It gives visitors quick answers, asks for contact info when someone wants pricing, booking, or follow-up, and keeps the full conversation ready for review.

Janua is designed around the full lead-capture loop:

- **Answer with approved business knowledge:** Use business basics and FAQ instead of inventing facts.
- **Detect buying intent:** Ask for contact details when visitors want pricing, booking, or follow-up.
- **Hand off to a simple Admin:** Review lead status, contact fields, and the full conversation transcript.
- **Embed on any website:** Copy a lightweight widget snippet from the Admin and paste it into your site.
- **Stay self-hosted by default:** Keep customer conversations and lead data under your control.

## Demo

[![Watch the Janua demo](./assets/janua-demo-poster.jpg)](./assets/janua-demo.mp4)

[Watch the demo video](./assets/janua-demo.mp4)

## Quick Start

### Ask AI To Set Up

Paste this into Gemini, Claude, Codex, or another coding agent:

```text
Please clone Janua from https://github.com/markd88/janua.git, cd into the cloned folder, run ./scripts/quickstart.sh, and help me complete the interactive setup by following the script prompts.
```

### Set Up Yourself

From a checked-out repo:

```bash
./scripts/quickstart.sh
```

Open Admin:

```text
http://localhost:3000/admin
```

Try the demo chat:

```text
http://localhost:3000/demo
```

For production, set a stronger password in `config/agent-config.json` under `admin.password`, or set `JANUA_ADMIN_PASSWORD`.

Use Janua:

1. Sign in with the Admin password.
2. Open `Business Knowledge` and add business basics plus FAQ.
3. Open `Website Widget` and copy the embed snippet.
4. Paste the snippet into your website.
5. Ask a test question, submit the lead form, and confirm the lead appears in `Lead Inbox`.

## Add Janua To Your Website

The Admin `Website Widget` page shows the final snippet. It looks like this:

```html
<script
  src="https://janua.example.com/api/widget.js"
  data-token="your-public-site-token"
  defer
></script>
```

`data-token` is a public site identifier, not an Admin secret. The widget infers its API base URL from the script `src`; set `data-base-url` only for custom proxy deployments.

## Before You Go Live

Before exposing Janua publicly:

- Change the default Admin password with `JANUA_ADMIN_PASSWORD`, `JANUA_ADMIN_PASSWORD_HASH`, or `admin.password` in `config/agent-config.json`.
- Set `JANUA_PUBLIC_BASE_URL` to the public URL where Janua is hosted.
- Set `JANUA_ALLOWED_ORIGINS` to the website origins that are allowed to use the widget.
- Keep rate limiting on, especially for public chat requests.
- Back up `data/janua.db` and `config/agent-config.json` before upgrades.
- Test the full lead flow from widget question to `Lead Inbox`.

The widget `data-token` is public and can be copied. Protect AI cost with server-side allowed origins and rate limits.

## Configuration

Janua works with local AI through Ollama by default. OpenAI is also available when you prefer a hosted model:

```bash
JANUA_LLM_PROVIDER=openai OPENAI_API_KEY=sk-... OPENAI_MODEL=gpt-4o-mini docker compose up -d --build
```

Do not put `OPENAI_API_KEY` in `config/agent-config.json`; keep it in server environment or `.env`.

Copy the example config only when you need server-side customization for prompts, trigger words, provider settings, Admin password, or lead webhooks:

```bash
cp config/agent-config.example.json config/agent-config.json
```

Janua reads this file at startup. Restart the API after changing it.

## Development

Install dependencies:

```bash
pnpm install
```

Run all checks:

```bash
pnpm check
```

Run the API, widget, and Admin dev servers together:

```bash
pnpm dev
```

Open:

```text
http://localhost:3000/admin
http://localhost:3000/demo
```

## Architecture

- Website widget -> Janua API -> SQLite + LLM provider -> Admin inbox and optional webhook.
- `packages/core`: domain types, prompt builder, store interface, SQLite store, Drizzle schema.
- `packages/api`: Hono HTTP API, SSE chat, Admin auth, first-run setup.
- `packages/widget`: embeddable no-framework widget bundle.
- `packages/admin`: React + Vite + MUI merchant Admin UI.
- `config`: optional server-side config; `config/agent-config.json` is ignored by git.
- `data`: runtime SQLite files, ignored by git.

## Feedback

Have a feature request, found a bug, or want to chat about self-hosted AI lead capture?

Open an issue or email me at `markdba313 at gmail dot com`.
