# =============================================================================
# Trading Intelligence API — Multi-Stage Docker Build
# =============================================================================
# Produces a minimal production image for the Express backend with:
#   - Turborepo + pnpm monorepo-aware dependency resolution
#   - TypeScript compilation of API and shared workspace packages
#   - Non-root user for production security
#   - Alpine-based image for minimal footprint
#
# Build context: monorepo root (docker build -f apps/api/Dockerfile .)
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: deps — Install all dependencies (dev + prod) for building
# ---------------------------------------------------------------------------
FROM node:24-alpine AS deps

# Enable pnpm via Node.js corepack (bundled with Node 24 LTS)
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /app

# Copy only dependency manifests first for optimal Docker layer caching.
# Changes to source code will NOT invalidate the expensive install layer.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./

# Copy workspace package.json files required by the api app and its
# workspace dependencies (types, utils, config). pnpm needs these to
# resolve workspace:* protocol references in the lockfile.
COPY apps/api/package.json ./apps/api/
COPY packages/types/package.json ./packages/types/
COPY packages/utils/package.json ./packages/utils/
COPY packages/config/package.json ./packages/config/

# Install ALL dependencies (including devDependencies) because the builder
# stage needs TypeScript compiler and other build tools.
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Stage 2: builder — Compile TypeScript source code
# ---------------------------------------------------------------------------
FROM deps AS builder

# Copy the shared TypeScript base config used by all workspace packages
COPY tsconfig.base.json ./

# Copy all source code for workspace packages that the API depends on.
# These must be built before the API since it imports from them.
COPY packages/types/ ./packages/types/
COPY packages/utils/ ./packages/utils/
COPY packages/config/ ./packages/config/

# Copy the API application source code
COPY apps/api/ ./apps/api/

# Build workspace packages in topological dependency order:
#   1. @trading-intelligence/types  — no workspace deps (leaf package)
#   2. @trading-intelligence/utils  — depends on types
#   3. @trading-intelligence/api    — depends on types + utils
# Each filter runs the package's "build" script (tsc compilation).
RUN pnpm --filter @trading-intelligence/types build && \
    pnpm --filter @trading-intelligence/utils build && \
    pnpm --filter @trading-intelligence/api build

# ---------------------------------------------------------------------------
# Stage 3: production — Minimal runtime image
# ---------------------------------------------------------------------------
FROM node:24-alpine AS production

# Enable pnpm for workspace-aware production dependency resolution
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# Set production environment — Express uses this for performance optimizations,
# Pino disables pretty-printing, and pnpm skips devDependencies.
ENV NODE_ENV=production

# Create a non-root user and group for running the application.
# Using fixed UID/GID (1001) for consistency across deployments and
# compatibility with Kubernetes security contexts.
RUN addgroup -g 1001 -S nodejs && \
    adduser -S trading -u 1001 -G nodejs

WORKDIR /app

# Copy workspace manifests and lockfile for pnpm to resolve workspace:*
# protocol references and install only production dependencies.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/types/package.json ./packages/types/
COPY packages/utils/package.json ./packages/utils/
COPY packages/config/package.json ./packages/config/

# Install ONLY production dependencies (no devDependencies like typescript,
# tsx, vitest, drizzle-kit, pino-pretty, etc.). This significantly reduces
# image size and attack surface.
RUN pnpm install --prod --frozen-lockfile && \
    pnpm store prune

# Copy compiled JavaScript output from the builder stage.
# Only dist/ directories are needed — no TypeScript source files.
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/packages/types/dist ./packages/types/dist
COPY --from=builder /app/packages/utils/dist ./packages/utils/dist

# Transfer ownership of the app directory to the non-root user
RUN chown -R trading:nodejs /app

# Switch to non-root user — all subsequent commands and the final CMD
# run as this unprivileged user for production security.
USER trading

# Expose the Express server port (configurable via PORT env var,
# defaults to 3000 in the application config).
EXPOSE 3000

# Health check using wget (available by default in Alpine).
# Probes the /api/health endpoint which reports PostgreSQL, Redis,
# and external API source connectivity status.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Start the Express application. The compiled entry point bootstraps:
#   - Express middleware chain (CORS, Helmet, request logging, error handler)
#   - Drizzle ORM database connection
#   - BullMQ queue initialization and worker registration
#   - grammY Telegram bot long polling
#   - Bull Board admin dashboard at /admin/queues
#   - REST API route mounting
CMD ["node", "apps/api/dist/index.js"]
