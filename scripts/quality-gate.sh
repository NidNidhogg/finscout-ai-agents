#!/usr/bin/env bash
# ============================================================================
# quality-gate.sh — iDECP Venture Builder Quality Gate Chain
# Manifesto Reference: §4.4 (Quality Gate Chain)
#
# !! TEMPLATE — Customize the commands below for your project stack. !!
#
# This script runs every quality gate in order. All must pass.
# Called by orchestrate.sh, Git hooks, and CI.
# ============================================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

PASSED=0
FAILED=0
TOTAL=0

run_gate() {
    local name="$1"
    local cmd="$2"
    TOTAL=$((TOTAL + 1))

    echo -e "${CYAN}[gate ${TOTAL}]${NC} $name"
    echo -e "         → $cmd"

    if eval "$cmd"; then
        echo -e "         ${GREEN}[PASS]${NC} $name"
        PASSED=$((PASSED + 1))
    else
        echo -e "         ${RED}[FAIL]${NC} $name"
        FAILED=$((FAILED + 1))
        # Fail fast — stop on first failure
        echo ""
        echo -e "${RED}Quality gate failed at: $name${NC}"
        echo -e "Fix this before proceeding."
        exit 1
    fi
    echo ""
}

echo "═══════════════════════════════════════════════"
echo "  iDECP Quality Gate Chain"
echo "═══════════════════════════════════════════════"
echo ""

# ── CUSTOMIZE THESE FOR YOUR PROJECT STACK ───────────────────────────────────
#
# Uncomment and edit the section matching your stack.
# The order matters: tests first, then static analysis, then security.
#
# ── Python Example ──
# run_gate "Tests"           "pytest tests/ -x --tb=short"
# run_gate "Linter"          "ruff check src/"
# run_gate "Type Check"      "mypy --strict src/"
# run_gate "Security Scan"   "bandit -r src/ -q"
# run_gate "Dep Audit"       "pip-audit"

# ── Rust Example ──
# run_gate "Tests"           "cargo test --workspace"
# run_gate "Linter"          "cargo clippy --workspace -- -D warnings"
# run_gate "Format Check"    "cargo fmt --check"
# run_gate "Security Scan"   "cargo audit"
# run_gate "Dep Check"       "cargo deny check"

# ── TypeScript Example ──
# run_gate "Tests"           "pnpm vitest run"
# run_gate "Linter"          "pnpm eslint src/"
# run_gate "Type Check"      "pnpm tsc --noEmit"
# run_gate "Security Scan"   "pnpm audit --audit-level=high"

# ── Solidity Example ──
# run_gate "Tests"           "forge test -vvv"
# run_gate "Linter"          "solhint 'contracts/**/*.sol'"
# run_gate "Security Scan"   "slither ."

# ── REMOVE THIS BLOCK AFTER CUSTOMIZING ──
echo -e "${RED}ERROR: quality-gate.sh has not been customized.${NC}"
echo "Edit scripts/quality-gate.sh and uncomment/add your project's gates."
exit 2
# ── END REMOVE ──

echo "═══════════════════════════════════════════════"
echo -e "  ${GREEN}All $TOTAL gates passed.${NC}"
echo "═══════════════════════════════════════════════"
