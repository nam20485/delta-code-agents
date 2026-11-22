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
./node_modules/.bin/tsc -p .

# The committed dist/src must match a fresh build, so URL-install never ships
# stale artifacts (a src change without a rebuild fails here).
echo "== dist/src freshness =="
git diff --exit-code -- dist/src

echo "== tests (node --test) =="
# Explicit file list: node >= 22 treats --test args as globs and would try to
# execute the bare directory path itself.
node --test dist/test/*.test.js
