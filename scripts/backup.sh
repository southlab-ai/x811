#!/bin/bash
# =============================================================================
# x811 Protocol — Daily SQLite Backup
# =============================================================================
#
# Usage: Run via cron on the VPS host:
#   0 3 * * * /opt/x811/backup.sh
#
# Performs a safe hot backup of the SQLite database using sqlite3 .backup
# command (safe even while the server is writing). Retains 7 days of backups.

set -euo pipefail

CONTAINER_NAME="x811-server"
DB_PATH="/data/x811.db"
BACKUP_DIR="/data/backups"
DATE=$(date +%Y-%m-%d)
BACKUP_FILE="${BACKUP_DIR}/x811-${DATE}.db"
RETENTION_DAYS=7

# Ensure backup directory exists inside the container
docker exec "${CONTAINER_NAME}" mkdir -p "${BACKUP_DIR}"

# Perform hot backup using sqlite3 .backup (safe for WAL mode)
docker exec "${CONTAINER_NAME}" sqlite3 "${DB_PATH}" ".backup '${BACKUP_FILE}'"

# Verify backup was created
if docker exec "${CONTAINER_NAME}" test -f "${BACKUP_FILE}"; then
  SIZE=$(docker exec "${CONTAINER_NAME}" stat -c%s "${BACKUP_FILE}" 2>/dev/null || echo "unknown")
  echo "[$(date -Iseconds)] Backup successful: ${BACKUP_FILE} (${SIZE} bytes)"
else
  echo "[$(date -Iseconds)] ERROR: Backup file not created: ${BACKUP_FILE}" >&2
  exit 1
fi

# Cleanup backups older than retention period
docker exec "${CONTAINER_NAME}" find "${BACKUP_DIR}" -name "x811-*.db" -mtime +${RETENTION_DAYS} -delete
echo "[$(date -Iseconds)] Cleanup complete. Removed backups older than ${RETENTION_DAYS} days."
