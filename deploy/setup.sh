#!/usr/bin/env bash
# Party Line one-time setup for a fresh Ubuntu server (22.04 or 24.04). Run as root:
#   curl -fsSL https://raw.githubusercontent.com/PoseidonDream/party-line/app/deploy/setup.sh | bash
set -euo pipefail
BRANCH="${BRANCH:-app}"
DIR=/opt/party-line

if [ "$(id -u)" != 0 ]; then echo "Run this as root (or with sudo)."; exit 1; fi
echo "== Installing Docker, git and the firewall =="
apt-get update -qq
apt-get install -y -qq ca-certificates curl git ufw openssl >/dev/null
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh

echo "== Opening the ports Party Line needs =="
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
ufw allow 3478 >/dev/null; ufw allow 49160:49200/udp >/dev/null
ufw allow 7881/tcp >/dev/null; ufw allow 7882/udp >/dev/null   # media server, only used if you turn it on
ufw --force enable >/dev/null

echo "== Getting Party Line =="
if [ -d "$DIR/.git" ]; then git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" checkout -q "$BRANCH" && git -C "$DIR" pull -q; else git clone -q -b "$BRANCH" https://github.com/PoseidonDream/party-line "$DIR"; fi
cd "$DIR/deploy"

if [ ! -f .env ]; then
  IP=$(curl -4 -fsS https://api.ipify.org || true)
  exec 3</dev/tty
  read -r -u 3 -p "Your server's address (e.g. mygroup.duckdns.org): " DOMAIN
  read -r -u 3 -p "Group password friends need to sign up: " GROUP_PASSWORD
  read -r -u 3 -p "Admin account name [Poseidon]: " ADMIN_NAMES
  read -r -u 3 -p "Public IP [$IP]: " PUBLIC_IP
  cat > .env <<ENV
DOMAIN=${DOMAIN#https://}
PUBLIC_IP=${PUBLIC_IP:-$IP}
GROUP_PASSWORD=$GROUP_PASSWORD
ADMIN_NAMES=${ADMIN_NAMES:-Poseidon}
TURN_SECRET=$(openssl rand -hex 32)
LIVEKIT_KEY=PL$(openssl rand -hex 6)
LIVEKIT_SECRET=$(openssl rand -hex 32)
ENV
  chmod 600 .env
fi

echo "== Starting Party Line (the first build takes a few minutes) =="
GIT_COMMIT="$(git log -1 --format='%h %cs')" docker compose up -d --build

echo "== Nightly backups at 4:17 (keeps the last 7) =="
cat > /etc/cron.d/party-line-backup <<CRON
17 4 * * * root $DIR/deploy/backup.sh >> /var/log/party-line-backup.log 2>&1
CRON
echo "== Automatic updates (every 10 minutes, only while nobody is in voice) =="
echo "*/10 * * * * root $DIR/deploy/auto-update.sh >> /var/log/party-line-update.log 2>&1" > /etc/cron.d/party-line-update
. ./.env
echo
echo "Done! Open https://$DOMAIN in a minute or two."
echo "First, create the account named ${ADMIN_NAMES%%,*} so nobody else takes the admin name."
