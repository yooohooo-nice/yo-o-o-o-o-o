# Debian (not Alpine): webtorrent's native add-ons ship glibc prebuilds.
FROM node:20-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.mjs ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8090 6881 6881/udp
CMD ["node", "server.mjs"]
