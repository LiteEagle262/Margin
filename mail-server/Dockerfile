FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production \
    HTTP_PORT=8080 \
    SMTP_PORT=25 \
    DB_FILE=/app/data/mail.db

EXPOSE 8080 25

CMD ["node", "src/index.js"]
