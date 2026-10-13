#!/bin/sh
# Boot an isolated DSH web profile with this checkout linked in, for development.
# Uses the runtime inside the Desktop app, run as Node; never touches ~/.dsh.
#   DSH_APP   Desktop app bundle (default: /Applications/DSH NEXT.app)
#   DSH_HOME  scratch harness home (default: /tmp/dcm-home)
#   PORT      web port (default: 3099)
set -e
APP="${DSH_APP:-/Applications/DSH NEXT.app}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
export ELECTRON_RUN_AS_NODE=1
export DSH_HOME="${DSH_HOME:-/tmp/dcm-home}"
NODE="$APP/Contents/MacOS/DSH NEXT"
DSH="$APP/Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js"

if [ ! -f "$DSH_HOME/profiles/mcpdev/package.json" ]; then
  "$NODE" "$DSH" --profile mcpdev --from-default-profile web --dump-config >/dev/null
fi
if ! grep -q '"dsh-custom-mcp"' "$DSH_HOME/profiles/mcpdev/package.json"; then
  "$NODE" "$DSH" plugin --profile mcpdev add "$HERE"
fi
exec "$NODE" "$DSH" --profile mcpdev --no-open --port "${PORT:-3099}" "$@"
