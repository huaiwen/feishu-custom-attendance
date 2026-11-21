FROM node:24-alpine

WORKDIR /app
COPY package.json server.mjs domain.mjs feishu.mjs schedule-tools.mjs access.mjs ./
COPY public/ ./public/
RUN mkdir -p /app/data && chown node:node /app/data && chmod 700 /app/data

ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173
USER node
VOLUME ["/app/data"]
EXPOSE 4173
CMD ["node", "server.mjs"]
