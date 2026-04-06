FROM node:22-slim
RUN apt-get update && apt-get install -y ca-certificates curl git && rm -rf /var/lib/apt/lists/*
# Install beads via npm (Go build requires Go 1.25.8+, not yet in Docker Hub)
RUN npm install -g @beads/bd
WORKDIR /workspace
# Init beads on first run if not already initialized
CMD ["sh", "-c", "cd /workspace && (test -d .beads || bd init --stealth) && bd daemon start --local"]
