#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Entrypoint for the Claudeflare Code container.
#
# Pre-stores the API key in Claude Code's credentials so it doesn't show the
# interactive "Detected a custom API key" prompt on startup.
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

exec ttyd \
  --port 8080 \
  --writable \
  claude
