#!/bin/sh
# Single source of truth for validation, used identically locally and in CI.
# /safe-commit runs this script when it finds it.
set -eu
cd "$(dirname "$0")"

echo "== install =="
[ -d node_modules ] || npm ci

echo "== markdownlint =="
./node_modules/.bin/markdownlint-cli2 "**/*.md" "#node_modules" "#dist" "#.qwen" "#commands"
# Command files are prompt templates: lint them with MD041 (first-line
# heading) disabled via a dedicated config (overrides don't apply to globs).
./node_modules/.bin/markdownlint-cli2 --config .markdownlint-cli2.commands.jsonc "commands/**/*.md"

echo "== build (tsc) =="
# Clean rebuild so orphaned outputs from deleted src files are removed too.
rm -rf dist/src
./node_modules/.bin/tsc -p .

# The committed dist/src must exactly match a fresh build (modified, added, or
# orphaned files all fail), so URL-install never ships stale artifacts.
echo "== dist/src freshness =="
if [ -n "$(git status --porcelain -- dist/src)" ]; then
  git status --short -- dist/src
  echo "dist/src is stale — rebuild and commit it" >&2
  exit 1
fi

echo "== tests (node --test) =="
# Explicit file list: node >= 22 treats --test args as globs and would try to
# execute the bare directory path itself.
node --test dist/test/*.test.js
