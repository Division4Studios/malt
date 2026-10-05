FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 4317
VOLUME ["/data"]
CMD ["node", "src/cli.js", "start", "--project", "/data", "--host", "0.0.0.0"]
