#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Entrypoint for the Claudeflare Code container (IDE mode).
#
# Starts four services:
#   8080 — ttyd: main terminal (plain bash, user launches claude manually)
#   8081 — ttyd: auxiliary shell terminal (plain bash)
#   8082 — Node file-server API (browse /workspace)
#   8083 — Preview proxy (reverse-proxy to user dev servers)
#
# Env vars injected by the ClaudeCodeContainer class:
#   ANTHROPIC_API_KEY      – fake sk-ant- key (passes local validation)
#   ANTHROPIC_BASE_URL     – http://anthropic.proxy (intercepted by outboundByHost)
#   DISABLE_AUTOUPDATER    – "1" to prevent Claude Code self-updating
#   CLAUDE_MODEL           – dynamic/<gateway-id>
# ---------------------------------------------------------------------------
set -uo pipefail

# HTTPS interception uses an ephemeral CA injected by Cloudflare at runtime.
# Build a user-writable bundle so common CLI tools and language runtimes trust
# both the normal public roots and intercepted connections.
CF_CONTAINER_CA=/etc/cloudflare/certs/cloudflare-containers-ca.crt
CF_CA_BUNDLE="$HOME/.cloudflare/ca-bundle.crt"
if [[ ! -r "$CF_CONTAINER_CA" ]]; then
  echo "  [error] Cloudflare Containers interception CA is unavailable" >&2
  exit 1
fi
mkdir -p "$(dirname "$CF_CA_BUNDLE")"
cat /etc/ssl/certs/ca-certificates.crt "$CF_CONTAINER_CA" > "$CF_CA_BUNDLE"
export NODE_EXTRA_CA_CERTS="$CF_CONTAINER_CA"
export SSL_CERT_FILE="$CF_CA_BUNDLE"
export CURL_CA_BUNDLE="$CF_CA_BUNDLE"
export GIT_SSL_CAINFO="$CF_CA_BUNDLE"
export REQUESTS_CA_BUNDLE="$CF_CA_BUNDLE"

# Set up the fake browser so that wrangler, vite, etc. open URLs in the
# IDE preview panel instead of trying to launch a real browser.
export BROWSER=open-in-preview

# Write the API key into Claude Code's credentials store so it treats
# the key as already-accepted (skips the interactive confirmation dialog).
mkdir -p ~/.claude
cat > ~/.claude/.credentials.json <<EOF
{"claudeAiApiKey":"$ANTHROPIC_API_KEY"}
EOF

# Print a hint so users know how to launch claude manually.
cat >> ~/.bashrc <<'BASHRC'
# Route "open browser" calls to the IDE preview panel
export BROWSER=open-in-preview

if [ -z "$CLAUDE_GREETED" ]; then
  export CLAUDE_GREETED=1
  echo ""
  echo "  Type 'claude' to start Claude Code."
  echo ""
fi
BASHRC

echo "==============================="
echo "  Claudeflare Code IDE"
echo "==============================="
echo "  Starting services..."

# --- Start auxiliary terminal (port 8081) ---
ttyd --port 8081 --writable bash -l &
AUX_PID=$!
echo "  [ok] Auxiliary terminal on :8081 (PID $AUX_PID)"

# --- Start file server (port 8082) ---
node /opt/fileserver.js &
FS_PID=$!
echo "  [ok] File server on :8082 (PID $FS_PID)"

# --- Start preview proxy (port 8083) ---
node /opt/preview-proxy.js &
PP_PID=$!
echo "  [ok] Preview proxy on :8083 (PID $PP_PID)"

echo "  [..] Main terminal on :8080 (starting now)"
echo "==============================="

# --- Start main terminal (port 8080, foreground) ---
# exec replaces the shell so ttyd is PID 1 and handles signals.
exec ttyd \
  --port 8080 \
  --writable \
  bash -l
