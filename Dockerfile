FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/board.db

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# The volume mounts at /data and must be writable by the unprivileged user.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8080
CMD ["node", "server.js"]
