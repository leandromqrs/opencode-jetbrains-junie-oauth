#!/usr/bin/env bash
set +x
set -euo pipefail

printf 'This wrapper manages only the standalone quota adapter; the native OpenCode service is unchanged.\n' >&2
exec bash "$(dirname -- "${BASH_SOURCE[0]}")/quota-adapter.sh" "$@"
