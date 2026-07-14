# ==========================================
# STAGE 1: Build & Compile assets
# ==========================================
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency manifests
copy package*.json ./

# Install ALL dependencies (including dev)
RUN npm ci

# Copy full codebase
COPY . .

# Generate Prisma Client (ignore error if no schema or DATABASE_URL present during local build)
RUN npx prisma generate || true

# Compile production-ready artifacts
# Build React frontend static dist, and bundle our Node server
RUN npm run build

# ==========================================
# STAGE 2: Lightweight Production Runtime
# ==========================================
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Copy manifests
COPY package*.json ./

# Install ONLY production dependencies to keep the image minimal & secure
RUN npm ci --only=production

# Copy compiled distribution bundles from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

# Generate lightweight Prisma Client binary for production runtime
RUN npx prisma generate || true

# Expose server ingress port
EXPOSE 3000

# Start compiled CJS Server
CMD ["npm", "run", "start"]
