#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMPDIR_BASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

passed=0
failed=0

assert_exit_zero() {
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "  PASS: $desc"
    ((passed++))
  else
    echo "  FAIL: $desc (expected exit 0)"
    ((failed++))
  fi
}

assert_exit_nonzero() {
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "  FAIL: $desc (expected non-zero exit)"
    ((failed++))
  else
    echo "  PASS: $desc"
    ((passed++))
  fi
}

assert_contains() {
  local desc="$1"
  local needle="$2"
  local output="$3"
  if echo "$output" | grep -qF "$needle"; then
    echo "  PASS: $desc"
    ((passed++))
  else
    echo "  FAIL: $desc (expected to contain '$needle')"
    echo "    output: $output"
    ((failed++))
  fi
}

assert_not_contains() {
  local desc="$1"
  local needle="$2"
  local output="$3"
  if echo "$output" | grep -qF "$needle"; then
    echo "  FAIL: $desc (expected NOT to contain '$needle')"
    echo "    output: $output"
    ((failed++))
  else
    echo "  PASS: $desc"
    ((passed++))
  fi
}

assert_line_count() {
  local desc="$1"
  local expected="$2"
  local output="$3"
  local actual
  if [[ -z "$output" ]]; then
    actual=0
  else
    actual=$(echo "$output" | wc -l | tr -d ' ')
  fi
  if [[ "$actual" -eq "$expected" ]]; then
    echo "  PASS: $desc"
    ((passed++))
  else
    echo "  FAIL: $desc (expected $expected lines, got $actual)"
    echo "    output: $output"
    ((failed++))
  fi
}

assert_matches() {
  local desc="$1"
  local pattern="$2"
  local output="$3"
  if echo "$output" | grep -qE "$pattern"; then
    echo "  PASS: $desc"
    ((passed++))
  else
    echo "  FAIL: $desc (expected to match '$pattern')"
    echo "    output: $output"
    ((failed++))
  fi
}

# Generate fixture
HISTFILE="$TMPDIR_BASE/history"
cat > "$HISTFILE" << 'FIXTURE'
: 1700000000:0;git status
: 1700000100:0;git commit -m 'initial'
: 1700000200:0;git push --force
: 1700000300:0;git status
: 1700000400:0;docker build -t app .
: 1700000500:0;git log --oneline
: 1700000600:0;npm test && npm run build
: 1700000700:0;git add . && git commit -m 'fix'
: 1700000800:0;cat foo | grep bar
: 1700000900:0;git status
: 1700001000:0;c++ -o main main.cpp
: 1700001100:0;./run.sh
continuation line without timestamp prefix
: 1700001200:0;git push
FIXTURE

EMPTY_HISTFILE="$TMPDIR_BASE/empty_history"
cat > "$EMPTY_HISTFILE" << 'FIXTURE'
: 1700000000:0;echo hello
: 1700000100:0;echo world
FIXTURE

# ── common.sh ──

echo "common.sh"

source "$SCRIPT_DIR/common.sh"

desc="duration_to_cutoff returns epoch in the past"
cutoff=$(duration_to_cutoff "6m")
now=$(date +%s)
if [[ "$cutoff" -lt "$now" && "$cutoff" -gt 0 ]]; then
  echo "  PASS: $desc"
  ((passed++))
else
  echo "  FAIL: $desc (cutoff=$cutoff, now=$now)"
  ((failed++))
fi

desc="format_epoch formats known epoch"
result=$(format_epoch 1700000000)
assert_matches "$desc" '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' "$result"

desc="extract_commands with missing file exits non-zero"
assert_exit_nonzero "$desc" extract_commands "$TMPDIR_BASE/nonexistent"

desc="require_arg exits non-zero when argc < 2"
assert_exit_nonzero "$desc" bash -c "source '$SCRIPT_DIR/common.sh'; require_arg --foo 1"

# ── history-freq.sh ──

echo "history-freq.sh"

desc="all-time frequency: git is most frequent"
output=$(HISTFILE="$HISTFILE" "$SCRIPT_DIR/history-freq.sh")
first_cmd=$(echo "$output" | head -1 | awk '{print $2}')
assert_contains "$desc" "git" "$first_cmd"

desc="date range outputs valid format"
output=$(HISTFILE="$HISTFILE" "$SCRIPT_DIR/history-freq.sh" --date-range)
assert_matches "$desc" '[0-9]{4}-[0-9]{2}-[0-9]{2} to [0-9]{4}-[0-9]{2}-[0-9]{2}' "$output"

desc="count limit -n 3 returns exactly 3 lines"
output=$(HISTFILE="$HISTFILE" "$SCRIPT_DIR/history-freq.sh" -n 3)
assert_line_count "$desc" 3 "$output"

desc="continuation lines excluded"
output=$(HISTFILE="$HISTFILE" "$SCRIPT_DIR/history-freq.sh")
assert_not_contains "$desc" "continuation" "$output"

desc="missing arg for --recent exits non-zero"
assert_exit_nonzero "$desc" env HISTFILE="$HISTFILE" "$SCRIPT_DIR/history-freq.sh" --recent

# ── history-args.sh ──

echo "history-args.sh"

desc="git section includes status as top pattern"
output=$(HISTFILE="$HISTFILE" "$SCRIPT_DIR/history-args.sh")
assert_contains "$desc" "status" "$output"

desc="count limit -n 2 limits to 2 command sections"
output=$(HISTFILE="$HISTFILE" "$SCRIPT_DIR/history-args.sh" -n 2)
section_count=$(echo "$output" | grep -c '^===' || true)
if [[ "$section_count" -eq 2 ]]; then
  echo "  PASS: $desc"
  ((passed++))
else
  echo "  FAIL: $desc (expected 2 sections, got $section_count)"
  ((failed++))
fi

desc="regex-safe: c++ appears as section header"
output=$(HISTFILE="$HISTFILE" "$SCRIPT_DIR/history-args.sh" -n 20)
assert_contains "$desc" "=== c++ ===" "$output"

desc="continuation lines excluded"
output=$(HISTFILE="$HISTFILE" "$SCRIPT_DIR/history-args.sh")
assert_not_contains "$desc" "continuation" "$output"

# ── history-sequences.sh ──

echo "history-sequences.sh"

desc="finds && and | chains"
output=$(HISTFILE="$HISTFILE" "$SCRIPT_DIR/history-sequences.sh")
assert_contains "$desc finds &&" "&&" "$output"
assert_contains "$desc finds |" "|" "$output"

desc="empty result exits 0"
assert_exit_zero "$desc" env HISTFILE="$EMPTY_HISTFILE" "$SCRIPT_DIR/history-sequences.sh"

desc="count limit -n 1 returns exactly 1 line"
output=$(HISTFILE="$HISTFILE" "$SCRIPT_DIR/history-sequences.sh" -n 1)
assert_line_count "$desc" 1 "$output"

# ── Results ──

echo ""
echo "Results: $passed passed, $failed failed"
[[ $failed -eq 0 ]]
