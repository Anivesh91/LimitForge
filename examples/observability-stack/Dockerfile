FROM node:20-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --omit=dev && npm install --no-save express@^4.21.2 redis@^6.2.1

COPY src/ ./src/
COPY assets/ ./assets/
COPY examples/ ./examples/

EXPOSE 3000

CMD ["node", "examples/observability-stack/server.js"]
