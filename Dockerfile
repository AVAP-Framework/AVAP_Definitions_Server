FROM node:22-alpine

RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]

WORKDIR /app

# Installing dependencies
COPY package*.json ./
RUN npm ci --only=production --ignore-scripts && npm cache clean --force

# Copy needed files
COPY src/ ./src/
COPY avap.proto .


USER node

EXPOSE 50051

CMD ["node", "src/server.js"]