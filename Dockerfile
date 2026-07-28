# ── build ────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json nest-cli.json ./
COPY src ./src
COPY public ./public

RUN npm run build && npm prune --omit=dev

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

# Never run as root.
RUN addgroup -S ori && adduser -S ori -G ori

COPY --from=build --chown=ori:ori /app/node_modules ./node_modules
COPY --from=build --chown=ori:ori /app/dist ./dist
COPY --from=build --chown=ori:ori /app/package.json ./package.json
# The console is served from disk at runtime.
COPY --from=build --chown=ori:ori /app/public ./public

USER ori

EXPOSE 3200

# Liveness only. Readiness (/ready) checks dependencies and is for the
# orchestrator to poll, not for the container runtime.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3200)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
