# Multi-stage Dockerfile for UFSC Email MCP Server
# Stage 1: Build TypeScript source
FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json tsconfig*.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# Stage 2: Production image
FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ ./dist/
COPY http-server.mjs ./

ENV NODE_ENV=production
ENV PORT=8087
ENV HOST=0.0.0.0

EXPOSE 8087

CMD ["node", "http-server.mjs"]
