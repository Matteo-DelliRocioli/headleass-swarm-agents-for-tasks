FROM node:22-slim
RUN apt-get update && apt-get install -y curl ripgrep && rm -rf /var/lib/apt/lists/*
# Install OpenCode CLI from GitHub releases (auto-detect arch)
ARG OPENCODE_VERSION=1.3.17
ARG TARGETARCH
RUN ARCH=$([ "$TARGETARCH" = "arm64" ] && echo "arm64" || echo "x64") && \
    curl -fsSL "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-${ARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin && \
    chmod +x /usr/local/bin/opencode
# Copy OpenCode configuration (agents, tools, plugins)
COPY opencode-config/ /root/.config/opencode/
COPY personas/ /workspace/.opencode/agents/
WORKDIR /workspace
CMD ["opencode", "serve", "--port", "4096", "--hostname", "0.0.0.0"]
