#!/usr/bin/env bash
# Keeps Party Line up to date by itself. Runs every 10 minutes (see update.sh, which switches it on).
# When GitHub has a newer version, it updates, but only while nobody is in voice, so calls aren't cut.
# If someone stays in voice for 2 hours straight (often a forgotten open tab), it updates anyway; people reconnect in seconds.
# To turn it off: add AUTO_UPDATE=0 to .env in this folder.
set -uo pipefail
cd "$(dirname "$0")"
exec 9>/tmp/party-line-auto-update.lock
flock -n 9 || exit 0
grep -qx 'AUTO_UPDATE=0' .env 2>/dev/null && exit 0

git fetch -q origin || exit 0
if [ "$(git rev-parse HEAD)" = "$(git rev-parse '@{u}')" ]; then rm -f .update-waiting; exit 0; fi

in_voice=$(docker compose exec -T partyline node -e "fetch('http://127.0.0.1:3000/api/local/voice-count').then((r) => r.json()).then((j) => console.log(j.inVoice)).catch(() => console.log(0))" 2>/dev/null | tr -dc '0-9')
if [ "${in_voice:-0}" -gt 0 ]; then
  [ -f .update-waiting ] || date +%s > .update-waiting
  waited=$(( $(date +%s) - $(cat .update-waiting) ))
  if [ "$waited" -lt 7200 ]; then echo "$(date '+%F %T') new version waiting: $in_voice in voice"; exit 0; fi
fi
rm -f .update-waiting
target=$(git log -1 --format='%h %s' '@{u}')
echo "$(date '+%F %T') updating to $target"
# Tell the server how it went, so Party Bot can warn the admins if an update fails (the old version keeps running).
report() { printf '%s' "$1" | docker compose exec -T partyline sh -c 'cat > /data/update-status.json' 2>/dev/null || true; }
if out=$(./update.sh 2>&1); then
  echo "$out"
  report "{\"ok\":true,\"at\":$(date +%s)}"
else
  echo "$out"
  err=$(echo "$out" | tail -n 3 | tr '\000-\037' ' ' | tr -d '"\\' | cut -c1-300)   # plain text only: it goes into JSON
  report "{\"ok\":false,\"at\":$(date +%s),\"version\":\"$(echo "$target" | tr -d '"\\' | cut -c1-80)\",\"error\":\"$err\"}"
fi
