#!/bin/sh
set -e

echo "Injecting runtime environment variables..."

# Replace placeholders in built JS files with runtime env var values
find /app/explorer/dist/assets -name "*.js" \
  -exec sed -i "s|VITE_SEARCH_SERVER_PLACEHOLDER|${VITE_SEARCH_SERVER}|g" {} \;

echo "Starting explorer..."
exec node server.js