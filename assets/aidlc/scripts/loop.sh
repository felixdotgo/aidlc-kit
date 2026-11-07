#!/bin/sh
# AI-DLC loop launcher (managed by aidlc-kit; upgrades overwrite local edits).
#
#   .agents/aidlc/scripts/loop.sh [command] [options]
#
# Edit .agents/config.json ("loop") and .agents/loop.env, then run `loop.sh up`.
# The script only locates the aidlc-kit CLI and forwards to `aidlc-kit loop <command>`;
# it never installs or upgrades anything.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)

usage() {
  cat <<'EOF'
Usage: .agents/aidlc/scripts/loop.sh [command] [options]

Commands:
  up       check the environment, start the loop daemon, and serve the dashboard (default)
           options: --loop-env PATH  --port 4173  --host 127.0.0.1  --open  --no-ui
  down     stop the dashboard started by `up` and the loop daemon (--now cancels the running turn)
  stop     stop only the loop daemon (--now cancels the running turn)
  status   daemon, dashboard, and environment at a glance (--json)
  check    show providers, the env file, and every variable the loop needs (--json)
  logs     follow the daemon log
  help     show this help

Configure:
  .agents/config.json   "loop": { "mode": "local", "agents": { "lead": "<provider>", "workers": { "worker-a": "<provider>" } } }
  .agents/loop.env      model and API keys (git-ignored); values your tools already store are detected
EOF
}

command -v node >/dev/null 2>&1 || { echo "loop.sh: Node.js 20.17 or newer is required (https://nodejs.org)" >&2; exit 1; }

# The installed workflow version, so hints name the matching package.
VERSION=$(node -p 'require(process.argv[1]).packageVersion' "$ROOT/.agents/aidlc/manifest.json" 2>/dev/null || echo latest)
INSTALL_HINT="npm install --save-dev @felixdotgo/aidlc-kit@$VERSION"

run_cli() {
  if [ -x "$ROOT/node_modules/.bin/aidlc-kit" ]; then exec "$ROOT/node_modules/.bin/aidlc-kit" "$@"; fi
  if command -v aidlc-kit >/dev/null 2>&1; then exec aidlc-kit "$@"; fi
  if command -v npx >/dev/null 2>&1; then
    echo "loop.sh: aidlc-kit is not installed in this project; trying npx --no-install (if it fails: $INSTALL_HINT)" >&2
    exec npx --no-install @felixdotgo/aidlc-kit "$@"
  fi
  echo "loop.sh: the aidlc-kit CLI was not found. Install it in this project: $INSTALL_HINT" >&2
  exit 1
}

# Options without a command run the default command: `loop.sh --open` = `loop.sh up --open`.
case "${1:-up}" in
  -h|--help) cmd=help; shift ;;
  -*) cmd=up ;;
  *) cmd=${1:-up}; [ $# -gt 0 ] && shift ;;
esac

case "$cmd" in
  up|down|stop|status) run_cli loop "$cmd" --root "$ROOT" "$@" ;;
  check|env) run_cli loop env --root "$ROOT" "$@" ;;
  logs)
    log="$ROOT/.agents/data/loop/daemon.log"
    if [ ! -f "$log" ]; then echo "No daemon log yet: $log"; exit 0; fi
    exec tail -n 200 -f "$log"
    ;;
  help|-h|--help) usage ;;
  *) echo "loop.sh: unknown command: $cmd" >&2; usage >&2; exit 2 ;;
esac
