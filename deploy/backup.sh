#!/usr/bin/env bash
# Saves every account, message and picture to backups/party-line-backup-DATE.tgz and keeps the
# newest 7 (setup.sh runs this every night). Safe while people are chatting: the database is
# copied with SQLite's own snapshot, not mid-write.
#   ./backup.sh            make a backup now
#   ./backup.sh restore FILE   put a backup back (stops Party Line for a moment)
set -euo pipefail
cd "$(dirname "$0")"
umask 077   # backups hold every account and message: only this server's admin user can read them
mkdir -p backups && chmod 700 backups
KEEP="${KEEP:-7}"

if [ "${1:-}" = restore ]; then
  FILE="${2:?Which backup? e.g. ./backup.sh restore backups/party-line-backup-20260101-0417.tgz}"
  gzip -t "$FILE" || { echo "That backup file is damaged (it doesn't unpack). Nothing was changed."; exit 1; }
  docker compose stop partyline
  # Unpacked into a side folder and checked first: only a complete backup replaces what's there. The server's keys
  # (notifications, link previews) are kept when the backup is older and doesn't carry them.
  if docker compose run --rm --no-deps -T --user root --entrypoint sh partyline -c '
      set -e; rm -rf /data/.restore; mkdir /data/.restore
      tar xzf - -C /data/.restore
      test -s /data/.restore/snapshot.db
      rm -rf /data/uploads /data/party-line.db /data/party-line.db-wal /data/party-line.db-shm
      mv /data/.restore/snapshot.db /data/party-line.db
      for f in /data/.restore/*; do rm -rf "/data/$(basename "$f")"; mv "$f" /data/; done
      rmdir /data/.restore; chown -R node:node /data' < "$FILE"; then
    docker compose start partyline
    echo "Restored $FILE"
    exit 0
  fi
  docker compose start partyline
  echo "That backup couldn't be restored (incomplete?). Party Line is running with what it had before."
  exit 1
fi

docker compose exec -T partyline node --disable-warning=ExperimentalWarning -e "
  const { DatabaseSync } = require('node:sqlite');
  require('fs').rmSync('/data/snapshot.db', { force: true });
  new DatabaseSync('/data/party-line.db').exec(\"VACUUM INTO '/data/snapshot.db'\");"
OUT="party-line-backup-$(date +%Y%m%d-%H%M).tgz"
# with the server's keys, so notifications and link pictures keep working after a restore (or on a new server)
docker compose exec -T partyline sh -c 'cd /data && tar czf - snapshot.db uploads $(ls vapid.json preview-key 2>/dev/null)' > "backups/$OUT"
docker compose exec -T partyline rm -f /data/snapshot.db
ls -1t backups/party-line-backup-*.tgz | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "Saved $PWD/backups/$OUT ($(du -h "backups/$OUT" | cut -f1)). Keeping the newest $KEEP."

# Off-server copy (optional): set BACKUP_REMOTE in .env, e.g. Backblaze B2 (see DEPLOY.md). Uses rclone in
# Docker, so nothing extra is installed. Copies older than BACKUP_REMOTE_DAYS (default 30) are deleted there.
# Only the BACKUP_ settings are read from .env (it isn't run as a script: a value with spaces, like a Gmail app
# password, would stop it).
if [ -f .env ]; then
  while IFS= read -r line; do
    case "$line" in BACKUP_*=*) k=${line%%=*}; v=${line#*=}; v=${v%\"}; v=${v#\"}; v=${v%\'}; v=${v#\'}; export "$k=$v";; esac
  done < .env
fi
OFFSITE="" OFFSITE_ERR=""
if [ -n "${BACKUP_REMOTE:-}" ]; then
  RC=(docker run --rm -v "$PWD/backups:/backups:ro" -e RCLONE_CONFIG_OFFSITE_TYPE="${BACKUP_TYPE:-b2}"
      -e RCLONE_CONFIG_OFFSITE_ACCOUNT="${BACKUP_ACCOUNT:-}" -e RCLONE_CONFIG_OFFSITE_KEY="${BACKUP_KEY:-}"
      -e RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID="${BACKUP_ACCOUNT:-}" -e RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY="${BACKUP_KEY:-}"
      -e RCLONE_CONFIG_OFFSITE_PROVIDER="${BACKUP_PROVIDER:-Other}" -e RCLONE_CONFIG_OFFSITE_ENDPOINT="${BACKUP_ENDPOINT:-}"
      -e RCLONE_B2_HARD_DELETE=true   # on B2 a plain delete only hides the file, which keeps using (and billing) space
      rclone/rclone:1.68.2)
  if ERR=$("${RC[@]}" copy "/backups/$OUT" "offsite:$BACKUP_REMOTE" 2>&1); then
    OFFSITE="$BACKUP_REMOTE"
    "${RC[@]}" delete --min-age "${BACKUP_REMOTE_DAYS:-30}d" --include 'party-line-backup-*.tgz' "offsite:$BACKUP_REMOTE" >/dev/null 2>&1 || true
    echo "Copied off the server to $BACKUP_REMOTE."
  else
    OFFSITE_ERR=$(echo "$ERR" | tail -n 1 | tr -d '"\\' | cut -c1-200)
    echo "Copying off the server FAILED: $ERR"
  fi
fi

# Tell the developer panel how it went.
STATUS="{\"at\":$(date +%s),\"file\":\"$OUT\",\"bytes\":$(stat -c %s "backups/$OUT"),\"offsite\":\"$OFFSITE\",\"offsiteError\":\"$OFFSITE_ERR\"}"
echo "$STATUS" | docker compose exec -T partyline sh -c 'cat > /data/backup-status.json' || true
[ -z "$OFFSITE_ERR" ]
