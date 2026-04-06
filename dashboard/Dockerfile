FROM node:20-slim
WORKDIR /app
COPY dashboard/package.json dashboard/package-lock.json* ./
RUN npm install --omit=dev
COPY dashboard/dist/ ./dist/
COPY dashboard/public/ ./public/
ENV NODE_ENV=production
CMD ["node", "dist/server.js"]
