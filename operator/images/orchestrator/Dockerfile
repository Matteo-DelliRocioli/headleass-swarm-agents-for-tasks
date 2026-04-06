FROM mcr.microsoft.com/playwright:v1.50.0-noble

# Install system tools
RUN npm install -g @beads/bd

# Copy and build orchestrator
WORKDIR /app
COPY orchestrator/package.json ./
RUN npm install
COPY orchestrator/tsconfig.json ./
COPY orchestrator/src/ ./src/
RUN npx tsc

# Copy entrypoint
COPY operator/images/orchestrator/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

WORKDIR /workspace
ENTRYPOINT ["/app/entrypoint.sh"]
