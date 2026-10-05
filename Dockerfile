# Agent Mesh broker image.
#
# The service is pure TypeScript executed directly by Node.js 24's built-in
# type stripping: there is no build stage and no compiled JavaScript. Only
# production dependencies are installed; the TypeScript compiler, ESLint and
# Prettier are development tools that never enter the image.
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first so this layer is cached across source changes.
# --ignore-scripts: no dependency may run install-time code in the image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src

# /data holds the project's configuration, identities and SQLite state; it is
# mounted as a named volume and owned by the unprivileged `node` user.
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 4317
VOLUME ["/data"]
CMD ["node", "src/cli.ts", "start", "--project", "/data", "--host", "0.0.0.0"]
