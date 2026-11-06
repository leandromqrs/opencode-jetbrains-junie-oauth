#!/usr/bin/env bash
set +x
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
unit=opencode-junie-quota-adapter.service
description="OpenCode Junie standalone quota adapter v1"
action="${1:-}"
[[ $# -gt 0 ]] && shift
fail() { printf '%s\n' "$1" >&2; exit 1; }
case "$action" in
  start|run)
    location= port=62365
    key_file="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/jetbrains-junie/quota-adapter.key"
    while [[ $# -gt 0 ]]; do
      [[ $# -ge 2 ]] || fail 'Every option requires a value.'
      case "$1" in
        --location) [[ -z "$location" ]] || fail 'Location may only be supplied once.'; location="$2" ;;
        --port) port="$2" ;;
        --key-file) key_file="$2" ;;
        *) fail 'Unknown adapter option.' ;;
      esac
      shift 2
    done
    [[ "$location" == /* && "$key_file" == /* ]] || fail 'An explicit absolute --location and absolute key path are required.'
    [[ "$port" =~ ^[0-9]{1,5}$ ]] && (( 10#$port >= 1 && 10#$port <= 65535 )) || fail 'Port must be 1–65535.'
    [[ -f "$root/dist/quota-adapter.js" ]] || fail 'Build the adapter before starting it.'
    node="$(command -v node)"
    [[ "$node" == /* ]] || fail 'Node.js must resolve to an absolute executable path.'
    if [[ "$action" == run ]]; then
      exec "$node" "$root/scripts/quota-adapter-run.mjs" --location "$location" --port "$port" --key-file "$key_file"
    fi
    load="$(systemctl --user show "$unit" --property=LoadState --value)" || fail 'Cannot query the user service manager.'
    [[ "$load" == not-found ]] || fail 'Adapter unit already exists; inspect status and stop it before starting again.'
    environment=("--setenv=HOME=$HOME")
    for name in XDG_CONFIG_HOME XDG_STATE_HOME XDG_DATA_HOME XDG_RUNTIME_DIR; do
      [[ ! -v "$name" ]] || environment+=("--setenv=$name=${!name}")
    done
    exec systemd-run --user --unit="$unit" --description="$description" --collect --service-type=exec \
      --property=Restart=no --property=KillMode=control-group --property=TimeoutStopSec=10s \
      --property=UMask=0077 --property=LimitCORE=0 --property=StandardOutput=null --property=StandardError=journal \
      "${environment[@]}" -- "$node" "$root/scripts/quota-adapter-run.mjs" --location "$location" --port "$port" --key-file "$key_file"
    ;;
  stop|status)
    [[ $# -eq 0 ]] || fail 'Stop and status take no options.'
    load="$(systemctl --user show "$unit" --property=LoadState --value)" || fail 'Cannot query the user service manager.'
    if [[ "$load" == not-found ]]; then printf 'Adapter is stopped.\n'; exit 0; fi
    actual="$(systemctl --user show "$unit" --property=Description --value)"
    transient="$(systemctl --user show "$unit" --property=Transient --value)"
    [[ "$actual" == "$description" && "$transient" == yes ]] || fail 'Refusing to manage an unrelated unit with the adapter name.'
    if [[ "$action" == stop ]]; then exec systemctl --user stop "$unit"; fi
    exec systemctl --user show "$unit" --property=LoadState,ActiveState,SubState,Result,MainPID
    ;;
  *) printf 'Usage: bash scripts/quota-adapter.sh start --location /absolute/project [--port 62365] [--key-file /absolute/key]\n       bash scripts/quota-adapter.sh stop|status\n' >&2; exit 2 ;;
esac
