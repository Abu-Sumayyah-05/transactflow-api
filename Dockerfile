# The live demo as one container (Phase 11). Railway builds this file.
#
# Two stages, so the finished image carries only what it needs to run:
#   1. "web" builds the React site into static files.
#   2. the final image has the backend, its production packages and those
#      files. No build tools and no test code are shipped.

FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY mockbank ./mockbank
COPY scripts ./scripts
COPY --from=web /web/dist ./web/dist
# Run as the unprivileged "node" user, not root.
USER node
# Migrations, demo accounts, both mock banks, the API, the site and the
# background jobs, in one process (see scripts/demo.js).
CMD ["node", "scripts/demo.js"]
