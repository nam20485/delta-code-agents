#!/bin/sh
# Single source of truth for validation, used identically locally and in CI.
# /safe-commit runs this script when it finds it.
set -eu
cd "$(dirname "$0")"

echo "== install =="
[ -d node_modules ] || npm ci

echo "== markdownlint =="
./node_modules/.bin/markdownlint-cli2 "**/*.md" "#node_modules" "#dist" "#.qwen"

echo "== build (tsc) =="
./node_modules/.bin/tsc -p .

echo "== tests (node --test) =="
# Explicit file list: node >= 22 treats --test args as globs and would try to
# execute the bare directory path itself.
node --test dist/test/*.test.js
