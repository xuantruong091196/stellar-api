# ─── Stage 1: Dependencies ────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

# Install production dependencies + generate Prisma client
COPY package.json yarn.lock ./
COPY prisma ./prisma
COPY prisma.config.ts ./

RUN yarn install --frozen-lockfile --production && \
    npx prisma generate && \
    yarn cache clean

# ─── Stage 2: Builder ─────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install ALL dependencies (including devDependencies for build)
COPY package.json yarn.lock ./
COPY prisma ./prisma
COPY prisma.config.ts ./

RUN yarn install --frozen-lockfile && \
    npx prisma generate && \
    yarn cache clean

# Copy source code
COPY . .

# Build NestJS
ENV NODE_ENV=production
RUN yarn build

# ─── Stage 3: Runner (Distroless) ────────────────────────────────────
FROM gcr.io/distroless/nodejs22-debian12 AS runner

# Distroless has no shell, no package manager — minimal attack surface
# Default non-root user in distroless: UID 65534 (nobody)
USER 65534

WORKDIR /app

# Copy production node_modules (with Prisma client already generated)
COPY --from=deps --chown=65534:65534 /app/node_modules ./node_modules
COPY --from=deps --chown=65534:65534 /app/generated ./generated

# Copy compiled application
COPY --from=builder --chown=65534:65534 /app/dist ./dist
COPY --from=builder --chown=65534:65534 /app/package.json ./package.json

# Copy Prisma schema (needed at runtime for Prisma client)
COPY --from=builder --chown=65534:65534 /app/prisma ./prisma

# Hardcode production environment
ENV NODE_ENV=production
ENV PORT=8000

EXPOSE 8000

# NestJS entry point
CMD ["dist/main.js"]
