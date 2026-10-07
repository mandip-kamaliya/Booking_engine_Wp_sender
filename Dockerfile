FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY config ./config
COPY src ./src
CMD ["node", "src/hosted.js"]
