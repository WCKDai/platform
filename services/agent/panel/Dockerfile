FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json server.mjs rent.mjs studio.mjs ./
COPY public ./public

USER node
EXPOSE 7800

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7800/healthz >/dev/null || exit 1

CMD ["node", "server.mjs"]
