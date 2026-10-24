#!/usr/bin/env bash
# Keeps Party Line up to date by itself. Runs every 10 minutes (see update.sh, which switches it on).
# When GitHub has a newer version, it updates, but only while nobody is in voice, so calls aren't cut.
# If people stay in voice for 12 hours straight, it updates anyway (everyone reconnects in seconds).
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
  if [ "$waited" -lt 43200 ]; then echo "$(date '+%F %T') new version waiting: $in_voice in voice"; exit 0; fi
fi
rm -f .update-waiting
echo "$(date '+%F %T') updating to $(git log -1 --format='%h %s' '@{u}')"
./update.sh
