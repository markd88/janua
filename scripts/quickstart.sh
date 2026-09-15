#!/usr/bin/env bash
#
# Interactive Janua quickstart for Docker + Ollama.
#

set -euo pipefail

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
fi

TOTAL_STAGES=7
_STAGE_INDEX=0
ENV_FILE="${ENV_FILE:-.env}"
WRITTEN_ENV=()
COMPOSE_AVAILABLE=false

_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi
}

banner() {
  _clear
  printf '\n%s%s  Janua Quickstart: Docker + Ollama%s\n' "$BOLD" "$BLUE" "$RESET"
  printf '%s  %s stages%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"
  printf '  This wizard configures local Janua, recommends an Ollama model,\n'
  printf '  starts Docker Compose, pulls the model, and shows you how to open Admin.\n\n'
  pause "Ready to start?"
}

stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  printf '\n%s%s> Stage %s/%s: %s%s\n' "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"
}

say()  { printf '  %s\n' "$1"; }
step() { printf '  - %s\n' "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %sWARNING: %s%s\n' "$YELLOW" "$1" "$RESET"; }

pause() {
  printf '  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"
  read -r _ || true
}

confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ "$reply" =~ ^[Yy] ]]
}

confirm_yes() {
  local reply=""
  printf '  %s? %s [Y/n] ' "$YELLOW" "$1"
  read -r reply || true
  [[ ! "$reply" =~ ^[Nn] ]]
}

_existing() {
  [[ -f "$ENV_FILE" ]] || return 1
  local line
  line=$(grep -E "^${1}=" "$ENV_FILE" | tail -n1) || return 1
  printf '%s' "${line#*=}"
}

ask() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[current: %s]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$current" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -r input || true
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

write_env() {
  local key="$1" value="$2" tmp
  touch "$ENV_FILE"
  tmp=$(mktemp)
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  WRITTEN_ENV+=("$key")
  printf '  %sOK%s wrote %s to %s\n' "$GREEN" "$RESET" "$key" "$ENV_FILE"
}

