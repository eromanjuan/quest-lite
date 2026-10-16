# syntax=docker/dockerfile:1
# Quest Lite API — container image for the split deployment.
#
# Firebase Hosting's Spark (free) plan serves static files only: no Cloud
# Functions, no Cloud Run. So the SPA is hosted on Firebase and this image runs
# the Express API on a container host (Render free tier, Fly.io, Railway, or
# Cloud Run once on the Blaze plan).
#
# Build:  docker build -t quest-lite-api .
# Run:    docker run -p 8080:8080 -e SESSION_SECRET=... -v quest-data:/data quest-lite-api

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# better-sqlite3 needs a native toolchain only when a prebuilt binary is not
# available for the platform; install both paths so the build never depends on
# prebuild availability.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/data/quest-lite.sqlite \
    UPLOAD_DIR=/data/uploads

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server

# Data lives outside the image so a volume can persist it across restarts.
RUN mkdir -p /data/uploads && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "server/index.ts"]
