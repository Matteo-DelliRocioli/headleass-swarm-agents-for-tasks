FROM node:20-slim
WORKDIR /app
COPY dashboard/package.json ./
RUN npm install
COPY dashboard/tsconfig.json ./
COPY dashboard/src/ ./src/
RUN npx tsc
COPY dashboard/public/ ./public/
ENV NODE_ENV=production
CMD ["node", "dist/server.js"]
