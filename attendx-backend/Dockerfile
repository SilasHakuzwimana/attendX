# Dockerfile - Using Debian slim for better compatibility
FROM node:20-slim

# Install dependencies
RUN apt-get update && apt-get install -y \
    dumb-init \
    openssl \
    ca-certificates \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Set environment variables
ENV NODE_ENV=production
ENV PRISMA_TELEMETRY_INFORMATION=skip

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@8.15.0

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Create necessary directories
RUN mkdir -p uploads logs temp

# Create non-root user
RUN groupadd -r attendx && useradd -r -g attendx attendx && \
    chown -R attendx:attendx /app

USER attendx

EXPOSE 3000

ENTRYPOINT ["dumb-init", "--"]

CMD ["sh", "-c", "npx prisma migrate deploy && node src/server.js"]