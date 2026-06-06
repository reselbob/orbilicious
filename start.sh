#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

NO_OPEN_BROWSER=false
WEB_PORT_OVERRIDE=""
DOCS_PORT=9000
APP_ARGS=()

log() {
  printf "\n[orbilicious-start] %s\n" "$1"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1
}

install_node() {
  if require_cmd node && require_cmd npm; then
    log "Node and npm already installed: node $(node -v), npm $(npm -v)"
    return
  fi

  log "Node.js/npm not found. Attempting installation..."

  if require_cmd apt-get; then
    if ! require_cmd curl; then
      log "Installing curl (required for NodeSource setup)"
      sudo apt-get update
      sudo apt-get install -y curl ca-certificates
    fi

    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif require_cmd dnf; then
    sudo dnf install -y nodejs npm
  elif require_cmd yum; then
    sudo yum install -y nodejs npm
  elif require_cmd pacman; then
    sudo pacman -Sy --noconfirm nodejs npm
  elif require_cmd zypper; then
    sudo zypper install -y nodejs npm
  else
    cat <<'EOF'
Unable to auto-install Node.js: unsupported package manager.
Please install Node.js LTS manually, then rerun ./start.sh.
EOF
    exit 1
  fi

  if ! require_cmd node || ! require_cmd npm; then
    log "Node.js installation did not succeed. Please install manually and retry."
    exit 1
  fi

  log "Installed Node $(node -v) and npm $(npm -v)"
}

install_dependencies() {
  log "Installing ORBilicious dependencies"
  npm install --legacy-peer-deps
}

install_gatsby_dependencies() {
  if [ -d "docs-site/node_modules" ]; then
    log "Gatsby dependencies already present"
    return
  fi
  log "Installing Gatsby documentation site dependencies"
  (cd docs-site && npm install --legacy-peer-deps)
}

build_gatsby_site() {
  log "Building Gatsby documentation site"
  (cd docs-site && npm run build)
}

run_project() {
  local web_port="${WEB_PORT_OVERRIDE:-${WEB_PORT:-8787}}"
  local web_url="http://localhost:${web_port}"
  local docs_url="http://localhost:${DOCS_PORT}"
  local web_pid
  local docs_pid

  # Kill any process still holding the web port from a prior session
  local old_pid
  old_pid="$(lsof -ti "tcp:${web_port}" 2>/dev/null || true)"
  if [[ -n "${old_pid}" ]]; then
    log "Killing existing process ${old_pid} on port ${web_port}"
    kill "${old_pid}" 2>/dev/null || true
    sleep 1
  fi

  old_pid="$(lsof -ti "tcp:${DOCS_PORT}" 2>/dev/null || true)"
  if [[ -n "${old_pid}" ]]; then
    log "Killing existing process ${old_pid} on port ${DOCS_PORT}"
    kill "${old_pid}" 2>/dev/null || true
    sleep 1
  fi

  cleanup() {
    local code=$?

    if [[ -n "${web_pid:-}" ]] && kill -0 "$web_pid" >/dev/null 2>&1; then
      kill "$web_pid" >/dev/null 2>&1 || true
    fi
    if [[ -n "${docs_pid:-}" ]] && kill -0 "$docs_pid" >/dev/null 2>&1; then
      kill "$docs_pid" >/dev/null 2>&1 || true
    fi

    wait >/dev/null 2>&1 || true
    exit "$code"
  }

  trap cleanup INT TERM EXIT

  log "Starting Gatsby documentation site on port ${DOCS_PORT}"
  (cd docs-site && npx gatsby serve --port "$DOCS_PORT") &
  docs_pid=$!

  log "Starting ORBilicious web UI on port ${web_port}"
  WEB_PORT="$web_port" npx tsx src/web/server.ts &
  web_pid=$!

  box() { printf "║  %-60s ║\n" "$1"; }
  sep() { printf "║  %-60s ║\n" ""; }
  top() { printf "╔"; for i in $(seq 63); do printf "═"; done; printf "╗\n"; }
  bot() { printf "╚"; for i in $(seq 63); do printf "═"; done; printf "╝\n"; }

  echo ""
  top
  sep
  box "ORBilicious is running"
  sep
  box "Web UI:           ${web_url}"
  box "Documentation:    ${docs_url}"
  sep
  box "Click the Start ORBilicious button in the web UI to get"
  box "Most Active Stocks, discover Breakout Candidates, and"
  box "conduct trading according to the Opening Range Breakout"
  box "(ORB) strategy."
  sep
  box "Press Ctrl+C to stop all services"
  bot
  echo ""

  if [[ "$NO_OPEN_BROWSER" == "true" ]]; then
    log "Browser auto-open disabled (--no-open)."
  elif require_cmd xdg-open; then
    log "Opening web UI: ${web_url}"
    xdg-open "$web_url" >/dev/null 2>&1 || true
  fi

  wait "$web_pid"
}

parse_args() {
  while (($#)); do
    case "$1" in
      --no-open|-n)
        NO_OPEN_BROWSER=true
        ;;
      --web-port)
        shift
        if (($# == 0)); then
          log "Missing value for --web-port"
          exit 1
        fi
        WEB_PORT_OVERRIDE="$1"
        ;;
      --web-port=*)
        WEB_PORT_OVERRIDE="${1#*=}"
        ;;
      -p)
        shift
        if (($# == 0)); then
          log "Missing value for -p"
          exit 1
        fi
        WEB_PORT_OVERRIDE="$1"
        ;;
      --help|-h)
        cat <<'EOF'
Usage: ./start.sh [--no-open|-n] [--web-port|-p PORT] [--help|-h] [app args...]

Options:
  --no-open, -n  Do not open the web UI in a browser automatically.
  --web-port, -p Web server port (default: WEB_PORT env var or 8787).
  --help, -h     Show this help message.

Any remaining arguments are ignored by start.sh.
EOF
        exit 0
        ;;
      *)
        APP_ARGS+=("$1")
        ;;
    esac
    shift
  done

  if ((${#APP_ARGS[@]} > 0)); then
    log "Ignoring app arguments: ${APP_ARGS[*]}"
    log "Start the app from the web UI to keep monitor events connected"
  fi
}

main() {
  parse_args "$@"
  install_node
  install_dependencies
  install_gatsby_dependencies
  build_gatsby_site
  run_project
}

main "$@"
