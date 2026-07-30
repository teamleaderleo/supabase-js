#!/usr/bin/env bash
set -euo pipefail

variant="${1:-}"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_file="packages/core/auth-js/src/GoTrueClient.ts"
auth_test_files=(
  "packages/core/auth-js/test/fieldwork-refresh-notification-settlement.test.ts"
  "packages/core/auth-js/test/fieldwork-init-refresh-subscriber-error.test.ts"
  "packages/core/auth-js/test/fieldwork-settlement-boundaries.test.ts"
  "packages/core/auth-js/test/fieldwork-initial-session-callback-error.test.ts"
  "packages/core/auth-js/test/fieldwork-ssr-cookie-write-failure.test.ts"
)
supabase_test_file="packages/core/supabase-js/test/fieldwork-realtime-refresh-token.test.ts"

case "$variant" in
  early-shared-settlement)
    patch_file=".fieldwork/auth-refresh-settlement/patches/early-shared-settlement.patch"
    export FIELDWORK_OLD_TOKEN_JOINER_EARLY=true
    export FIELDWORK_EXPLICIT_OLD_TOKEN_NESTED=success
    export FIELDWORK_TRANSPORT_JOINER_OUTCOME=success
    ;;
  token-aware-committed-result)
    patch_file=".fieldwork/auth-refresh-settlement/patches/token-aware-committed-result.patch"
    export FIELDWORK_OLD_TOKEN_JOINER_EARLY=false
    export FIELDWORK_EXPLICIT_OLD_TOKEN_NESTED=timeout
    export FIELDWORK_TRANSPORT_JOINER_OUTCOME=rejection
    ;;
  *)
    echo "usage: $0 <early-shared-settlement|token-aware-committed-result>" >&2
    exit 2
    ;;
esac

cd "$root_dir"

git apply --check "$patch_file"
git apply "$patch_file"
cp \
  .fieldwork/auth-refresh-settlement/refresh-notification-settlement.test.ts \
  "${auth_test_files[0]}"
cp \
  .fieldwork/auth-refresh-settlement/init-refresh-subscriber-error.test.ts \
  "${auth_test_files[1]}"
cp \
  .fieldwork/auth-refresh-settlement/settlement-boundaries.test.ts \
  "${auth_test_files[2]}"
cp \
  .fieldwork/auth-refresh-settlement/initial-session-callback-error.test.ts \
  "${auth_test_files[3]}"
cp \
  .fieldwork/auth-refresh-settlement/ssr-cookie-write-failure.test.ts \
  "${auth_test_files[4]}"
cp \
  .fieldwork/auth-refresh-settlement/supabase-client-realtime-refresh.test.ts \
  "$supabase_test_file"

node - "${auth_test_files[@]}" <<'NODE'
const fs = require('node:fs')
for (const path of process.argv.slice(2)) {
  const source = fs.readFileSync(path, 'utf8')
  fs.writeFileSync(path, source.replaceAll('../../packages/core/auth-js/src', '../src'))
}
NODE

node - "$supabase_test_file" <<'NODE'
const fs = require('node:fs')
const path = process.argv[2]
const source = fs
  .readFileSync(path, 'utf8')
  .replaceAll('../../packages/core/supabase-js/src/SupabaseClient', '../src/SupabaseClient')
  .replaceAll('../../packages/core/auth-js/src', '../../auth-js/src')
fs.writeFileSync(path, source)
NODE

cleanup() {
  git checkout -- "$source_file" >/dev/null 2>&1 || true
  rm -f "${auth_test_files[@]}" "$supabase_test_file"
}
trap cleanup EXIT

cd packages/core/auth-js
pnpm exec jest --config jest.config.cli.js --runInBand \
  test/fieldwork-refresh-notification-settlement.test.ts \
  test/fieldwork-init-refresh-subscriber-error.test.ts \
  test/fieldwork-settlement-boundaries.test.ts \
  test/fieldwork-initial-session-callback-error.test.ts \
  test/fieldwork-ssr-cookie-write-failure.test.ts \
  --coverage=false

cd "$root_dir"
pnpm --filter '@supabase/supabase-js...' run build

cd packages/core/supabase-js
pnpm exec jest --runInBand --detectOpenHandles \
  test/fieldwork-realtime-refresh-token.test.ts \
  --coverage=false
