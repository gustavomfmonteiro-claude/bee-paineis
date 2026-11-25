FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs mcp.mjs ./
COPY public ./public
EXPOSE 3095
CMD ["node", "server.mjs"]
