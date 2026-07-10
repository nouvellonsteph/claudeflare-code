#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Entrypoint for the Claudeflare Code container.
#
# Launches ttyd with bash. Claude Code starts automatically via .bashrc.
# If Claude Code exits, the user stays in bash and can type `claude` again.
# The container stays alive as long as ttyd is running (not tied to claude).
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

# Start the exec helper server in the background (used by IDE file explorer)
node /usr/local/bin/exec-server.mjs &

exec ttyd \
  --port 8080 \
  --writable \
  bash -l