finish() {
  _clear
  printf '\n%s%s  Congratulations, Janua is running%s\n\n' "$BOLD" "$GREEN" "$RESET"
  if (( ${#WRITTEN_ENV[@]} )); then
    note "Updated $ENV_FILE: ${WRITTEN_ENV[*]}"
  fi
  printf '  Default Admin password:\n'
  printf '    admin-key\n\n'
  printf '  Next steps:\n'
  printf '    1. Open Admin and fill in your business info:\n'
  printf '       %s/admin\n' "${JANUA_PUBLIC_BASE_URL:-http://localhost:3000}"
  printf '    2. Try the demo chat as a website visitor:\n'
  printf '       %s/demo\n' "${JANUA_PUBLIC_BASE_URL:-http://localhost:3000}"
  printf '    3. Go back to Admin and check the captured lead.\n\n'
  printf '  To shut down Janua:\n'
  printf '    docker compose --profile ollama down\n\n'
  printf '  Your local lead data is kept in:\n'
  printf '    data/janua.db\n\n'
  printf '  Useful commands:\n'
  printf '    docker compose --profile ollama logs -f app\n'
  printf '    docker compose --profile ollama ps\n'
  printf '\n'
}

repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
}

fail() {
  printf '%sERROR:%s %s\n' "$RED" "$RESET" "$1" >&2
  exit 1
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    fail "Docker Compose is required. Install Docker Desktop or the Docker Compose plugin."
  fi
}

compose_service_running() {
  local service="$1"
  compose --profile ollama ps --status running --services 2>/dev/null | grep -qx "$service"
}

check_for_updates() {
  local upstream local_head remote_head merge_base
  if ! command -v git >/dev/null 2>&1 || ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    warn "Skipping update check because this folder is not a Git checkout."
    return 0
  fi

  upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
  if [[ -z "$upstream" ]]; then
    warn "Skipping update check because this branch has no upstream remote."
    return 0
  fi

  step "Checking for Janua updates from $upstream."
  if ! git fetch --quiet; then
    warn "Could not fetch updates. Continuing with the local checkout."
    return 0
  fi

  local_head=$(git rev-parse @)
  remote_head=$(git rev-parse '@{u}')
  merge_base=$(git merge-base @ '@{u}')

  if [[ "$local_head" == "$remote_head" ]]; then
    say "Janua is already up to date."
    return 0
  fi

  if [[ "$remote_head" == "$merge_base" ]]; then
    warn "Your local checkout has commits that are not on $upstream. Skipping auto-update."
    return 0
  fi

  if [[ "$local_head" != "$merge_base" ]]; then
    warn "Your local checkout has diverged from $upstream. Skipping auto-update."
    return 0
  fi

  say "A newer Janua version is available."
  note "Updating only changes the source checkout. It does not delete data/janua.db or Docker volumes."
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    warn "Tracked local files have changes. Commit, stash, or discard them before updating."
    return 0
  fi

  if confirm_yes "Update Janua now?"; then
    git pull --ff-only
    say "Janua source code is updated."
    note "If this script was updated, re-running ./scripts/quickstart.sh after this run will use the newest wizard."
  else
    warn "Skipped update. You can update later with: git pull --ff-only"
  fi
}

detect_memory_gb() {
  local bytes=""
  if command -v sysctl >/dev/null 2>&1; then
    bytes=$(sysctl -n hw.memsize 2>/dev/null || true)
  fi
  if [[ -z "$bytes" && -r /proc/meminfo ]]; then
    bytes=$(awk '/MemTotal/ { print $2 * 1024 }' /proc/meminfo)
  fi
  if [[ -n "$bytes" ]]; then
    awk -v bytes="$bytes" 'BEGIN { printf "%.0f", bytes / 1024 / 1024 / 1024 }'
  else
    printf '0'
  fi
}

detect_docker_memory_gb() {
  local bytes=""
  bytes=$(docker info --format '{{.MemTotal}}' 2>/dev/null || true)
  if [[ -n "$bytes" && "$bytes" =~ ^[0-9]+$ ]]; then
    awk -v bytes="$bytes" 'BEGIN { printf "%.0f", bytes / 1024 / 1024 / 1024 }'
  else
    printf '0'
  fi
}

effective_memory_gb() {
  local host_gb="$1" docker_gb="$2"
  if (( host_gb > 0 && docker_gb > 0 )); then
    if (( docker_gb < host_gb )); then
      printf '%s' "$docker_gb"
    else
      printf '%s' "$host_gb"
    fi
  elif (( docker_gb > 0 )); then
    printf '%s' "$docker_gb"
  else
    printf '%s' "$host_gb"
  fi
}

target_docker_memory_gb() {
  local host_gb="$1"
  if (( host_gb >= 32 )); then
    printf '24'
  elif (( host_gb >= 16 )); then
    printf '12'
  elif (( host_gb >= 8 )); then
    printf '8'
  else
    printf '0'
  fi
}

recommended_model() {
  local memory_gb="$1"
  if (( memory_gb >= 24 )); then
    printf 'qwen2.5:14b'
  elif (( memory_gb >= 8 )); then
    printf 'qwen2.5:7b'
  else
    printf 'llama3.2:3b'
  fi
}

suggest_docker_memory_upgrade() {
  local host_gb="$1" docker_gb="$2" target_gb="$3"
  [[ "$target_gb" == "0" ]] && return 0
  (( docker_gb == 0 || docker_gb >= target_gb )) && return 0

  warn "Docker memory is lower than the best local setting for this machine."
  say "For better local model quality, increase Docker Desktop memory before starting containers:"
  say "1. Open Docker Desktop."
  say "2. Go to Settings > Resources > Memory."
  say "3. Set Memory to at least ${target_gb}GB if your machine has enough free memory."
  say "4. Apply & Restart Docker Desktop, then return here."
  note "Docker Compose cannot increase Docker Desktop VM memory for you; containers can only use what Docker Desktop exposes."
  if confirm "I increased Docker memory and restarted Docker Desktop; re-detect now?"; then
    if ! docker info >/dev/null 2>&1; then
      fail "Docker is not running after restart. Start Docker Desktop, then re-run quickstart."
    fi
    DOCKER_MEMORY_GB=$(detect_docker_memory_gb)
    MEMORY_GB=$(effective_memory_gb "$HOST_MEMORY_GB" "$DOCKER_MEMORY_GB")
    say "Detected about ${DOCKER_MEMORY_GB}GB Docker memory after restart."
  fi
}

choose_model() {
  local recommendation="$1" choice custom existing default_model
  existing=$(_existing OLLAMA_MODEL || true)
  default_model="${existing:-$recommendation}"
  if [[ -n "$existing" ]]; then
    say "Existing model in $ENV_FILE: $existing"
  fi
  say "Recommended model: $recommendation"
  say "1) llama3.2:3b  - lightest default, best for low-memory machines"
  say "2) qwen2.5:7b   - better local demo quality, good for 8GB+ Docker memory"
  say "3) qwen2.5:14b  - best local demo quality, good for 24GB+ Docker memory"
  say "4) Custom model name"
  printf '  Choose a model [Enter keeps %s]: ' "$default_model"
  read -r choice || true
  case "$choice" in
    1) OLLAMA_MODEL="llama3.2:3b" ;;
    2) OLLAMA_MODEL="qwen2.5:7b" ;;
    3) OLLAMA_MODEL="qwen2.5:14b" ;;
    4)
      printf '  Custom Ollama model, for example llama3.1:8b: '
      read -r custom || true
      OLLAMA_MODEL="${custom:-$default_model}"
      ;;
    *) OLLAMA_MODEL="$default_model" ;;
  esac
}

