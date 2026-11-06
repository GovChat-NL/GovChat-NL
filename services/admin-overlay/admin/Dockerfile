FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib/ ./lib/
COPY views/ ./views/
COPY defaults/ ./defaults/

EXPOSE 3002

CMD ["node", "server.js"]
