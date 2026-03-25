FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

FROM base AS builder
WORKDIR /app
# Copy workspace manifests first for better layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/typescript-config/package.json packages/typescript-config/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile
# Copy source
COPY packages packages
COPY apps/api apps/api
# Build
RUN pnpm --filter api build
# Deploy production bundle (pnpm deploy excludes gitignored dist/, copy manually)
RUN pnpm --filter api deploy --prod /deploy
RUN cp -r apps/api/dist /deploy/dist

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /deploy ./
EXPOSE 3000
CMD ["node", "dist/main"]