FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --loglevel=info

FROM dependencies AS build
COPY . .
RUN npm run db:generate && npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV MEDIA_DIR=/data/media
WORKDIR /app
RUN apt-get update \
    && apt-get install --yes --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system crm \
    && useradd --system --gid crm --home-dir /app crm
COPY --from=build --chown=crm:crm /app/package.json /app/package-lock.json ./
COPY --from=build --chown=crm:crm /app/node_modules ./node_modules
COPY --from=build --chown=crm:crm /app/.next ./.next
COPY --from=build --chown=crm:crm /app/prisma ./prisma
COPY --from=build --chown=crm:crm /app/scripts ./scripts
COPY --from=build --chown=crm:crm /app/prisma.config.ts ./prisma.config.ts
COPY --chown=root:root scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint
RUN mkdir -p /data/media && chown crm:crm /data/media
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint"]
