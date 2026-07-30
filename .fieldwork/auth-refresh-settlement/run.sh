#!/usr/bin/env bash
set -euo pipefail

variant="${1:-}"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_file="packages/core/auth-js/src/GoTrueClient.ts"
supabase_test_file="packages/core/supabase-js/test/fieldwork-realtime-refresh-token.test.ts"
auth_test_names=()

case "$variant" in
  early-shared-settlement)
    patch_file=".fieldwork/auth-refresh-settlement/patches/early-shared-settlement.patch"
    export FIELDWORK_OLD_TOKEN_JOINER_EARLY=true
    export FIELDWORK_EXPLICIT_OLD_TOKEN_NESTED=success
    export FIELDWORK_TRANSPORT_JOINER_OUTCOME=success
    auth_test_names=(
      refresh-notification-settlement.test.ts
      init-refresh-subscriber-error.test.ts
      settlement-boundaries.test.ts
      initial-session-callback-error.test.ts
      ssr-cookie-write-failure.test.ts
    )
    ;;
  token-aware-committed-result)
    patch_file=".fieldwork/auth-refresh-settlement/patches/token-aware-committed-result.patch"
    export FIELDWORK_OLD_TOKEN_JOINER_EARLY=false
    export FIELDWORK_EXPLICIT_OLD_TOKEN_NESTED=timeout
    export FIELDWORK_TRANSPORT_JOINER_OUTCOME=rejection
    auth_test_names=(
      refresh-notification-settlement.test.ts
      init-refresh-subscriber-error.test.ts
      settlement-boundaries.test.ts
      initial-session-callback-error.test.ts
      ssr-cookie-write-failure.test.ts
    )
    ;;
  notification-failure-separation)
    patch_file=".fieldwork/auth-refresh-settlement/patches/notification-failure-separation.patch"
    auth_test_names=(
      notification-failure-separation.test.ts
      overlapping-notification-slot.test.ts
      initial-session-callback-error.test.ts
    )
    ;;
  notification-result-map)
    patch_file=".fieldwork/auth-refresh-settlement/patches/notification-result-map.patch"
    auth_test_names=(
      notification-failure-separation.test.ts
      overlapping-notification-map.test.ts
      initial-session-callback-error.test.ts
    )
    ;;
  *)
    echo "usage: $0 <early-shared-settlement|token-aware-committed-result|notification-failure-separation|notification-result-map>" >&2
    exit 2
    ;;
esac

cd "$root_dir"

git apply --check "$patch_file"
git apply "$patch_file"

auth_test_files=()
auth_jest_args=()
for name in "${auth_test_names[@]}"; do
  target="packages/core/auth-js/test/fieldwork-${name}"
  cp ".fieldwork/auth-refresh-settlement/${name}" "$target"
  auth_test_files+=("$target")
  auth_jest_args+=("test/fieldwork-${name}")
done

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
  "${auth_jest_args[@]}" \
  --coverage=false

cd "$root_dir"
pnpm --filter '@supabase/supabase-js...' run build

cd packages/core/supabase-js
pnpm exec jest --runInBand --detectOpenHandles \
  test/fieldwork-realtime-refresh-token.test.ts \
  --coverage=false
