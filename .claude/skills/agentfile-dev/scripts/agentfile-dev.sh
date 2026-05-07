#!/usr/bin/env bash
set -euo pipefail

DEFAULT_REPO_URL="https://github.com/Ceeon/agentfile.git"
ACTION="${1:-status}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EMBEDDED_REPO="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

is_agentfile_repo() {
  [[ -f "$1/Taskfile.yml" && -f "$1/package.json" ]] && grep -q '"name": "waveterm"' "$1/package.json" 2>/dev/null
}

AGENTFILE_REPO="${AGENTFILE_REPO:-}"
AGENTFILE_REPO_URL="${AGENTFILE_REPO_URL:-$DEFAULT_REPO_URL}"
AGENTFILE_CLONE_DEPTH="${AGENTFILE_CLONE_DEPTH:-1}"
AGENTFILE_CONFIRM_RESET="${AGENTFILE_CONFIRM_RESET:-}"

if [[ -z "${AGENTFILE_REPO:-}" ]]; then
  if is_agentfile_repo "$PWD"; then
    AGENTFILE_REPO="$PWD"
  elif is_agentfile_repo "$EMBEDDED_REPO"; then
    AGENTFILE_REPO="$EMBEDDED_REPO"
  else
    AGENTFILE_REPO="$HOME/Desktop/Agentfile"
  fi
fi

log() {
  printf '[agentfile-dev] %s\n' "$*"
}

die() {
  printf '[agentfile-dev] error: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

is_windows_shell() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

is_windows_amd64() {
  is_windows_shell && case "$(uname -m)" in
    x86_64|amd64) return 0 ;;
    *) return 1 ;;
  esac
}

is_quickdev_platform() {
  [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]
}

repo_task() {
  if is_windows_amd64; then
    printf 'electron:winquickdev'
  elif is_quickdev_platform; then
    printf 'electron:quickdev'
  else
    printf 'dev'
  fi
}

backend_task() {
  if is_windows_amd64; then
    printf 'build:backend:quickdev:windows'
  elif is_quickdev_platform; then
    printf 'build:backend:quickdev'
  else
    printf 'build:backend'
  fi
}

ensure_tools() {
  need_cmd git
  need_cmd node
  need_cmd npm
  need_cmd go
  need_cmd task
}

clone_repo() {
  mkdir -p "$(dirname "$AGENTFILE_REPO")"
  if [[ -n "${AGENTFILE_CLONE_DEPTH:-}" && "$AGENTFILE_CLONE_DEPTH" != "0" ]]; then
    log "cloning $AGENTFILE_REPO_URL (depth=$AGENTFILE_CLONE_DEPTH)"
    if git clone --depth "$AGENTFILE_CLONE_DEPTH" "$AGENTFILE_REPO_URL" "$AGENTFILE_REPO"; then
      return
    fi
    log "shallow clone failed; retrying full clone"
    rm -rf "$AGENTFILE_REPO"
  else
    log "cloning $AGENTFILE_REPO_URL"
  fi
  git clone "$AGENTFILE_REPO_URL" "$AGENTFILE_REPO"
}

ensure_existing_repo() {
  ensure_tools
  [[ -d "$AGENTFILE_REPO/.git" ]] || die "repo not found: $AGENTFILE_REPO (run install first)"
  cd "$AGENTFILE_REPO"
  is_agentfile_repo "$PWD" || die "not an Agentfile repo: $AGENTFILE_REPO"
}

ensure_repo() {
  ensure_tools
  if [[ ! -d "$AGENTFILE_REPO/.git" ]]; then
    log "repo not found: $AGENTFILE_REPO"
    clone_repo
  fi
  cd "$AGENTFILE_REPO"
  is_agentfile_repo "$PWD" || die "not an Agentfile repo: $AGENTFILE_REPO"
}

dev_data_path() {
  if is_windows_shell; then
    printf '%s\\waveterm2-dev\\Data' "${LOCALAPPDATA:-%LOCALAPPDATA%}"
  elif [[ "$(uname -s)" == "Darwin" ]]; then
    printf '%s/Library/Application Support/waveterm2-dev' "$HOME"
  else
    printf '%s/.local/share/waveterm2-dev' "$HOME"
  fi
}

dev_config_path() {
  printf '%s/.config/waveterm2-dev' "$HOME"
}

dev_log_path() {
  printf '%s/waveapp.log' "$(dev_data_path)"
}

renderer_is_up() {
  command -v curl >/dev/null 2>&1 || return 1
  curl -fsS --max-time 2 http://localhost:5173/ >/dev/null 2>&1
}

