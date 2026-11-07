# Multi-stage Dockerfile for UFSC Email MCP Server
# Stage 1: Build TypeScript source
FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json tsconfig*.json ./
RUN npm ci --ignore-scripts

COPY src/ ./src/
RUN npm run build && npm prune --omit=dev

# Stage 2: Production image
FROM node:22-alpine

RUN rm -rf /usr/local/bin/yarn* /usr/local/bin/corepack /opt/yarn*

WORKDIR /app
COPY package.json ./
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/dist/ ./dist/
COPY http-server.mjs ./

ENV NODE_ENV=production
ENV PORT=8087
ENV HOST=0.0.0.0

EXPOSE 8087

CMD ["node", "http-server.mjs"]
