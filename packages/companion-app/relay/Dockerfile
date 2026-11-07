FROM node:24-alpine
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.34.9 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY src ./src
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production
ENV PORT=8790
ENV SATURA_RELAY_APP=off
ENV SATURA_RELAY_LOG=json
ENV SATURA_RELAY_USAGE_FILE=/data/usage.json
USER node
EXPOSE 8790
CMD ["node", "src/server.mjs"]
