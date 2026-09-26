#!/bin/sh
# Сборка бинарника notes-kai: cli/build.sh [outfile], по умолчанию dist/notes-kai.
set -eu
cd "$(dirname "$0")/.."
version=$(git describe --tags --always 2>/dev/null || echo dev)
exec bun build cli/notes-kai.ts --compile --minify \
  --define "NOTES_KAI_VERSION=\"$version\"" \
  --outfile "${1:-dist/notes-kai}"