wait_for_ollama() {
  local attempts=30
  local delay=2
  local i
  step "Waiting for Ollama to be ready."
  for (( i = 1; i <= attempts; i++ )); do
    if compose --profile ollama exec -T ollama ollama list >/dev/null 2>&1; then
      printf '  %sOK%s Ollama is ready.\n' "$GREEN" "$RESET"
      return 0
    fi
    sleep "$delay"
  done
  fail "Ollama did not become ready. Run: docker compose --profile ollama logs ollama"
}

ollama_model_installed() {
  local model="$1"
  compose --profile ollama exec -T ollama ollama show "$model" >/dev/null 2>&1
}

pull_ollama_model() {
  local model="$1"
  wait_for_ollama
  if ollama_model_installed "$model"; then
    printf '  %sOK%s model already installed: %s\n' "$GREEN" "$RESET" "$model"
    return 0
  fi
  step "Pulling Ollama model: $model"
  if ! compose --profile ollama exec -T ollama ollama pull "$model"; then
    fail "Failed to pull $model. Docker may not have enough memory or disk. Increase Docker Desktop memory, or rerun quickstart and choose llama3.2:3b."
  fi
  step "Verifying Ollama model is installed."
  if ! ollama_model_installed "$model"; then
    fail "Ollama did not report $model as installed after pull. Try: docker compose --profile ollama logs ollama"
  fi
  printf '  %sOK%s model installed: %s\n' "$GREEN" "$RESET" "$model"
}

verify_ollama_model_runs() {
  local model="$1"
  local payload
  if ! command -v curl >/dev/null 2>&1; then
    warn "curl is not available; skipping the Ollama model runtime check."
    return 0
  fi
  payload=$(printf '{"model":"%s","prompt":"Reply with OK only.","stream":false}' "$model")
  step "Checking that Ollama can load and run $model."
  if ! curl --fail --silent --show-error --max-time 120 \
    http://localhost:11434/api/generate \
    -H 'Content-Type: application/json' \
    -d "$payload" >/dev/null; then
    fail "Ollama could not run $model. Docker may not have enough memory. Increase Docker Desktop memory, or rerun quickstart and choose llama3.2:3b."
  fi
  printf '  %sOK%s model responded: %s\n' "$GREEN" "$RESET" "$model"
}

verify_app_ready() {
  local url="${JANUA_PUBLIC_BASE_URL:-http://localhost:3000}/health"
  local attempts=30
  local delay=2
  local i
  if ! command -v curl >/dev/null 2>&1; then
    warn "curl is not available; skipping the Janua HTTP readiness check."
    return 0
  fi
  step "Waiting for Janua HTTP health check."
  for (( i = 1; i <= attempts; i++ )); do
    if curl --fail --silent --show-error "$url" >/dev/null 2>&1; then
      printf '  %sOK%s Janua is responding at %s\n' "$GREEN" "$RESET" "$url"
      return 0
    fi
    sleep "$delay"
  done
  fail "Janua did not become reachable at $url. Run: docker compose --profile ollama logs app"
}

repo_root
banner

stage "Check local tools"
step "Checking this is the Janua repo."
[[ -f package.json ]] || fail "Run this script from the Janua checkout."
[[ -f docker-compose.yml ]] || fail "docker-compose.yml was not found."
step "Checking Docker CLI."
command -v docker >/dev/null 2>&1 || fail "Docker is required. Install Docker Desktop, then re-run this script."
step "Checking Docker Compose."
compose version >/dev/null
step "Checking Docker is running."
if ! docker info >/dev/null 2>&1; then
  fail "Docker is installed but not running. Start Docker Desktop, then re-run this script."
fi
say "Docker is ready."
note "You do not need Node.js, pnpm, or local Ollama for this Docker quickstart."
pause "Continue?"

stage "Check for updates"
check_for_updates
pause "Continue?"

