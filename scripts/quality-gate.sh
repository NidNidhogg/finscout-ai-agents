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

run_gate "Lint"   "npm run lint"
run_gate "Tests"  "npm run test"
run_gate "Build"  "npm run build"

echo "═══════════════════════════════════════════════"
echo -e "  ${GREEN}All $TOTAL gates passed.${NC}"
echo "═══════════════════════════════════════════════"
