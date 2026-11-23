#!/bin/bash
# test-hooks.sh — prove the secret-scan hooks block secrets (17 cases).
#
# Builds a throwaway repo + bare remote, installs the hooks there, and runs
# the cases. Fake keys are generated at runtime from /dev/urandom and never
# saved in this file. The throwaway directory is removed afterwards.
# Usage: sh scripts/hooks/test-hooks.sh
# Exit status: 0 when all 17 cases pass.

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0

ok() { # ok <name> <got> <want>
  if [ "$2" = "$3" ]; then
    PASS=$((PASS + 1)); echo "PASS: $1"
  else
    FAIL=$((FAIL + 1)); echo "FAIL: $1 (got '$2', want '$3')"
  fi
}

rand() { tr -dc 'A-Za-z0-9_-' < /dev/urandom | head -c "$1"; }
# Secret variable names, kept in variables so this file never contains a
# literal NAME=value pattern that the hook would (correctly) block.
V_GEMINI="GOOGLE_GENERATIVE_AI_API_KEY"
V_SB="SUPABASE_SECRET_KEY"
FAKE_GEMINI="AIza$(rand 35)"
FAKE_SB="sb_secret_$(rand 32)"
FAKE_JWT="eyJ$(rand 20).eyJ$(rand 20).$(rand 20)"

WORK="$(mktemp -d)" || exit 1
trap 'rm -rf "$WORK"' EXIT INT TERM
REMOTE="$WORK/remote.git"
REPO="$WORK/repo"
git init --bare -q "$REMOTE"
git init -q -b main "$REPO"
cd "$REPO" || exit 1
git config user.name "Test"
git config user.email "test@example.com"
mkdir -p scripts/hooks
cp "$HOOK_DIR/secret-scan.sh" "$HOOK_DIR/pre-commit" "$HOOK_DIR/pre-push" scripts/hooks/
chmod +x scripts/hooks/*
git config core.hooksPath scripts/hooks
git remote add origin "$REMOTE"

# commit helper: commit <msg> ; echoes exit status of git commit
commit() { git commit -qm "$1" 2>/dev/null; echo $?; }
# push helper: push [branch] ; echoes exit status of git push
push() { git push -q origin "${1:-main}" 2>/dev/null; echo $?; }

# --- pre-commit cases (1-9) ---
echo "clean" > clean.txt; git add clean.txt
ok "1 clean commit passes" "$(commit clean)" "0"

printf 'key = "%s"\n' "$FAKE_GEMINI" > bad.ts; git add bad.ts
ok "2 gemini key blocked" "$(commit bad-gemini)" "1"; git reset -q --hard HEAD; rm -f bad.ts

printf 'key = "%s"\n' "$FAKE_SB" > bad.ts; git add bad.ts
ok "3 supabase secret blocked" "$(commit bad-sb)" "1"; git reset -q --hard HEAD; rm -f bad.ts

printf 'key = "%s"\n' "$FAKE_JWT" > bad.ts; git add bad.ts
ok "4 legacy jwt blocked" "$(commit bad-jwt)" "1"; git reset -q --hard HEAD; rm -f bad.ts

printf '%s=%s\n' "$V_GEMINI" "$FAKE_GEMINI" > .env.local; git add .env.local
ok "5 secret var in .env.local blocked" "$(commit bad-env)" "1"; git reset -q --hard HEAD; rm -f .env.local

printf '%s=%s\n' "$V_SB" "$FAKE_SB" > config.ts; git add config.ts
ok "6 secret var in .ts blocked" "$(commit bad-ts-var)" "1"; git reset -q --hard HEAD; rm -f config.ts

printf '%s=\n%s=\n' "$V_GEMINI" "$V_SB" > .env.example; git add .env.example
ok "7 empty placeholder in .env.example passes" "$(commit env-example)" "0"

mkdir -p "dir with spaces"; printf 'key = "%s"\n' "$FAKE_SB" > "dir with spaces/bad.ts"; git add "dir with spaces/bad.ts"
ok "8 key in path with spaces blocked" "$(commit bad-spaces)" "1"; git reset -q --hard HEAD; rm -rf "dir with spaces"

git mv clean.txt renamed.txt; printf 'key = "%s"\n' "$FAKE_GEMINI" >> renamed.txt; git add renamed.txt
ok "9 key in renamed file blocked" "$(commit bad-rename)" "1"; git reset -q --hard HEAD; rm -f renamed.txt

# --- pre-push cases (10-16) ---
# baseline: clean state on main, pushed once so the branch exists remotely
git status --porcelain | grep -q . && git add -A && git commit -qm baseline --no-verify
ok "10 clean push passes" "$(push main)" "0"

printf 'key = "%s"\n' "$FAKE_SB" > bad.ts; git add bad.ts; git commit -qm bad-push --no-verify
ok "11 push with key blocked" "$(push main)" "1"; git reset -q --hard origin/main; rm -f bad.ts

git checkout -qb feature
printf 'key = "%s"\n' "$FAKE_SB" > bad.ts; git add bad.ts; git commit -qm add-key --no-verify
git rm -q bad.ts; git commit -qm remove-key --no-verify
ok "12 add-then-remove on new branch blocked" "$(push feature)" "1"
git checkout -q main; git branch -qD feature

printf 'key = "%s"\n' "$FAKE_SB" > bad.ts; git add bad.ts; git commit -qm add-key2 --no-verify
git rm -q bad.ts; git commit -qm remove-key2 --no-verify
ok "13 add-then-remove on existing branch blocked" "$(push main)" "1"
git reset -q --hard origin/main

printf 'key = "%s"\n' "$FAKE_GEMINI" > notes.md; git add notes.md; git commit -qm md-key --no-verify
ok "14 key in markdown blocked on push" "$(push main)" "1"
git reset -q --hard origin/main; rm -f notes.md

printf '%s=%s\n' "$V_SB" "not-a-real-key" > notes.md; git add notes.md; git commit -qm md-var --no-verify
ok "15 secret var in markdown passes on push" "$(push main)" "0"

# --- case 17: hook output never contains the value ---
printf 'key = "%s"\n' "$FAKE_SB" > bad.ts; git add bad.ts
out="$(git commit -m bad-output 2>&1 || true)"
if printf '%s' "$out" | grep -q "$FAKE_SB"; then v=1; else v=0; fi
ok "17 hook output never prints the value" "$v" "0"
git reset -q --hard HEAD; rm -f bad.ts

# --- case 16: .env.example push passes (run last, clean tree) ---
printf '%s=\n' "$V_GEMINI" > .env.example; git add .env.example; git commit -qm env-example-push --no-verify
ok "16 .env.example push passes" "$(push main)" "0"

echo "---"
echo "PASS: $PASS FAIL: $FAIL (17 cases)"
[ "$FAIL" -eq 0 ]
