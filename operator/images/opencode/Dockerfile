FROM node:22-slim
RUN apt-get update && apt-get install -y curl ripgrep && rm -rf /var/lib/apt/lists/*

# Install OpenCode CLI
ARG OPENCODE_VERSION=1.3.17
ARG OPENCODE_ARCH=arm64
RUN curl -fsSL "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-${OPENCODE_ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin && \
    chmod +x /usr/local/bin/opencode

# Install beads CLI for the tools to use
RUN npm install -g @beads/bd

# Install OpenCode plugin SDK + custom tools at /root/.config/opencode
WORKDIR /root/.config/opencode
COPY opencode-config/package.json opencode-config/package-lock.json* ./
RUN npm install

# Copy tools, plugins, agents, opencode.json
COPY opencode-config/ /root/.config/opencode/
# Re-symlink node_modules into tools/ since the COPY may have wiped it
RUN ln -sf /root/.config/opencode/node_modules /root/.config/opencode/tools/node_modules && \
    ln -sf /root/.config/opencode/node_modules /root/.config/opencode/plugins/node_modules

# Personas as agents
COPY personas/ /workspace/.opencode/agents/

WORKDIR /workspace
CMD ["opencode", "serve", "--port", "4096", "--hostname", "0.0.0.0"]
