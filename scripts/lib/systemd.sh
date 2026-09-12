#!/usr/bin/env bash

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

run_systemctl() {
  run_as_root systemctl "$@"
}

run_journalctl() {
  run_as_root journalctl "$@"
}

service_exists() {
  command -v systemctl >/dev/null 2>&1 \
    && systemctl list-unit-files --type=service --no-legend 2>/dev/null | grep -q '^heartpet\.service'
}
