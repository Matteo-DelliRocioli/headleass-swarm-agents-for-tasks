FROM node:22-slim
RUN npm install -g @opencode-ai/opencode
# Copy OpenCode configuration (agents, tools, plugins)
COPY .opencode/ /workspace/.opencode/
COPY personas/ /workspace/.opencode/agents/
WORKDIR /workspace
CMD ["opencode", "serve", "--port", "4096", "--hostname", "0.0.0.0"]
