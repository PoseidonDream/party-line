#!/usr/bin/env bash
# Saves every account, message and picture to backups/party-line-backup-DATE.tgz and keeps the
# newest 7 (setup.sh runs this every night). Safe while people are chatting: the database is
# copied with SQLite's own snapshot, not mid-write.
#   ./backup.sh            make a backup now
#   ./backup.sh restore FILE   put a backup back (stops Party Line for a moment)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p backups
KEEP="${KEEP:-7}"

if [ "${1:-}" = restore ]; then
  FILE="${2:?Which backup? e.g. ./backup.sh restore backups/party-line-backup-20260101-0417.tgz}"
  docker compose stop partyline
  docker compose run --rm --no-deps -T --user root --entrypoint sh partyline -c \
    'rm -rf /data/* && tar xzf - -C /data && mv /data/snapshot.db /data/party-line.db && chown -R node:node /data' < "$FILE"
  docker compose start partyline
  echo "Restored $FILE"
  exit 0
fi

docker compose exec -T partyline node --disable-warning=ExperimentalWarning -e "
  const { DatabaseSync } = require('node:sqlite');
  require('fs').rmSync('/data/snapshot.db', { force: true });
  new DatabaseSync('/data/party-line.db').exec(\"VACUUM INTO '/data/snapshot.db'\");"
OUT="party-line-backup-$(date +%Y%m%d-%H%M).tgz"
docker compose exec -T partyline tar czf - -C /data snapshot.db uploads > "backups/$OUT"
docker compose exec -T partyline rm -f /data/snapshot.db
ls -1t backups/party-line-backup-*.tgz | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "Saved $PWD/backups/$OUT ($(du -h "backups/$OUT" | cut -f1)). Keeping the newest $KEEP."
