#!/bin/sh
set -eu

media_dir="${MEDIA_DIR:-/data/media}"
mkdir -p "$media_dir"
chown crm:crm "$media_dir"

exec gosu crm sh -c 'npm run db:migrate && exec npm start'
