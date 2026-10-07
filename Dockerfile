# Single-process image: Node serves the API and the built SPA from one port, and
# SQLite lives on a mounted volume. Deliberately not serverless — the brief calls
# for SQLite/local files, which needs a persistent filesystem.
FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY shared/package.json  shared/
COPY server/package.json  server/
COPY web/package.json     web/
RUN npm ci --foreground-scripts

COPY . .
RUN npm run build

# ---------------------------------------------------------------------- run
FROM node:22-bookworm-slim AS run

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DB_PATH=/data/funnel.db

WORKDIR /app

COPY --from=build /app/node_modules      ./node_modules
COPY --from=build /app/package.json      ./package.json
COPY --from=build /app/server/dist       ./server/dist
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/web/dist          ./web/dist
COPY --from=build /app/configs           ./configs

RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/main.js"]
