#!/bin/bash
# SXB VPN Backup Script
# Creates backups of database and application files

set -e

# Configuration
BACKUP_DIR="/opt/sxb/backups"
APP_DIR="/var/www/sxb-vpn"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RETENTION_DAYS=7

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

# Create backup directory
mkdir -p "$BACKUP_DIR"

log "Starting SXB VPN backup..."

# Backup PostgreSQL database
log "Backing up PostgreSQL database..."
if sudo -u postgres pg_dump sxb_vpn > "$BACKUP_DIR/sxb_vpn_db_$TIMESTAMP.sql" 2>/dev/null; then
    log "Database backup created: sxb_vpn_db_$TIMESTAMP.sql"
else
    log_warning "Database backup failed or database doesn't exist"
fi

# Backup Redis data
log "Backing up Redis data..."
if docker container ls | grep -q sxb_vpn_redis; then
    docker exec sxb_vpn_redis redis-cli -a sxb_redis_pass_2026 SAVE
    docker cp sxb_vpn_redis:/data/dump.rdb "$BACKUP_DIR/sxb_redis_$TIMESTAMP.rdb" 2>/dev/null || log_warning "Redis backup skipped"
    log "Redis backup created: sxb_redis_$TIMESTAMP.rdb"
else
    log_warning "Redis container not found, skipping Redis backup"
fi

# Backup application files (exclude node_modules and git)
log "Backing up application files..."
tar -czf "$BACKUP_DIR/sxb_vpn_app_$TIMESTAMP.tar.gz" \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='dist' \
    --exclude='*.log' \
    -C "$APP_DIR" . 2>/dev/null || log_warning "App backup skipped"
log "Application backup created: sxb_vpn_app_$TIMESTAMP.tar.gz"

# Backup Nginx configs
log "Backing up Nginx configuration..."
tar -czf "$BACKUP_DIR/sxb_nginx_$TIMESTAMP.tar.gz" -C /etc/nginx sites-available/sxb-vpn 2>/dev/null || true
log "Nginx config backup created"

# List all backups
log "Current backups:"
ls -lh "$BACKUP_DIR"

# Clean old backups
log "Cleaning backups older than $RETENTION_DAYS days..."
find "$BACKUP_DIR" -name "*.sql" -mtime +$RETENTION_DAYS -delete 2>/dev/null || true
find "$BACKUP_DIR" -name "*.tar.gz" -mtime +$RETENTION_DAYS -delete 2>/dev/null || true
find "$BACKUP_DIR" -name "*.rdb" -mtime +$RETENTION_DAYS -delete 2>/dev/null || true

log "Backup completed successfully!"
