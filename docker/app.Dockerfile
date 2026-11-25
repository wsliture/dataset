FROM node:24-bookworm-slim AS api-build
WORKDIR /app/api
COPY api/package*.json ./
RUN npm ci
COPY api/tsconfig.json ./
COPY api/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS api
WORKDIR /app/api
ENV NODE_ENV=production HOST=0.0.0.0 DOCUMENT_ROOT=/data/documents
COPY --from=api-build /app/api/node_modules ./node_modules
COPY --from=api-build /app/api/dist ./dist
COPY api/package.json ./
COPY api/migrations ./migrations
COPY docker/offline-api-start.sh /usr/local/bin/dataset-start.sh
CMD ["sh", "/usr/local/bin/dataset-start.sh"]

FROM node:24-bookworm-slim AS web-build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/index.html web/tsconfig.json web/vite.config.ts ./
COPY web/src ./src
RUN npm run build

FROM nginx:stable-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/web/dist /usr/share/nginx/html
