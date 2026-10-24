# ---- build ----
FROM node:20-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---- runtime ----
# dist/boot.js is a self-contained bundle, so no node_modules are needed.
# Secrets come from the environment (docker compose env_file), never the image.
FROM node:20-alpine
WORKDIR /code
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=build /src/dist ./dist
COPY --from=build /src/db/migrations ./db/migrations
USER node
EXPOSE 3000
CMD ["node", "dist/boot.js"]
