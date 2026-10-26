FROM node:22.23.4-alpine3.24 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22.23.4-alpine3.24
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Runs as the image's unprivileged `node` user. A Docker volume mounted on /data starts out owned
# by it; StartOS mounts the volume root-owned, and the package's `chown` step hands it over.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "src/main.js"]
