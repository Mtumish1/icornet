# syntax=docker/dockerfile:1

# ---- Build stage ----
FROM node:20-alpine AS deps
WORKDIR /app

COPY package*.json ./
# Install production deps only
RUN npm ci --omit=dev

# ---- Runtime stage ----
FROM node:20-alpine AS runtime
WORKDIR /app

# Non-root user for security
RUN addgroup -S hotspot && adduser -S hotspot -G hotspot

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=hotspot:hotspot . .

USER hotspot

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
