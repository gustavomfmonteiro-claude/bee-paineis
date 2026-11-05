FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs radar-coletor.mjs whatsapp.mjs ./
COPY public ./public
EXPOSE 3040
CMD ["node", "server.mjs"]
