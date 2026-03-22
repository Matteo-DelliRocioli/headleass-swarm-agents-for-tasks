FROM node:22-slim
# Install Beads CLI
RUN npm install -g @beads/bd
# Copy and build operator
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY dist/ ./dist/
# Non-root user
USER node
CMD ["node", "dist/index.js"]
