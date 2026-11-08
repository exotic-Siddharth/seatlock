# syntax=docker/dockerfile:1
# Build context is the repository root: docker build -f apps/api/Dockerfile .

FROM node:22.23.4-alpine AS build
WORKDIR /app
# Manifests first, so the dependency layer is cached until a package.json or the lockfile changes.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci -w @seatlock/api -w @seatlock/shared --include-workspace-root
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
# tsup bundles @seatlock/shared into dist; everything else stays an external dependency.
RUN npm run build -w @seatlock/api

FROM node:22.23.4-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci --omit=dev -w @seatlock/api && npm cache clean --force

FROM node:22.23.4-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
# dist/scripts/migrate.js finds the SQL at ../../migrations.
COPY apps/api/migrations ./migrations
USER node
EXPOSE 4200
# Replicas start together; migrate() holds an advisory lock, so only one applies each migration.
CMD ["sh", "-c", "node dist/scripts/migrate.js && exec node dist/index.js"]
