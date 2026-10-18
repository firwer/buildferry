FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig*.json vite.config.ts ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 BUILDFERRY_DATA_DIR=/data
WORKDIR /app
RUN mkdir /data && chmod 700 /data && chown node:node /data
COPY --from=build --chmod=0444 /app/package.json ./
COPY --from=build --chmod=0555 /app/node_modules ./node_modules
COPY --from=build --chmod=0555 /app/dist ./dist
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8787/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/server/index.js"]
