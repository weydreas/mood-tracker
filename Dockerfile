FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown -R node:node /app /data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DB_PATH=/data/mood.sqlite
EXPOSE 3000
CMD ["node", "src/server.js"]
