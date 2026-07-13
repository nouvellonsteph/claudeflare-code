#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# open-in-preview — fake "browser" for headless containers.
#
# Tools like wrangler, vite, next dev, etc. honour the BROWSER env var or
# fall back to xdg-open. This script intercepts the URL, extracts the port,
# and tells the preview-proxy (running on :8083) to switch its target port.
#
# The preview panel in the IDE then shows the user's dev server.
#
# Install as both /usr/local/bin/open-in-preview and /usr/local/bin/xdg-open
# so it works regardless of how tools try to open a browser.
# ---------------------------------------------------------------------------

URL="${1:-}"
if [ -z "$URL" ]; then
  echo "[preview] No URL provided." >&2
  exit 1
fi

# Extract port from URL (e.g. http://localhost:8787/ → 8787)
PORT=$(echo "$URL" | sed -n 's|.*://[^:/]*:\([0-9]*\).*|\1|p')

if [ -z "$PORT" ]; then
  # No explicit port — assume 80 for http, 443 for https
  if echo "$URL" | grep -q "^https"; then
    PORT=443
  else
    PORT=80
  fi
fi

# Tell the preview proxy to switch to this port
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://localhost:8083/api/preview/port \
  -H 'Content-Type: application/json' \
  -d "{\"port\": ${PORT}}" 2>/dev/null)

if [ "$RESPONSE" = "200" ]; then
  echo "[preview] Opened ${URL} → preview panel now showing port ${PORT}"
else
  echo "[preview] Could not update preview proxy (HTTP ${RESPONSE})." >&2
  echo "[preview] Visit manually: ${URL}" >&2
fi
