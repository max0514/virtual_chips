# Two stages so the shipped image carries the built app and one runtime
# dependency (ws), not the toolchain that produced it.

FROM node:22-alpine AS build
WORKDIR /app

# Copy manifests first: this layer only busts when dependencies actually
# change, so day-to-day rebuilds skip the install entirely.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
COPY server ./server
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# --omit=dev leaves only `ws`; vite, react and the test runner stay behind.
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/build ./build

# Run as the image's own unprivileged user rather than root.
USER node

# The platform overrides this; the default keeps `docker run` working alone.
ENV PORT=8787
EXPOSE 8787

# Node as PID 1 receives SIGTERM directly, which is what the graceful shutdown
# in server/index.ts is waiting for. Wrapping this in `npm start` would swallow
# the signal and the platform would end up killing the container instead.
CMD ["node", "build/server/index.js"]
