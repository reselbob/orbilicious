#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

NO_OPEN_BROWSER=false
WEB_PORT_OVERRIDE=""
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

install_typescript() {
  if [ -x "./node_modules/.bin/tsc" ]; then
    log "Project TypeScript compiler already present"
    return
  fi

  log "Ensuring TypeScript is available in the project"
  npm install --save-dev typescript
}

install_dependencies() {
  log "Installing project dependencies"
  npm install
}

compile_project() {
  log "Compiling TypeScript project"
  npx tsc -p tsconfig.json
}

run_project() {
  local web_port="${WEB_PORT_OVERRIDE:-${WEB_PORT:-8787}}"
  local entry_url="http://localhost:${web_port}"
  local web_pid

  # Kill any process still holding the web port from a prior session
  local old_pid
  old_pid="$(lsof -ti "tcp:${web_port}" 2>/dev/null || true)"
  if [[ -n "${old_pid}" ]]; then
    log "Killing existing process ${old_pid} on port ${web_port}"
    kill "${old_pid}" 2>/dev/null || true
    sleep 1
  fi

  cleanup() {
    local code=$?

    if [[ -n "${web_pid:-}" ]] && kill -0 "$web_pid" >/dev/null 2>&1; then
      kill "$web_pid" >/dev/null 2>&1 || true
    fi

    wait >/dev/null 2>&1 || true
    exit "$code"
  }

  trap cleanup INT TERM EXIT

  log "Starting compiled web server on port ${web_port}"
  WEB_PORT="$web_port" npm run start:web &
  web_pid=$!

  if [[ "$NO_OPEN_BROWSER" == "true" ]]; then
    log "Browser auto-open disabled (--no-open). Entry page: ${entry_url}"
  elif require_cmd xdg-open; then
    log "Opening entry page: ${entry_url}"
    xdg-open "$entry_url" >/dev/null 2>&1 || true
  else
    log "Open this URL in your browser: ${entry_url}"
  fi

  log "Web server PID ${web_pid}"
  log "Use the web UI Start button to launch ORBilicious so Trade Monitor stays in sync"
  log "Press Ctrl+C to stop the web server"

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
  install_typescript
  compile_project
  run_project "${APP_ARGS[@]}"
}

main "$@"
