#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Entrypoint for the Claudeflare Code container.
#
# Uses tmux to keep the session alive even if Claude Code exits or the
# WebSocket disconnects. ttyd attaches to the tmux session, so:
#   - If Claude Code exits, the user is still in a shell and can restart
#   - If the browser disconnects/reconnects, it re-attaches to the same session
#   - The container stays alive as long as ttyd is running (not tied to claude)
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

# Start a detached tmux session. Use default size — it will resize to fit
# the first client that attaches. set-option aggressive-resize ensures tmux
# resizes to the smallest *attached* client (i.e. the ttyd window).
tmux new-session -d -s main 'claude; exec bash -l'
tmux set-option -t main aggressive-resize on

# ttyd attaches to the tmux session. If the browser disconnects, the tmux
# session keeps running. Reconnecting re-attaches to the same session.
exec ttyd \
  --port 8080 \
  --writable \
  tmux attach-session -t main
