#!/bin/bash

# SXB VPN Full-Stack Application Setup & Installer
# Designed for production environments

set -e

# Styling macros
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo -e "${CYAN}${BOLD}=====================================================================${NC}"
echo -e "${CYAN}${BOLD}         🛡️  SXB VPN SaaS Platform Installer & Orchestrator  🛡️        ${NC}"
echo -e "${CYAN}${BOLD}=====================================================================${NC}"
echo -e "Starting system environment probe...\n"

# Step 1: Check System Requirements
echo -e "${YELLOW}[1/4] Verifying platform runtime systems...${NC}"

if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Error: Node.js is not installed. Please install Node.js (v18+) and try again.${NC}"
    exit 1
else
    NODE_VER=$(node -v)
    echo -e "${GREEN}✓ Node.js detected: ${NODE_VER}${NC}"
fi

if ! command -v docker &> /dev/null; then
    echo -e "${YELLOW}⚠️ Warning: Docker command line not found. Docker orchestration will not be available.${NC}"
else
    echo -e "${GREEN}✓ Docker detected${NC}"
fi

if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo -e "${YELLOW}⚠️ Warning: Docker Compose is not installed.${NC}"
else
    echo -e "${GREEN}✓ Docker Compose detected${NC}"
fi

# Step 2: Install Node Dependencies
echo -e "\n${YELLOW}[2/4] Installing platform server and client dependencies...${NC}"
npm install
echo -e "${GREEN}✓ Dependencies successfully synchronized.${NC}"

# Step 3: Setup Configuration Environment
echo -e "\n${YELLOW}[3/4] Initializing secure environment configs...${NC}"
if [ ! -f .env ]; then
    echo -e "Copying default variables from .env.example into .env..."
    cp .env.example .env
    # Generate random cryptographic hashes for JWT secrets to guarantee default absolute security
    JWT_RAND_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    REFRESH_RAND_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    
    # Replace keys securely in local .env
    sed -i.bak "s/JWT_SECRET=\".*\"/JWT_SECRET=\"${JWT_RAND_KEY}\"/g" .env || true
    sed -i.bak "s/REFRESH_SECRET=\".*\"/REFRESH_SECRET=\"${REFRESH_RAND_KEY}\"/g" .env || true
    rm -f .env.bak
    
    echo -e "${GREEN}✓ Configured secure unique JWT secrets inside '.env'.${NC}"
else
    echo -e "${GREEN}✓ '.env' file already exists, skipping overwrite.${NC}"
fi

# Step 4: Run Prisma Database Client Setup
echo -e "\n${YELLOW}[4/4] Executing Prisma schema synthesis...${NC}"
echo -e "Generating local Prisma Client typescript interfaces..."
npx prisma generate

echo -e "\n${GREEN}${BOLD}✓ Installation successfully completed!${NC}"
echo -e "${CYAN}${BOLD}=====================================================================${NC}"
echo -e "${BOLD}To start the service right away, choose an options below:${NC}"
echo -e "  1. Run locally in Development:   ${YELLOW}npm run dev${NC}"
echo -e "  2. Compile and run Production:   ${YELLOW}npm run build && npm run start${NC}"
echo -e "  3. Deploy containerized Cluster:  ${YELLOW}docker-compose up -d --build${NC}"
echo -e "${CYAN}${BOLD}=====================================================================${NC}"
