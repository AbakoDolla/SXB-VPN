#!/bin/bash
# SXB VPN Restore Script
# Restores SXB VPN from a backup

set -e

# Configuration
BACKUP_DIR="/opt/sxb/backups"
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

# List available backups
echo "Available backups:"
ls -lh "$BACKUP_DIR" 2>/dev/null || log_error "Backup directory not found"
echo ""

# Ask for backup file
read -p "Enter backup filename to restore (e.g., sxb_vpn_db_20240101_120000.sql): " BACKUP_FILE

if [ ! -f "$BACKUP_DIR/$BACKUP_FILE" ]; then
    log_error "Backup file not found: $BACKUP_FILE"
fi

# Confirm restoration
log_warning "This will restore the database from: $BACKUP_FILE"
read -p "Are you sure? (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
    log "Restore cancelled"
    exit 0
fi

# Stop services
log_warning "Stopping services..."
docker-compose -f "$APP_DIR/docker-compose.yml" down

# Restore PostgreSQL
log "Restoring PostgreSQL database..."
sudo -u postgres dropdb sxb_vpn 2>/dev/null || true
sudo -u postgres createdb sxb_vpn
sudo -u postgres psql sxb_vpn < "$BACKUP_DIR/$BACKUP_FILE"

log_success "Database restored successfully!"

# Restart services
log "Restarting services..."
docker-compose -f "$APP_DIR/docker-compose.yml" up -d

log_success "Restore completed!"
