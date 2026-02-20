# ============================================================================
# x811 Protocol Server — Multi-stage Docker Build
# ============================================================================

# ---------- Stage 1: Builder ----------
FROM node:20-alpine AS builder

WORKDIR /build

# Copy workspace root files needed for install
COPY package.json package-lock.json tsconfig.json turbo.json ./

# Copy all package manifests (for npm workspace resolution)
COPY packages/core/package.json packages/core/tsconfig.json packages/core/
COPY packages/server/package.json packages/server/tsconfig.json packages/server/
COPY packages/sdk-ts/package.json packages/sdk-ts/tsconfig.json packages/sdk-ts/

# Install all dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY packages/core/src/ packages/core/src/
COPY packages/server/src/ packages/server/src/
COPY packages/sdk-ts/src/ packages/sdk-ts/src/

# Build all packages (core first via turbo dependency graph)
RUN npx turbo run build

# ---------- Stage 2: Production ----------
FROM node:20-alpine AS production

WORKDIR /app

# Copy workspace root files for production install
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/sdk-ts/package.json packages/sdk-ts/

# Install production dependencies only
RUN npm ci --omit=dev

# Copy built artifacts from builder
COPY --from=builder /build/packages/core/dist/ packages/core/dist/
COPY --from=builder /build/packages/server/dist/ packages/server/dist/
COPY --from=builder /build/packages/sdk-ts/dist/ packages/sdk-ts/dist/

# Create data directory for SQLite
RUN mkdir -p /data && chown node:node /data

# Switch to non-root user
USER node

# Environment defaults
ENV PORT=3811
ENV NODE_ENV=production
ENV DATABASE_URL=/data/x811.db
ENV LOG_LEVEL=info

# Expose the server port
EXPOSE 3811

# Healthcheck — verify the server responds
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider --quiet http://localhost:3811/health || exit 1

# Start the server
CMD ["node", "packages/server/dist/app.js"]
