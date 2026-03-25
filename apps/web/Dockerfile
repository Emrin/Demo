FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

FROM base AS builder
WORKDIR /app
# Copy workspace manifests first for better layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/typescript-config/package.json packages/typescript-config/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
# Copy source
COPY packages packages
COPY apps/web apps/web
# PUBLIC_API_URL is baked in at build time; empty = same-origin (ingress), full URL = external
ARG PUBLIC_API_URL=""
ENV PUBLIC_API_URL=$PUBLIC_API_URL
RUN pnpm --filter web build
# Deploy production bundle (pnpm deploy excludes gitignored dist/, copy manually)
RUN pnpm --filter web deploy --prod /deploy
RUN cp -r apps/web/dist /deploy/dist

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4321
COPY --from=builder /deploy ./
EXPOSE 4321
CMD ["node", "./dist/server/entry.mjs"]