FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs regras.mjs mcp.mjs ./
COPY public ./public
ENV NODE_ENV=production
EXPOSE 3110
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:3110/saude || exit 1
CMD ["node", "server.mjs"]
