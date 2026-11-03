#!/usr/bin/env bash
# Get the newest Party Line and restart it. Chats, accounts and pictures are kept.
# Also switches on automatic updates (auto-update.sh, every 10 minutes) if they aren't on yet.
set -euo pipefail
main() {
  cd "$(dirname "$0")"
  git pull -q
  GIT_COMMIT="$(git log -1 --format='%h %cs')"   # shown in the developer panel
  export GIT_COMMIT
  docker compose up -d --build
  # Caddy keeps the Caddyfile it started with (git replaces the file, and the container still sees the old one), so
  # when it changed, Caddy restarts: a second's pause for the web page, and updates only run when nobody's in voice.
  if [ "$(docker compose exec -T caddy cat /etc/caddy/Caddyfile 2>/dev/null | sha1sum)" != "$(sha1sum < Caddyfile)" ]; then
    docker compose restart caddy >/dev/null 2>&1 || true
  fi
  git rev-parse HEAD > .built   # this version is running (auto-update.sh retries a version that didn't build)
  docker image prune -f >/dev/null
  if [ ! -f /etc/cron.d/party-line-update ]; then
    echo "*/10 * * * * root $PWD/auto-update.sh >> /var/log/party-line-update.log 2>&1" > /etc/cron.d/party-line-update
    echo "Automatic updates are on: new versions install by themselves when nobody is in voice."
  fi
  echo "Updated."
}
main "$@"
