#!/bin/bash
# SXB VPN Installation Script
# This script installs all dependencies and prepares the VPS for deployment

set -e

echo "========================================="
echo "SXB VPN Installation Script"
echo "========================================="

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Functions
log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    log_error "Please run as root (use sudo)"
    exit 1
fi

# Update system
log_warning "Updating system packages..."
apt-get update -qq

# Install essential packages
log_warning "Installing essential packages..."
apt-get install -y -qq curl wget git unzip ca-certificates gnupg

# Install Docker if not present
if ! command -v docker &> /dev/null; then
    log_warning "Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
    log_success "Docker installed"
else
    log_success "Docker already installed"
fi

# Install Docker Compose if not present
if ! command -v docker-compose &> /dev/null; then
    log_warning "Installing Docker Compose..."
    curl -L "https://github.com/docker/compose/releases/download/v2.24.0/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
    log_success "Docker Compose installed"
else
    log_success "Docker Compose already installed"
fi

# Install Node.js 22 if not present
if ! command -v node &> /dev/null || [[ $(node -v) < "v22" ]]; then
    log_warning "Installing Node.js 22..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y -qq nodejs
    log_success "Node.js installed"
else
    log_success "Node.js already installed: $(node -v)"
fi

# Install PostgreSQL 16 if not present
if ! command -v psql &> /dev/null; then
    log_warning "Installing PostgreSQL 16..."
    apt-get install -y -qq postgresql-16 postgresql-client-16
    systemctl enable postgresql
    systemctl start postgresql
    log_success "PostgreSQL installed"
else
    log_success "PostgreSQL already installed"
fi

# Install Redis if not present
if ! command -v redis-server &> /dev/null; then
    log_warning "Installing Redis..."
    apt-get install -y -qq redis-server
    systemctl enable redis-server
    systemctl start redis-server
    log_success "Redis installed"
else
    log_success "Redis already installed"
fi

# Install Nginx if not present
if ! command -v nginx &> /dev/null; then
    log_warning "Installing Nginx..."
    apt-get install -y -qq nginx
    systemctl enable nginx
    systemctl start nginx
    log_success "Nginx installed"
else
    log_success "Nginx already installed"
fi

# Install Certbot for SSL
if ! command -v certbot &> /dev/null; then
    log_warning "Installing Certbot..."
    apt-get install -y -qq certbot python3-certbot-nginx
    log_success "Certbot installed"
else
    log_success "Certbot already installed"
fi

# Configure firewall
log_warning "Configuring firewall..."
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3000/tcp
ufw allow 4000/tcp
ufw --force enable

# Create application directory
log_warning "Creating application directories..."
mkdir -p /var/www/sxb-vpn
mkdir -p /opt/sxb/backups
mkdir -p /opt/sxb/logs

# Set permissions
chown -R www-data:www-data /var/www/sxb-vpn
chown -R ubuntu:ubuntu /opt/sxb

log_success "Installation complete!"
echo ""
echo "========================================="
echo "Next steps:"
echo "1. Clone the repository: git clone <repo-url> /var/www/sxb-vpn"
echo "2. Copy .env.example to .env and configure"
echo "3. Run: ./scripts/deploy.sh"
echo "========================================="

# Prompt for SUPER ADMIN setup
echo ""
echo "========================================="
echo "SUPER ADMIN SETUP"
echo "========================================="
read -p "Do you want to create a SUPER ADMIN account now? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    read -p "Enter SUPER ADMIN email: " SUPER_ADMIN_EMAIL
    read -p "Enter SUPER ADMIN password: " -s SUPER_ADMIN_PASSWORD
    echo
    
    export SUPER_ADMIN_EMAIL
    export SUPER_ADMIN_PASSWORD
    export SUPER_ADMIN_NAME="Super Administrator"
    
    cd /var/www/sxb-vpn
    npx tsx scripts/setup-super-admin.js
fi
