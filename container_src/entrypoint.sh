#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Entrypoint for the Claudeflare Code container (IDE mode).
#
# Starts four services:
#   8080 — ttyd: Claude Code main terminal (auto-launches claude)
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

# Write the API key into Claude Code's credentials store so it treats
# the key as already-accepted (skips the interactive confirmation dialog).
mkdir -p ~/.claude
cat > ~/.claude/.credentials.json <<EOF
{"claudeAiApiKey":"$ANTHROPIC_API_KEY"}
EOF

# Auto-launch claude on first shell, but let the user return to bash if it exits.
cat >> ~/.bashrc <<'BASHRC'
if [ -z "$CLAUDE_LAUNCHED" ]; then
  export CLAUDE_LAUNCHED=1
  claude
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
