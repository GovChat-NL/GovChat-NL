FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY db/ ./db/
COPY lib/ ./lib/
COPY views/ ./views/
COPY defaults/ ./defaults/

EXPOSE 3002

CMD ["node", "server.js"]
