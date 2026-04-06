FROM node:22-slim
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
RUN npm install -g @opencode-ai/opencode
# Copy OpenCode configuration (agents, tools, plugins)
COPY opencode-config/ /root/.config/opencode/
COPY personas/ /workspace/.opencode/agents/
WORKDIR /workspace
CMD ["opencode", "serve", "--port", "4096", "--hostname", "0.0.0.0"]
