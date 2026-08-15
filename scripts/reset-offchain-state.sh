#!/usr/bin/env bash
set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" != "--yes" ]]; then
  cat <<USAGE
This resets Solchan V2 off-chain development state.

It will:
  - stop the PostgreSQL Docker service
  - remove the PostgreSQL Docker volume
  - remove backend local storage files

Usage:
  $0 --yes
USAGE
  exit 1
fi

docker-compose -f "$BACKEND_DIR/docker-compose.yml" down -v
rm -rf "$BACKEND_DIR/storage"
mkdir -p "$BACKEND_DIR/storage/tmp"

echo "Solchan V2 off-chain state reset complete."
