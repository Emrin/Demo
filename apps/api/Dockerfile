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
# Generate Prisma client and build
RUN pnpm --filter api exec prisma generate
RUN pnpm --filter api build
# Deploy production bundle (pnpm deploy excludes gitignored dist/, copy manually)
RUN pnpm --filter api deploy --prod /deploy
RUN cp -r apps/api/dist /deploy/dist
RUN cp -r apps/api/prisma /deploy/prisma
# Re-generate Prisma client inside the isolated deploy dir
RUN cd /deploy && node_modules/.bin/prisma generate --schema=prisma/schema.prisma

FROM node:20-alpine AS runner
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /deploy ./
EXPOSE 3000
# Run migrations then start — pod will restart if Postgres isn't ready yet
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && node dist/main"]
