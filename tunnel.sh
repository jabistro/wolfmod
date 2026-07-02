#!/usr/bin/env bash
#
# tunnel.sh — start Expo with a Cloudflare tunnel (replacement for the dead
# `expo start --tunnel`, whose bundled ngrok v2 agent is permanently blocked
# by ngrok on the free tier). Friends scan the QR / open the printed URL.
#
# Usage:  ./tunnel.sh          (or: npm run tunnel)
# Stop:   Ctrl+C               (also tears down the tunnel)

set -euo pipefail
cd "$(dirname "$0")"

CF_LOG="$(mktemp -t wolfmod_cf.XXXXXX)"

cleanup() {
  echo ""
  echo "Shutting down tunnel..."
  [ -n "${CF_PID:-}" ] && kill "$CF_PID" 2>/dev/null || true
  rm -f "$CF_LOG" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Sweep any stale cloudflared from prior runs that leaked (see note on the
# expo start line below) so we don't pile up dead tunnels / mismatched hosts.
pkill -f "cloudflared tunnel --url http://localhost:8081" 2>/dev/null || true

echo "Starting Cloudflare tunnel -> http://localhost:8081 ..."
cloudflared tunnel --url http://localhost:8081 > "$CF_LOG" 2>&1 &
CF_PID=$!

# Wait (up to ~30s) for the public trycloudflare.com URL to appear.
TUNNEL_URL=""
for _ in $(seq 1 30); do
  TUNNEL_URL=$(grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" "$CF_LOG" | head -1 || true)
  [ -n "$TUNNEL_URL" ] && break
  sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
  echo "ERROR: tunnel URL never appeared. cloudflared log:"
  cat "$CF_LOG"
  exit 1
fi

echo ""
echo "============================================================"
echo "  Tunnel up:  $TUNNEL_URL"
echo "  Share that URL (or the QR below) with your friends."
echo "============================================================"
echo ""

# EXPO_PACKAGER_PROXY_URL makes Metro advertise the tunnel host in its
# manifest, so the bundle + assets load over the tunnel instead of localhost.
# NOTE: do NOT `exec` here — exec replaces this shell, which would discard the
# cleanup trap above and orphan cloudflared on Ctrl+C (that's what piled up
# ~48 zombie tunnels). Running it as a normal child keeps the trap alive so
# the tunnel is torn down when Expo exits.
EXPO_PACKAGER_PROXY_URL="$TUNNEL_URL" npx expo start
