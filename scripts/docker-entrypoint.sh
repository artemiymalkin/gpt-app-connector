#!/usr/bin/env bash
set -euo pipefail

mkdir -p "${HOME:-/agent-home}"

git config --global --add safe.directory /codebase >/dev/null 2>&1 || true
git config --global --add safe.directory /workspace >/dev/null 2>&1 || true
git config --global --add safe.directory '*' >/dev/null 2>&1 || true

if [ -n "${GIT_AUTHOR_NAME:-}" ]; then
  git config --global user.name "${GIT_AUTHOR_NAME}" >/dev/null 2>&1 || true
elif ! git config --global user.name >/dev/null 2>&1; then
  git config --global user.name "AI Agent" >/dev/null 2>&1 || true
fi

if [ -n "${GIT_AUTHOR_EMAIL:-}" ]; then
  git config --global user.email "${GIT_AUTHOR_EMAIL}" >/dev/null 2>&1 || true
elif ! git config --global user.email >/dev/null 2>&1; then
  git config --global user.email "ai-agent@example.local" >/dev/null 2>&1 || true
fi

exec "$@"
