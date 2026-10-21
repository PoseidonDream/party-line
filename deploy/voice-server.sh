#!/usr/bin/env bash
# Turns the media server for big voice channels on or off.
#   ./voice-server.sh on     voice goes through your server (best for channels with 10+ people)
#   ./voice-server.sh off    voice goes directly between people (the default; uses almost no server bandwidth)
set -euo pipefail
cd "$(dirname "$0")"
set_env() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi; }
. ./.env
if [ -z "${LIVEKIT_SECRET:-}" ]; then set_env LIVEKIT_KEY "PL$(openssl rand -hex 6)"; set_env LIVEKIT_SECRET "$(openssl rand -hex 32)"; fi
case "${1:-}" in
  on)
    set_env COMPOSE_PROFILES sfu
    set_env LIVEKIT_URL "wss://$DOMAIN"
    ufw allow 7881/tcp >/dev/null 2>&1 || true; ufw allow 7882/udp >/dev/null 2>&1 || true
    docker compose up -d
    echo "Media server is on. People in voice reconnect through it automatically."
    echo "If your provider has its own firewall, open TCP 7881 and UDP 7882 there too." ;;
  off)
    set_env COMPOSE_PROFILES ""
    set_env LIVEKIT_URL ""
    docker compose up -d --remove-orphans
    docker compose rm -sf livekit >/dev/null 2>&1 || true
    echo "Media server is off. Voice goes directly between people again." ;;
  *) echo "Usage: $0 on|off"; exit 1 ;;
esac
