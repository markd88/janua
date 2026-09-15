FROM node:20-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/core/package.json packages/core/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/widget/package.json packages/widget/package.json
COPY packages/admin/package.json packages/admin/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV JANUA_DB_PATH=/app/data/janua.db
ENV JANUA_CONFIG_DIR=/app/config
ENV JANUA_AGENT_CONFIG_PATH=/app/config/agent-config.json
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/core/drizzle ./packages/core/drizzle
COPY --from=build /app/packages/api/dist ./packages/api/dist
COPY --from=build /app/packages/widget/dist ./packages/widget/dist
COPY --from=build /app/packages/admin/dist ./packages/admin/dist
COPY package.json pnpm-workspace.yaml ./
RUN mkdir -p /app/data /app/config
EXPOSE 3000
CMD ["node", "packages/api/dist/server.js"]
