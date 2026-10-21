#!/usr/bin/env bash
# Save every account, message and picture to party-line-backup-DATE.tgz in this folder.
set -euo pipefail
cd "$(dirname "$0")"
VOL=$(docker volume ls -q | grep 'partyline-data$' | head -1)
OUT="party-line-backup-$(date +%Y%m%d-%H%M).tgz"
docker run --rm -v "$VOL":/data:ro -v "$PWD":/backup alpine tar czf "/backup/$OUT" -C /data .
echo "Saved $PWD/$OUT"
