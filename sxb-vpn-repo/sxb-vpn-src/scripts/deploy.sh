#!/bin/bash
# SXB VPN Deployment Script
# Deploys the SXB VPN platform to production

set -e

echo "========================================="
echo "SXB VPN Deployment Script"
echo "========================================="

# Configuration
APP_DIR="/var/www/sxb-vpn"
BACKUP_DIR="/opt/sxb/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
    exit 1
}

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    log_error "Please run as root (use sudo)"
fi

# Check if app directory exists
if [ ! -d "$APP_DIR" ]; then
    log_error "Application directory $APP_DIR does not exist. Please run install.sh first."
fi

cd "$APP_DIR"

# Create backup if database exists
if sudo -u postgres psql -lqt | cut -d \| -f 1 | grep -qw sxb_vpn; then
    log_warning "Creating database backup..."
    sudo -u postgres pg_dump sxb_vpn > "$BACKUP_DIR/sxb_vpn_backup_$TIMESTAMP.sql"
    log_success "Backup created: $BACKUP_DIR/sxb_vpn_backup_$TIMESTAMP.sql"
fi

# Pull latest changes
log_warning "Pulling latest changes from Git..."
git pull origin main

# Install dependencies
log_warning "Installing Node.js dependencies..."
npm ci

# Generate Prisma client and run migrations
log_warning "Setting up database..."
npx prisma generate
npx prisma db push

# Build the application
log_warning "Building application..."
npm run build

# Stop and remove old containers
log_warning "Cleaning up old containers..."
docker-compose down 2>/dev/null || true
docker container prune -f 2>/dev/null || true

# Build and start containers
log_warning "Building Docker containers..."
docker-compose build --no-cache

log_warning "Starting services..."
docker-compose up -d

# Wait for services to be healthy
log_warning "Waiting for services to start..."
sleep 10

# Check service status
if docker-compose ps | grep -q "Up"; then
    log_success "Services are running"
else
    log_error "Some services failed to start. Check logs with: docker-compose logs"
fi

# Configure Nginx
log_warning "Configuring Nginx..."
cat > /etc/nginx/sites-available/sxb-vpn << 'EOF'
server {
    listen 80;
    server_name vpnsxb.afrihall.com;

    client_max_body_size 100M;

    location /api {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
EOF

# Enable site
ln -sf /etc/nginx/sites-available/sxb-vpn /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Test and reload Nginx
nginx -t && systemctl reload nginx

# Set up SSL if not exists
if [ ! -f "/etc/letsencrypt/live/vpnsxb.afrihall.com/fullchain.pem" ]; then
    log_warning "Obtaining SSL certificate..."
    certbot --nginx -d vpnsxb.afrihall.com --non-interactive --agree-tos -m admin@sxbvpn.com
fi

# Create systemd service for the app
log_warning "Setting up systemd service..."
cat > /etc/systemd/system/sxb-vpn.service << 'EOF'
[Unit]
Description=SXB VPN Platform
Requires=docker-compose@sxb-vpn.service
After=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/docker-compose -f /var/www/sxb-vpn/docker-compose.yml up -d
ExecStop=/usr/local/bin/docker-compose -f /var/www/sxb-vpn/docker-compose.yml down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable sxb-vpn.service

# Set up cron for backups and updates
log_warning "Setting up cron jobs..."
(crontab -l 2>/dev/null; echo "0 2 * * * /var/www/sxb-vpn/scripts/backup.sh") | crontab -
(crontab -l 2>/dev/null; echo "0 3 * * 0 cd /var/www/sxb-vpn && git pull origin main && docker-compose up -d --build") | crontab -

log_success "Deployment complete!"
echo ""
echo "========================================="
echo "SXB VPN Deployed Successfully!"
echo "========================================="
echo ""
echo "Dashboard URL: https://vpnsxb.afrihall.com"
echo "API URL: https://vpnsxb.afrihall.com/api"
echo ""
echo "Useful commands:"
echo "  sudo systemctl status sxb-vpn"
echo "  sudo docker-compose -f /var/www/sxb-vpn/docker-compose.yml logs -f"
echo "  sudo /var/www/sxb-vpn/scripts/backup.sh"
echo "========================================="
