#!/bin/bash
# secret-scan.sh — shared secret scanner for the FLASH git hooks.
#
# Reads file content from stdin and checks it for secret-shaped values.
# Usage: secret-scan.sh [--vars] <display-name>
#   --vars   also check for non-empty NAME=value assignments of the
#            secret variables (only for non-Markdown files; the caller
#            decides). Without --vars, only key shapes are checked.
#
# Exit status: 0 = clean, 1 = a secret pattern matched.
# On a match it prints only the file name and the pattern name.
# It NEVER prints the matched value.
#
# Patterns:
#   GEMINI_KEY      Google API key: AIza + 35 base64url chars.
#   SUPABASE_SECRET Supabase secret key: sb_secret_ + 16 or more chars.
#   LEGACY_JWT      Legacy Supabase anon/service-role JWT (three
#                   dot-separated base64url segments, first starts eyJ).
#   SECRET_VAR      Non-empty assignment of a server-only secret variable.

display_name="$1"
check_vars=0
if [ "$1" = "--vars" ]; then
  check_vars=1
  display_name="$2"
fi

tmp="$(mktemp)" || exit 1
trap 'rm -f "$tmp"' EXIT INT TERM
cat > "$tmp"

matched=""
if grep -q -E 'AIza[0-9A-Za-z_-]{35}' "$tmp" 2>/dev/null; then
  matched="GEMINI_KEY"
elif grep -q -E 'sb_secret_[A-Za-z0-9_-]{16,}' "$tmp" 2>/dev/null; then
  matched="SUPABASE_SECRET"
elif grep -q -E 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}' "$tmp" 2>/dev/null; then
  matched="LEGACY_JWT"
elif [ "$check_vars" -eq 1 ] && grep -q -E '(GOOGLE_GENERATIVE_AI_API_KEY|SUPABASE_SECRET_KEY|ELEVENLABS_API_KEY|TAVILY_API_KEY)[[:space:]]*=[[:space:]]*[^[:space:]#]+' "$tmp" 2>/dev/null; then
  matched="SECRET_VAR"
fi

if [ -n "$matched" ]; then
  echo "secret-scan: blocked $display_name (matched $matched; value not shown)" >&2
  exit 1
fi
exit 0
