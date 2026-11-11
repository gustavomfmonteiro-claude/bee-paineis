FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs coletor.mjs analise.mjs lojas-pmef.json visitas.json ./
COPY public ./public
EXPOSE 3070
CMD ["node", "server.mjs"]
