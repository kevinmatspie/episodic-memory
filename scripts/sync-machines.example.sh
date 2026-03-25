#!/bin/bash
# Example: Sync episodic memory archives between two machines, then index.
# Copy this file, customize the variables below, and add to cron:
#   */15 * * * * /path/to/sync-machines.sh >> /tmp/episodic-memory-sync.log 2>&1

set -euo pipefail

# --- Customize these ---
MACHINE_A="machine-a.example.com"    # Hostname of first machine
MACHINE_B="machine-b.example.com"    # Hostname of second machine
REPO_DIR="$HOME/repos/episodic-memory"  # Path to episodic-memory clone
# -----------------------

ARCHIVE_DIR="$HOME/.config/superpowers/conversation-archive"
NODE="$(which node)"
HOSTNAME="$(hostname -s)"

# Determine the other machine based on hostname prefix
if [[ "$HOSTNAME" == "${MACHINE_A%%.*}"* ]]; then
  REMOTE="$MACHINE_B"
elif [[ "$HOSTNAME" == "${MACHINE_B%%.*}"* ]]; then
  REMOTE="$MACHINE_A"
else
  echo "$(date): Unknown host $HOSTNAME, skipping rsync"
  REMOTE=""
fi

# Pull from remote (merge their conversations into ours)
if [[ -n "$REMOTE" ]]; then
  echo "$(date): Pulling archive from $REMOTE..."
  rsync -az --ignore-existing "$REMOTE:$ARCHIVE_DIR/" "$ARCHIVE_DIR/" 2>/dev/null || \
    echo "$(date): Could not reach $REMOTE (offline or VPN not connected)"
fi

# Index everything (including any files just pulled)
echo "$(date): Running episodic-memory sync..."
"$NODE" "$REPO_DIR/cli/episodic-memory.js" sync --no-summary-limit

echo "$(date): Done."
