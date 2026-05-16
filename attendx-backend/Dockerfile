FROM node:20-alpine

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies (skip prepare script to avoid loop)
RUN pnpm install --frozen-lockfile --ignore-scripts

# Run postinstall manually (generates Prisma client)
RUN pnpm run postinstall || true

# Copy source code
COPY . .

# Create necessary directories
RUN mkdir -p uploads logs

# Expose port
EXPOSE 3000

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start app (run migrations then start server)
CMD ["sh", "-c", "pnpm run migrate:deploy && node src/server.js"]