#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
test_file="packages/core/auth-js/test/fieldwork-ssr-cookie-write-baseline.test.ts"

cd "$root_dir"
cp \
  .fieldwork/auth-refresh-settlement/ssr-cookie-write-baseline.test.ts \
  "$test_file"

node - "$test_file" <<'NODE'
const fs = require('node:fs')
const path = process.argv[2]
const source = fs.readFileSync(path, 'utf8')
fs.writeFileSync(path, source.replaceAll('../../packages/core/auth-js/src', '../src'))
NODE

cleanup() {
  rm -f "$test_file"
}
trap cleanup EXIT

cd packages/core/auth-js
pnpm exec jest --config jest.config.cli.js --runInBand \
  test/fieldwork-ssr-cookie-write-baseline.test.ts \
  --coverage=false
