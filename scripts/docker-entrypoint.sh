#!/usr/bin/env bash
set -euo pipefail

TARGET_UID="${AGENT_UID:-1000}"
TARGET_GID="${AGENT_GID:-1000}"
RUN_AS_HOST_USER="${AGENT_RUN_AS_HOST_USER:-true}"
TARGET_HOME="${HOME:-/agent-home}"

mkdir -p "$TARGET_HOME" /app/logs

resolve_target_user() {
  local group_name user_name

  if getent group "$TARGET_GID" >/dev/null 2>&1; then
    group_name="$(getent group "$TARGET_GID" | cut -d: -f1)"
  else
    group_name="agenthost"
    groupadd --gid "$TARGET_GID" "$group_name"
  fi

  if getent passwd "$TARGET_UID" >/dev/null 2>&1; then
    user_name="$(getent passwd "$TARGET_UID" | cut -d: -f1)"
  else
    user_name="agenthost"
    useradd --uid "$TARGET_UID" --gid "$TARGET_GID" --home-dir "$TARGET_HOME" --shell /bin/bash "$user_name"
  fi

  echo "$user_name"
}

run_as_target() {
  if [ "$(id -u)" = "0" ] && [ "$RUN_AS_HOST_USER" != "false" ]; then
    gosu "$TARGET_USER" "$@"
  else
    "$@"
  fi
}

if [ "$(id -u)" = "0" ] && [ "$RUN_AS_HOST_USER" != "false" ]; then
  TARGET_USER="$(resolve_target_user)"
  chown -R "$TARGET_UID:$TARGET_GID" "$TARGET_HOME" /app/logs >/dev/null 2>&1 || true
else
  TARGET_USER="$(id -un)"
fi

run_as_target git config --global --add safe.directory /codebase >/dev/null 2>&1 || true
run_as_target git config --global --add safe.directory /workspace >/dev/null 2>&1 || true
run_as_target git config --global --add safe.directory /host >/dev/null 2>&1 || true
run_as_target git config --global --add safe.directory '*' >/dev/null 2>&1 || true

if [ -n "${GIT_AUTHOR_NAME:-}" ]; then
  run_as_target git config --global user.name "${GIT_AUTHOR_NAME}" >/dev/null 2>&1 || true
elif ! run_as_target git config --global user.name >/dev/null 2>&1; then
  run_as_target git config --global user.name "AI Agent" >/dev/null 2>&1 || true
fi

if [ -n "${GIT_AUTHOR_EMAIL:-}" ]; then
  run_as_target git config --global user.email "${GIT_AUTHOR_EMAIL}" >/dev/null 2>&1 || true
elif ! run_as_target git config --global user.email >/dev/null 2>&1; then
  run_as_target git config --global user.email "ai-agent@example.com" >/dev/null 2>&1 || true
fi

if [ "$(id -u)" = "0" ] && [ "$RUN_AS_HOST_USER" != "false" ]; then
  exec gosu "$TARGET_USER" "$@"
fi

exec "$@"
