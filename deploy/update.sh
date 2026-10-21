#!/usr/bin/env bash
# Get the newest Party Line and restart it. Chats, accounts and pictures are kept.
set -euo pipefail
cd "$(dirname "$0")"
git pull -q
docker compose up -d --build
docker image prune -f >/dev/null
echo "Updated."
