# ──────── Stage 1: Build ────────
FROM node:20-alpine AS builder

WORKDIR /usr/app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build || true # Build if tsc exists, otherwise we'll run via ts-node in prod for simplicity in this PoC

# ──────── Stage 2: Runtime ────────
FROM node:20-alpine

WORKDIR /usr/app
COPY --from=builder /usr/app/package*.json ./
RUN npm install --only=production
RUN npm install ts-node typescript
COPY --from=builder /usr/app/. .

# Expose microservice port
EXPOSE 3001

# Launch the Discovery Engine
CMD ["npx", "ts-node", "src/index.ts"]
