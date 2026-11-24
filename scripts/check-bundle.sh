#!/usr/bin/env bash
# Bundle check (M1-6): after a production build, fail if any secret-shaped
# string, secret variable name, or literal secret value from .env.local
# appears in the client bundle (.next/static). Secrets must only ever exist
# on the server; a match here means a server-only value leaked into client
# JavaScript.
#
# Usage: npm run build && scripts/check-bundle.sh
# Exit 0: clean. Exit 1: a secret (or its name) was found in the bundle.
# Secret values are never printed — only the variable name or the shape.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

if [ ! -d .next/static ]; then
  echo "FAIL: .next/static not found — run 'npm run build' first."
  exit 1
fi

# 1. Key shapes that must never appear in client JavaScript.
#    sb_secret_…  Supabase secret (service-role) key.
#    gsk_…         Groq API key: "gsk_" + 20 or more characters.
for pattern in 'sb_secret_[A-Za-z0-9_-]+' 'gsk_[A-Za-z0-9_-]{20,}'; do
  if grep -rEq "$pattern" .next/static; then
    echo "FAIL: key shape '$pattern' found in .next/static"
    fail=1
  fi
done

# 2. Secret variable names must not be bundled either.
for name in SUPABASE_SECRET_KEY GROQ_API_KEY ELEVENLABS_API_KEY; do
  if grep -rFq "$name" .next/static; then
    echo "FAIL: secret variable name '$name' found in .next/static"
    fail=1
  fi
done

# 3. Literal values from .env.local, if it exists. Only the variable name is
# ever printed — never the value.
if [ -f .env.local ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      SUPABASE_SECRET_KEY | GROQ_API_KEY | ELEVENLABS_API_KEY)
        # Strip surrounding quotes, if any.
        value="${value%\"}"
        value="${value#\"}"
        value="${value%\'}"
        value="${value#\'}"
        if [ -n "${value:-}" ] && grep -rFq "$value" .next/static; then
          echo "FAIL: literal value of '$key' found in .next/static"
          fail=1
        fi
        ;;
    esac
  done < .env.local
fi

if [ "$fail" -eq 0 ]; then
  echo "Bundle check passed: no secrets in .next/static"
fi
exit "$fail"
