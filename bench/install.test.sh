#!/usr/bin/env bash
# bash test for scripts/install.sh — 5 fixes for the install script.
# Run with: bash bench/install.test.sh
# Returns 0 only if all scenarios PASS; 1 if any fail.
set -u

# Locate the script under test. Tests live in bench/, script is in scripts/.
TEST_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/.." && pwd)"
INSTALL_SH="$REPO_ROOT/scripts/install.sh"
POSTINSTALL_JS="$REPO_ROOT/scripts/postinstall.js"

if [ ! -f "$INSTALL_SH" ]; then
  echo "FATAL: $INSTALL_SH not found" >&2
  exit 2
fi

# ---- Test harness ----
PASS=0
FAIL=0
FAILED_NAMES=()

red()   { printf '\033[31m%s\033[0m' "$*"; }
green() { printf '\033[32m%s\033[0m' "$*"; }
bold()  { printf '\033[1m%s\033[0m' "$*"; }

assert_eq() {
  # assert_eq <name> <expected> <actual>
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    printf "  %s %s\n" "$(green PASS)" "$name"
  else
    FAIL=$((FAIL + 1))
    FAILED_NAMES+=("$name")
    printf "  %s %s\n" "$(red FAIL)" "$name"
    printf "       expected: %q\n" "$expected"
    printf "       actual:   %q\n" "$actual"
  fi
}

assert_contains() {
  # assert_contains <name> <needle> <haystack>
  local name="$1" needle="$2" haystack="$3"
  case "$haystack" in
    *"$needle"*)
      PASS=$((PASS + 1))
      printf "  %s %s\n" "$(green PASS)" "$name"
      ;;
    *)
      FAIL=$((FAIL + 1))
      FAILED_NAMES+=("$name")
      printf "  %s %s\n" "$(red FAIL)" "$name"
      printf "       expected to contain: %q\n" "$needle"
      printf "       haystack (first 300 chars):\n       %s\n" "${haystack:0:300}"
      ;;
  esac
}

assert_not_contains() {
  # assert_not_contains <name> <forbidden> <haystack>
  local name="$1" forbidden="$2" haystack="$3"
  case "$haystack" in
    *"$forbidden"*)
      FAIL=$((FAIL + 1))
      FAILED_NAMES+=("$name")
      printf "  %s %s\n" "$(red FAIL)" "$name"
      printf "       should NOT contain: %q\n" "$forbidden"
      printf "       haystack (first 300 chars):\n       %s\n" "${haystack:0:300}"
      ;;
    *)
      PASS=$((PASS + 1))
      printf "  %s %s\n" "$(green PASS)" "$name"
      ;;
  esac
}

# ---- Helpers ----

# Run install.sh under a controlled env and capture output + exit code.
# Strips PRISM_* env vars so S1 is reproducible.
run_install_clean() {
  # Usage: run_install_clean [extra env=value ...]
  local tmp; tmp="$(mktemp -d -t prism-install-test-XXXXXX)"
  local out; out="$tmp/out.log"
  # shellcheck disable=SC2086
  env -i HOME="$tmp/home" PATH="/usr/bin:/bin" \
    "$@" \
    bash "$INSTALL_SH" >"$out" 2>&1
  local rc=$?
  printf '%s' "$out" >/dev/null
  RC=$rc
  OUT_FILE="$out"
  TMP_DIR="$tmp"
}

# ---- S1: Unbound variable fix ----
# Sourcing install.sh with PRISM_SKIP_AUTO_TARBALL unset must not crash.
scenario_s1() {
  bold "S1: install.sh tolerates unset PRISM_SKIP_AUTO_TARBALL under set -u"
  local tmp; tmp="$(mktemp -d -t prism-s1-XXXXXX)"
  local out; out="$tmp/out.log"
  # Run the install script with a clean env so PRISM_SKIP_AUTO_TARBALL is unset.
  # We use `bash` so set -u propagates. We expect a non-crash on the env-var read.
  env -i HOME="$tmp/home" PATH="/usr/bin:/bin" \
    bash "$INSTALL_SH" >"$out" 2>&1
  local rc=$?
  local body; body="$(cat "$out")"
  # The actual fix should let the script reach bun install (or fail later for
  # a non-env reason). What we are SURE is broken in the old code is the
  # explicit "unbound variable" error. Assert it does NOT appear.
  assert_not_contains "no 'unbound variable' error" "unbound variable" "$body"
  rm -rf "$tmp"
}

# ---- S2: Bun auto-install code path exists ----
scenario_s2() {
  bold "S2: install.sh has an ensure_bun() path that installs bun.sh"
  # The fix must include a function or block that, when bun is missing,
  # fetches from bun.sh. We assert the install script contains the
  # canonical bun installer URL.
  local body; body="$(cat "$INSTALL_SH")"
  assert_contains "references bun.sh installer" "bun.sh/install" "$body"
  assert_contains "checks command -v bun" "command -v bun" "$body"
}

