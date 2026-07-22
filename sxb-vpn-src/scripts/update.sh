#!/bin/bash
# SXB VPN Update Script
# Updates the SXB VPN platform to the latest version

set -e

APP_DIR="/var/www/sxb-vpn"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() {
    echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[$(date +%H:%M:%S)]${NC} $1"
}

log_error() {
    echo -e "${RED}[$(date +%H:%M:%S)]${NC} $1"
    exit 1
}

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    log_error "Please run as root (use sudo)"
fi

cd "$APP_DIR"

log "Starting SXB VPN update..."

# Pull latest changes
log "Pulling latest changes from Git..."
git pull origin main

# Install dependencies
log "Installing/updating Node.js dependencies..."
npm ci

# Run database migrations
log "Running database migrations..."
npx prisma migrate deploy

# Rebuild and restart containers
log "Rebuilding Docker containers..."
docker-compose build

log "Restarting services..."
docker-compose up -d

log_success "Update completed!"
