# syntax=docker/dockerfile:1
# Build context is the repository root: docker build -f apps/web/Dockerfile .

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci -w @seatlock/web -w @seatlock/shared --include-workspace-root
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
# The Lab page bundles loadtest/results/summary.json at build time (import.meta.glob). Copying the
# folder, not results/ itself, still works before any results exist.
COPY loadtest/ loadtest/
RUN npm run build -w @seatlock/web

# nginx serves the SPA and load-balances /api across the API replicas.
FROM nginx:alpine AS runtime
COPY infra/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