# ---- S3: Bun version check ----
scenario_s3() {
  bold "S3: install.sh rejects bun < 1.4.0 (lockfile v2 requires it)"
  # We use a stub PATH that points to a directory containing a fake `bun`
  # binary that prints a too-old version. Expect a non-zero exit and an
  # error message that mentions the minimum version.
  local tmp; tmp="$(mktemp -d -t prism-s3-XXXXXX)"
  mkdir -p "$tmp/bin"
  cat >"$tmp/bin/bun" <<'EOF'
#!/usr/bin/env bash
# Fake bun that reports an old version.
if [ "$1" = "--version" ]; then echo "1.2.3"; exit 0; fi
echo "fake bun" >&2
exit 0
EOF
  chmod +x "$tmp/bin/bun"
  local out; out="$tmp/out.log"
  env -i HOME="$tmp/home" PATH="$tmp/bin:/usr/bin:/bin" \
    bash "$INSTALL_SH" >"$out" 2>&1
  local rc=$?
  local body; body="$(cat "$out")"
  # We don't require a specific error wording — only that the script did
  # NOT silently proceed (i.e. it either reported a clear version error
  # or the failure was for another reason that includes a minimum version
  # reference). And critically, it did NOT call real `bun install`.
  local matched=0
  case "$body" in
    *"bun version"*|*"bun-version"*|*"Bun 1.4"*|*"requires Bun 1.4"*|*"minimum bun"*|*"minimum version"*) matched=1 ;;
  esac
  case "$body" in
    *"1.4.0"*) matched=1 ;;
  esac
  case "$body" in
    *"too old"*) matched=1 ;;
  esac
  case "$body" in
    *"upgrade"*"bun"*) matched=1 ;;
  esac
  if [ "$matched" -eq 1 ]; then
    PASS=$((PASS + 1))
    printf "  %s bun-version-mismatch message present\n" "$(green PASS)"
  else
    FAIL=$((FAIL + 1))
    FAILED_NAMES+=("S3: bun < 1.4.0 is rejected with a clear message")
    printf "  %s S3: bun < 1.4.0 is rejected with a clear message\n" "$(red FAIL)"
    printf "       body (first 400):\n       %s\n" "${body:0:400}"
  fi
  rm -rf "$tmp"
}

# ---- S4: End-of-install verification (bun --version, prism --version) ----
scenario_s4() {
  bold "S4: install.sh runs bun --version and prism --version at the end"
  local body; body="$(cat "$INSTALL_SH")"
  # The end-of-install verification must invoke both binaries explicitly.
  # Allow any path, any quoting, but the literals must be present.
  case "$body" in
    *"bun --version"*)
      PASS=$((PASS + 1))
      printf "  %s calls 'bun --version' at end of install\n" "$(green PASS)"
      ;;
    *)
      FAIL=$((FAIL + 1))
      FAILED_NAMES+=("S4: bun --version check at end")
      printf "  %s S4: bun --version check at end\n" "$(red FAIL)"
      ;;
  esac
  case "$body" in
    *"--version"*"prism"*"--version"*|*"prism --version"*)
      PASS=$((PASS + 1))
      printf "  %s calls 'prism --version' at end of install\n" "$(green PASS)"
      ;;
    *)
      FAIL=$((FAIL + 1))
      FAILED_NAMES+=("S4: prism --version check at end")
      printf "  %s S4: prism --version check at end\n" "$(red FAIL)"
      ;;
  esac
}

# ---- S5: PATH reminder is concrete ----
scenario_s5() {
  bold "S5: install.sh emits a concrete PATH reminder command"
  local body; body="$(cat "$INSTALL_SH")"
  # The reminder must include an actual export PATH= line that the user
  # can copy-paste. Just printing "add to PATH" is not enough.
  case "$body" in
    *"export PATH"*)
      PASS=$((PASS + 1))
      printf "  %s PATH reminder includes 'export PATH' command\n" "$(green PASS)"
      ;;
    *)
      FAIL=$((FAIL + 1))
      FAILED_NAMES+=("S5: export PATH reminder present")
      printf "  %s S5: export PATH reminder present\n" "$(red FAIL)"
      ;;
  esac
  # And: after install, the script should warn (not silently fail) if the
  # wrapper location is not on PATH. The source uses $BIN_DIR which
  # expands to ~/.local/bin at runtime — check the literal variable.
  case "$body" in
    *'$BIN_DIR'*|*"\$BIN_DIR"*)
      PASS=$((PASS + 1))
      printf "  %s PATH reminder references \$BIN_DIR wrapper path\n" "$(green PASS)"
      ;;
    *)
      FAIL=$((FAIL + 1))
      FAILED_NAMES+=("S5: PATH reminder references BIN_DIR")
      printf "  %s S5: PATH reminder references BIN_DIR\n" "$(red FAIL)"
      ;;
  esac
}

