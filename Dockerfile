# ---- Build stage: install dependencies and compile TypeScript to dist/ ----
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json tsconfig.build.json ./
# Generating the Prisma client doesn't connect to a database, but the config expects a URL
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npx prisma generate

COPY src ./src
RUN npm run build

# ---- Runtime stage ----
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=5000

# node_modules includes the Prisma CLI (for migrations) and tsx (for the seed script)
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src

# Folders the app writes to, owned by the unprivileged "node" user the container runs as
RUN mkdir -p uploads outbox && chown -R node:node uploads outbox
USER node

EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -qO- "http://localhost:${PORT}/api/v1/health" || exit 1

# Apply any new database migrations, then start the API
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