stage "Create local env"
if [[ ! -f "$ENV_FILE" ]]; then
  step "Creating $ENV_FILE from .env.example."
  cp .env.example "$ENV_FILE"
else
  step "$ENV_FILE already exists; this wizard will only update the values it needs."
fi
step "Creating local data and config folders."
mkdir -p data config
ask JANUA_PORT "Janua port [default 3000]:"
JANUA_PORT="${JANUA_PORT:-3000}"
JANUA_PUBLIC_BASE_URL="http://localhost:${JANUA_PORT}"
write_env ADMIN_API_KEY "admin-key"
write_env JANUA_PORT "$JANUA_PORT"
write_env JANUA_PUBLIC_BASE_URL "$JANUA_PUBLIC_BASE_URL"
write_env JANUA_ALLOWED_ORIGINS "$JANUA_PUBLIC_BASE_URL"
write_env JANUA_DATA_DIR "data"
write_env JANUA_DB_PATH "data/janua.db"
write_env JANUA_CONFIG_DIR "config"
write_env JANUA_AGENT_CONFIG_PATH "config/agent-config.json"
write_env JANUA_LLM_PROVIDER "ollama"
write_env JANUA_OLLAMA_PREWARM "true"

stage "Choose Ollama model"
HOST_MEMORY_GB=$(detect_memory_gb)
DOCKER_MEMORY_GB=$(detect_docker_memory_gb)
MEMORY_GB=$(effective_memory_gb "$HOST_MEMORY_GB" "$DOCKER_MEMORY_GB")
if (( HOST_MEMORY_GB > 0 )); then
  say "Detected about ${HOST_MEMORY_GB}GB system memory."
else
  warn "Could not detect system memory; using the light default recommendation."
fi
if (( DOCKER_MEMORY_GB > 0 )); then
  say "Detected about ${DOCKER_MEMORY_GB}GB Docker memory."
  if (( HOST_MEMORY_GB > 0 && DOCKER_MEMORY_GB < HOST_MEMORY_GB )); then
    warn "Docker has less memory than the host; model recommendation will use Docker memory."
  fi
else
  warn "Could not detect Docker memory; model recommendation will use host memory."
fi
TARGET_DOCKER_MEMORY_GB=$(target_docker_memory_gb "$HOST_MEMORY_GB")
suggest_docker_memory_upgrade "$HOST_MEMORY_GB" "$DOCKER_MEMORY_GB" "$TARGET_DOCKER_MEMORY_GB"
RECOMMENDED_MODEL=$(recommended_model "$MEMORY_GB")
choose_model "$RECOMMENDED_MODEL"
write_env OLLAMA_MODEL "$OLLAMA_MODEL"
write_env OLLAMA_BASE_URL "http://localhost:11434"
say "Selected model: $OLLAMA_MODEL"
pause "Continue?"

stage "Start Janua and Ollama"
if compose_service_running app && compose_service_running ollama; then
  COMPOSE_AVAILABLE=true
  say "Janua and Ollama containers are already running."
fi
say "This runs: docker compose --profile ollama up -d --build"
if confirm_yes "Start or update Docker Compose now?"; then
  compose --profile ollama up -d --build
  COMPOSE_AVAILABLE=true
else
  if [[ "$COMPOSE_AVAILABLE" == "true" ]]; then
    warn "Skipped update; using the running containers."
  else
    warn "Skipped start. Run later: docker compose --profile ollama up -d --build"
  fi
fi
pause "Continue?"

stage "Download the Ollama model"
say "This can take a while the first time."
say "This runs: docker compose --profile ollama exec -T ollama ollama pull $OLLAMA_MODEL"
if [[ "$COMPOSE_AVAILABLE" == "true" ]]; then
  if confirm_yes "Pull or verify $OLLAMA_MODEL now?"; then
    pull_ollama_model "$OLLAMA_MODEL"
    verify_ollama_model_runs "$OLLAMA_MODEL"
  else
    warn "Skipped model pull. Run later: docker compose --profile ollama exec -T ollama ollama pull $OLLAMA_MODEL"
  fi
else
  warn "Skipped model pull because Docker Compose is not running."
fi

stage "Restart and verify"
if [[ "$COMPOSE_AVAILABLE" == "true" ]]; then
  if confirm_yes "Restart the Janua app now so it picks up the model?"; then
    compose --profile ollama restart app
  fi
  verify_app_ready
else
  warn "Skipped restart and verification because Docker Compose is not running."
fi
say "Current containers:"
compose --profile ollama ps || true
say "If the app is still starting, follow logs with:"
say "docker compose --profile ollama logs -f app"
pause "Finish?"

finish
