FROM node:20-slim

# Install git (required by beads for database init) and beads CLI
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN npm install -g @beads/bd 2>/dev/null || echo "beads not available in registry, will use local bd"

WORKDIR /app

# Copy package files and install deps
COPY operator/package.json operator/package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Copy compiled TypeScript
COPY operator/dist/ ./dist/

COPY operator/images/operator/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENV NODE_ENV=production

ENTRYPOINT ["/app/entrypoint.sh"]
