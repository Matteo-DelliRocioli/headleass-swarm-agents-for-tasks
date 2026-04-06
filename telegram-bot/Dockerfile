FROM node:20-slim
WORKDIR /app
COPY telegram-bot/package.json telegram-bot/package-lock.json* ./
RUN npm install --omit=dev
COPY telegram-bot/dist/ ./dist/
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
