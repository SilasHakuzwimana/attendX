#!/bin/bash

echo "=== Deploying to Railway with pnpm ==="

# Ensure we have the latest dependencies
pnpm install

# Generate Prisma client
pnpm run generate

# Test migrations locally
pnpm run migrate:deploy

# Deploy to Railway
railway up

echo "✅ Deployment complete!"
echo "View logs: railway logs"
echo "Open app: railway open"