print_process_status() {
  if is_windows_shell; then
    if command -v tasklist.exe >/dev/null 2>&1; then
      tasklist.exe | grep -Ei 'electron|wavesrv|node' || true
    fi
    return
  fi
  ps ax -o pid=,command= | grep -F "$AGENTFILE_REPO" | grep -Ei 'Electron|electron-vite|wavesrv|vite|node' | grep -v grep || true
}

print_repo_status() {
  log "branch: $(git branch --show-current 2>/dev/null || true)"
  local dirty
  dirty="$(git status --short 2>/dev/null || true)"
  if [[ -n "$dirty" ]]; then
    log "working tree: dirty"
    printf '%s\n' "$dirty" | sed -n '1,40p'
  else
    log "working tree: clean"
  fi
}

print_log_status() {
  local log_path
  log_path="$(dev_log_path)"
  if [[ ! -f "$log_path" ]]; then
    log "log: not found ($log_path)"
    return
  fi
  log "log: $log_path"
  log "recent suspicious log lines:"
  tail -n 200 "$log_path" | grep -Ei 'error|panic|failed|exception|fatal' | tail -n 20 || true
}

doctor() {
  ensure_tools
  log "node: $(node -v)"
  log "npm: $(npm -v)"
  log "go: $(go version)"
  log "task: $(task --version)"
  log "repo: $AGENTFILE_REPO"
  log "repo url: $AGENTFILE_REPO_URL"
  log "dev data: $(dev_data_path)"
  log "dev config: $(dev_config_path)"
  log "run task: task $(repo_task)"
}

status_dev() {
  ensure_existing_repo
  doctor
  print_repo_status
  if renderer_is_up; then
    log "renderer: reachable at http://localhost:5173/"
  else
    log "renderer: not reachable at http://localhost:5173/"
  fi
  log "processes:"
  print_process_status
  print_log_status
}

diagnose_dev() {
  status_dev
  log "building Electron dev bundle"
  npm run build:dev
}

install_dev() {
  ensure_repo
  log "installing npm modules"
  npm install
  log "tidying Go modules"
  go mod tidy
  log "building backend with: task $(backend_task)"
  task "$(backend_task)"
}

run_dev() {
  ensure_repo
  local task_name
  task_name="$(repo_task)"
  if renderer_is_up; then
    log "renderer already reachable at http://localhost:5173/; skipping duplicate dev server"
    status_dev
    return
  fi
  log "starting Agentfile dev with: task $task_name"
  log "this uses the local waveterm2-dev data directory"
  exec task "$task_name"
}

build_dev() {
  ensure_repo
  log "building Electron dev bundle"
  npm run build:dev
}

update_dev() {
  ensure_repo
  local dirty
  dirty="$(git status --short)"
  if [[ -n "$dirty" ]]; then
    local total
    total="$(printf '%s\n' "$dirty" | wc -l | tr -d ' ')"
    printf '%s\n' "$dirty" | sed -n '1,80p'
    if (( total > 80 )); then
      log "... omitted $((total - 80)) more dirty paths"
    fi
    die "working tree is dirty; commit/stash or use another checkout before updating"
  fi
  git pull --ff-only
}

reset_dev_data() {
  [[ "${AGENTFILE_CONFIRM_RESET:-}" == "1" ]] || die "set AGENTFILE_CONFIRM_RESET=1 to delete dev data"
  if is_windows_shell; then
    cmd.exe /c 'rmdir /s /q "%LOCALAPPDATA%\waveterm2-dev\Data"' >/dev/null 2>&1 || true
    rm -rf "$(dev_config_path)"
  else
    rm -rf "$(dev_data_path)" "$(dev_config_path)"
  fi
  log "deleted waveterm2-dev data/config"
}

case "$ACTION" in
  doctor)
    doctor
    ;;
  status)
    status_dev
    ;;
  diagnose)
    diagnose_dev
    ;;
  install)
    install_dev
    ;;
  run)
    run_dev
    ;;
  build)
    build_dev
    ;;
  update)
    update_dev
    ;;
  reset-dev-data)
    reset_dev_data
    ;;
  *)
    cat >&2 <<EOF
Usage: $0 [doctor|status|diagnose|install|run|build|update|reset-dev-data]

Environment:
  AGENTFILE_REPO      Path to checkout. Default: current Agentfile repo, embedded repo, or ~/Desktop/Agentfile
  AGENTFILE_REPO_URL  Clone URL. Default: $DEFAULT_REPO_URL
EOF
    exit 2
    ;;
esac
