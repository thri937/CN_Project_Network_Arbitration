# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage
#
# The full workspace is copied because the backend is an npm workspace member:
# `npm ci` needs the root lockfile to resolve a deterministic tree.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/

# `--workspace backend` skips the frontend's dependency tree entirely — Recharts and the
# Firebase web SDK have no business in a server image.
RUN npm ci --workspace backend --include-workspace-root

COPY backend ./backend

RUN npm run build --workspace backend

# ---------------------------------------------------------------------------
# Runtime stage
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# dumb-init reaps zombies and forwards SIGTERM properly. Without it Node runs as PID 1 and
# never receives the signal, so graceful shutdown is skipped and an in-flight arbitration
# can be interrupted mid-apply.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/

RUN npm ci --omit=dev --workspace backend --include-workspace-root \
 && npm cache clean --force

COPY --from=build /app/backend/dist ./backend/dist

# Never run as root.
USER node

EXPOSE 4000

# Uses the readiness probe, which exercises the datastore and telemetry provider rather than
# merely proving the process is alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "backend/dist/server.js"]
