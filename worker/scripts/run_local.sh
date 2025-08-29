#!/usr/bin/env bash
set -euo pipefail

# Helper script to run the worker locally without committing secrets.
# Behavior:
# - Uses BLOB_READ_WRITE_TOKEN from the environment if present
# - Otherwise, if a keychain item named "clipcatalyst_blob_rw" exists, loads it
# - Installs dependencies and starts the worker in the background

if [[ -z "${BLOB_READ_WRITE_TOKEN:-}" ]]; then
  if command -v security >/dev/null 2>&1; then
    if security find-generic-password -a "$USER" -s clipcatalyst_blob_rw -w >/dev/null 2>&1; then
      export BLOB_READ_WRITE_TOKEN="$(security find-generic-password -a "$USER" -s clipcatalyst_blob_rw -w 2>/dev/null || true)"
    fi
  fi
fi

mkdir -p logs

# Install deps if needed
if [[ ! -d node_modules ]]; then
  echo "Installing dependencies..."
  npm install --omit=dev --no-audit --no-fund
fi

# Start the worker in background
echo "Starting worker..."
nohup node server.js > logs/worker.out 2>&1 &
PID=$!

echo $PID > logs/worker.pid
sleep 1

# Show diagnostics
if command -v curl >/dev/null 2>&1; then
  echo "--- /diag ---"
  curl -s http://localhost:8080/diag || true
  echo
  echo "If \"hasBlob\": false, export BLOB_READ_WRITE_TOKEN in your shell and re-run this script."
fi

echo "Worker started (PID: $PID). Logs: logs/worker.out"

