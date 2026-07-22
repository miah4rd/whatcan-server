#!/bin/bash
set -e

echo "=== What-Can CRM Copilot — Server Setup ==="

# 1. System deps
echo "[1/7] Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq curl git build-essential postgresql postgresql-contrib

# 2. Node.js 22+
echo "[2/7] Installing Node.js..."
if ! command -v node &> /dev/null || [[ $(node -v | cut -d'.' -f1 | tr -d 'v') -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
echo "  Node: $(node -v)"

# 3. pnpm
echo "[3/7] Installing pnpm..."
if ! command -v pnpm &> /dev/null; then
  corepack enable
  corepack prepare pnpm@latest --activate
fi
echo "  pnpm: $(pnpm -v)"

# 4. PostgreSQL
echo "[4/7] Setting up PostgreSQL..."
systemctl enable postgresql
systemctl start postgresql

# Create database and user
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='copilot'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER copilot WITH PASSWORD 'whatcan2026';"

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='whatcan'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE whatcan OWNER copilot;"

sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE whatcan TO copilot;"

echo "  Database: whatcan (user: copilot)"

# 5. Project setup
echo "[5/7] Setting up project..."
cd /opt/whatcan

# Install deps
pnpm install --prod=false

# 6. Build
echo "[6/7] Building..."
pnpm run build

# 7. Create .env if not exists
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "!!! IMPORTANT: Edit /opt/whatcan/.env with your API keys !!!"
  echo "  nano /opt/whatcan/.env"
  echo ""
fi

# 8. PM2
echo "[7/7] Setting up PM2..."
if ! command -v pm2 &> /dev/null; then
  npm install -g pm2
fi

# Start/restart
pm2 delete whatcan 2>/dev/null || true
pm2 start "node --enable-source-maps ./artifacts/api-server/dist/index.mjs" \
  --name whatcan \
  --cwd /opt/whatcan \
  --max-memory-restart 512M \
  --log /var/log/whatcan.log

pm2 save

echo ""
echo "=== DONE ==="
echo "  App running on port 5000"
echo "  Logs: pm2 logs whatcan"
echo "  Status: pm2 status"
echo ""
echo "  Next steps:"
echo "  1. Edit .env: nano /opt/whatcan/.env"
echo "  2. Restart: pm2 restart whatcan"
echo "  3. Configure Traefik to proxy to localhost:5000"
