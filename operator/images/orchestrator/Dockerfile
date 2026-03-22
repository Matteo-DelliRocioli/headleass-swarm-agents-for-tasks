FROM mcr.microsoft.com/playwright:v1.50.0-noble
# Install Node.js tools
RUN npm install -g @beads/bd
# Copy orchestrator code
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY dist/ ./dist/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
WORKDIR /workspace
ENTRYPOINT ["/app/entrypoint.sh"]