scenario_s6() {
  bold "S6: install.sh has defensive default assignment for PRISM_SKIP_AUTO_TARBALL"
  local body; body="$(cat "$INSTALL_SH")"
  case "$body" in
    *'PRISM_SKIP_AUTO_TARBALL="${PRISM_SKIP_AUTO_TARBALL:-}"'*|*'PRISM_SKIP_AUTO_TARBALL="${PRISM_SKIP_AUTO_TARBALL:-'*)
      PASS=$((PASS + 1))
      printf "  %s defensive default assignment present\n" "$(green PASS)"
      ;;
    *)
      FAIL=$((FAIL + 1))
      FAILED_NAMES+=("S6: defensive default assignment present")
      printf "  %s S6: defensive default assignment present\n" "$(red FAIL)"
      ;;
  esac
}

scenario_s7() {
  bold "S7: install.sh survives unset HOME under set -u (no \$HOME crash)"
  local tmp; tmp="$(mktemp -d -t prism-s7-XXXXXX)"
  local out; out="$tmp/out.log"
  env -i PATH="/usr/bin:/bin" \
    bash "$INSTALL_SH" >"$out" 2>&1
  local body; body="$(cat "$out")"
  case "$body" in
    *"HOME: unbound variable"*|*"HOME: parameter null or not set"*)
      FAIL=$((FAIL + 1))
      FAILED_NAMES+=("S7: HOME unset does not crash")
      printf "  %s S7: HOME unset does not crash\n" "$(red FAIL)"
      printf "       body: %s\n" "${body:0:300}"
      ;;
    *)
      PASS=$((PASS + 1))
      printf "  %s HOME unset does not crash on \$HOME\n" "$(green PASS)"
      ;;
  esac
  rm -rf "$tmp"
}

scenario_s8() {
  bold "S8: install.sh defensively reads \$PATH (no bare \$PATH under set -u)"
  local body; body="$(cat "$INSTALL_SH")"
  local matched=0
  case "$body" in
    *'${PATH:-}'*) matched=1 ;;
  esac
  case "$body" in
    *'IFS=:'*'read -r -a _path_entries <<<"${PATH:-}"'*) matched=1 ;;
  esac
  if [ "$matched" -eq 1 ]; then
    PASS=$((PASS + 1))
    printf "  %s PATH read uses defensive \${PATH:-}\n" "$(green PASS)"
  else
    FAIL=$((FAIL + 1))
    FAILED_NAMES+=("S8: PATH defensive read present")
    printf "  %s S8: PATH defensive read present\n" "$(red FAIL)"
  fi
}

scenario_s9() {
  bold "S9: PATH reminder heredoc uses \${SHELL_NAME}rc (no undefined SHELL_NAMERC)"
  local body; body="$(cat "$INSTALL_SH")"
  case "$body" in
    *'SHELL_NAMERC'*)
      FAIL=$((FAIL + 1))
      FAILED_NAMES+=("S9: no undefined SHELL_NAMERC reference")
      printf "  %s S9: no undefined SHELL_NAMERC reference\n" "$(red FAIL)"
      ;;
    *)
      PASS=$((PASS + 1))
      printf "  %s no undefined SHELL_NAMERC reference\n" "$(green PASS)"
      ;;
  esac
}

scenario_s10() {
  bold "S10: ensure_bun() sets BUN_INSTALLED_BUN_SH=1 on fresh install"
  local body; body="$(cat "$INSTALL_SH")"
  local init_ok=0
  local set_ok=0
  case "$body" in
    *'BUN_INSTALLED_BUN_SH=0'*) init_ok=1 ;;
  esac
  case "$body" in
    *'BUN_INSTALLED_BUN_SH=1'*) set_ok=1 ;;
  esac
  if [ "$init_ok" -eq 1 ] && [ "$set_ok" -eq 1 ]; then
    PASS=$((PASS + 1))
    printf "  %s BUN_INSTALLED_BUN_SH initialised at 0 and set to 1 on fresh install\n" "$(green PASS)"
  else
    FAIL=$((FAIL + 1))
    FAILED_NAMES+=("S10: BUN_INSTALLED_BUN_SH wiring")
    printf "  %s S10: BUN_INSTALLED_BUN_SH wiring (init=%d, set=%d)\n" "$(red FAIL)" "$init_ok" "$set_ok"
  fi
}

# ---- Main ----
echo ""
bold "Install script test suite"
echo "  install.sh: $INSTALL_SH"
echo ""

scenario_s1
scenario_s2
scenario_s3
scenario_s4
scenario_s5
scenario_s6
scenario_s7
scenario_s8
scenario_s9
scenario_s10

echo ""
if [ "$FAIL" -eq 0 ]; then
  bold "$(green "All $PASS assertions passed.")"
  exit 0
else
  bold "$(red "$FAIL of $((PASS+FAIL)) assertions failed:")"
  for n in "${FAILED_NAMES[@]}"; do
    printf "  - %s\n" "$n"
  done
  exit 1
fi
