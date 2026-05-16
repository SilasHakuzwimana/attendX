# Dockerfile
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y openssl ca-certificates

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@10.33.2

# Copy package files
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Stage 2: Production
FROM node:20-slim

# Install dumb-init, openssl, AND pnpm for runtime
RUN apt-get update && apt-get install -y \
    dumb-init \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm in runtime stage as well
RUN npm install -g pnpm@10.33.2

WORKDIR /app

# Copy from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/src ./src

RUN mkdir -p uploads logs temp

ENV NODE_ENV=production
ENV PORT=3000

RUN groupadd -r attendx && useradd -r -g attendx attendx && \
    chown -R attendx:attendx /app

USER attendx

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]

# Use the full command without relying on pnpm from builder
CMD ["sh", "-c", "npx prisma migrate deploy && node src/server.js"]