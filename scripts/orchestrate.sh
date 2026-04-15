#!/usr/bin/env bash
# ============================================================================
# orchestrate.sh — iDECP Venture Builder Self-Healing Pipeline
# Manifesto Reference: §6.2
#
# Wraps any command in a bounded self-healing loop.
# Stack-agnostic. Agent-agnostic (supports $AGENT_CLI failover).
# ============================================================================
set -euo pipefail
trap cleanup EXIT INT TERM

# ── Defaults ─────────────────────────────────────────────────────────────────
MAX_RETRIES=3
TIMEOUT=60
SPEC_REF=""
SCOPE_LOCK=""
HEAL_DIR=".claude/heal-failures"
HEAL_LOG_DIR=".claude/heal-logs"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
TMPDIR_HEAL=$(mktemp -d)

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# ── Agent Resolution (§4.5.2 Failover Protocol) ─────────────────────────────
resolve_agent() {
    if [[ -n "${AGENT_CLI:-}" ]]; then
        echo "$AGENT_CLI"
    elif [[ -f ".env" ]] && grep -q "^AGENT_CLI=" .env 2>/dev/null; then
        grep "^AGENT_CLI=" .env | cut -d'=' -f2 | tr -d '"' | tr -d "'"
    else
        echo "claude"
    fi
}

ACTIVE_AGENT=$(resolve_agent)

# ── Cleanup ──────────────────────────────────────────────────────────────────
cleanup() {
    rm -rf "$TMPDIR_HEAL"
}

# ── Usage ────────────────────────────────────────────────────────────────────
usage() {
    cat <<EOF
Usage: ./scripts/orchestrate.sh <command> [OPTIONS]

Arguments:
  <command>           Quoted shell command to execute.

Options:
  --max-retries N     Maximum healing attempts (default: 3)
  --spec-ref PATH     Path to relevant spec.md for context injection
  --timeout SECS      Per-attempt timeout for healing agent (default: 60)
  --scope-lock PATHS  Comma-separated dirs the healer may modify

Environment:
  AGENT_CLI           Active executor: "claude" (default) or "gemini"

Exit Codes:
  0 — Command succeeded (possibly after healing)
  1 — Healing exhausted, escalation created
  2 — Invalid arguments or missing dependencies
EOF
    exit 2
}

# ── Argument Parsing ─────────────────────────────────────────────────────────
if [[ $# -lt 1 ]]; then
    usage
fi

COMMAND="$1"
shift

while [[ $# -gt 0 ]]; do
    case "$1" in
        --max-retries) MAX_RETRIES="$2"; shift 2 ;;
        --spec-ref)    SPEC_REF="$2";    shift 2 ;;
        --timeout)     TIMEOUT="$2";     shift 2 ;;
        --scope-lock)  SCOPE_LOCK="$2";  shift 2 ;;
        -h|--help)     usage ;;
        *) echo -e "${RED}[orchestrator] Unknown option: $1${NC}"; usage ;;
    esac
done

# ── Dependency Check ─────────────────────────────────────────────────────────
check_dependencies() {
    if ! command -v "$ACTIVE_AGENT" &>/dev/null; then
        echo -e "${RED}[orchestrator] ERROR: '$ACTIVE_AGENT' CLI not found in PATH.${NC}"
        echo -e "${YELLOW}[orchestrator] Install it or set AGENT_CLI to an available agent.${NC}"
        exit 2
    fi
}

check_dependencies

# ── Directory Setup ──────────────────────────────────────────────────────────
mkdir -p "$HEAL_DIR" "$HEAL_LOG_DIR"

# ── Logging ──────────────────────────────────────────────────────────────────
log_info()  { echo -e "${CYAN}[orchestrator]${NC} $*"; }
log_ok()    { echo -e "${GREEN}[orchestrator]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[orchestrator]${NC} $*"; }
log_fail()  { echo -e "${RED}[orchestrator]${NC} $*"; }

# ── Extract Structured Error Context ─────────────────────────────────────────
extract_error_context() {
    local output_file="$1"
    local context_file="$TMPDIR_HEAL/error_context.txt"

    cat > "$context_file" <<CONTEXT
## Structured Error Context

### Exit Code
$(cat "$TMPDIR_HEAL/exit_code")

### Failing Output (last 200 lines)
\`\`\`
$(tail -200 "$output_file")
\`\`\`

### Potential Failing Files (extracted from traceback)
$(grep -oP '(?:File "|src/|tests/|lib/|crates/)[\w/._-]+' "$output_file" 2>/dev/null | sort -u || echo "No files extracted from traceback")

### Potential Failing Tests (extracted from output)
$(grep -iP '(FAIL|ERROR|FAILED|panicked).*?(\w+::\w+|\w+\.test|\w+_test)' "$output_file" 2>/dev/null | head -20 || echo "No test names extracted")
CONTEXT

    echo "$context_file"
}

# ── Build Healing Prompt ─────────────────────────────────────────────────────
build_healing_prompt() {
    local error_context_file="$1"
    local attempt="$2"
    local prompt_file="$TMPDIR_HEAL/heal_prompt_${attempt}.txt"

    cat > "$prompt_file" <<PROMPT
You are in HEAL mode. A test or build has failed. Your ONLY task is to fix the specific failure described below.

RULES:
- Fix ONLY the described failure.
- Do NOT refactor surrounding code.
- Do NOT add features or capabilities.
- Do NOT modify test files unless the test itself is demonstrably incorrect (explain why in a comment).
- Do NOT install or update dependencies.
- Do NOT modify any files outside the scope lock.
- Make the MINIMUM change necessary to pass.

PROMPT

    # Inject spec context if available
    if [[ -n "$SPEC_REF" && -f "$SPEC_REF" ]]; then
        cat >> "$prompt_file" <<PROMPT
SPEC CONTEXT:
\`\`\`
$(cat "$SPEC_REF")
\`\`\`

PROMPT
    fi

    # Inject scope lock
    if [[ -n "$SCOPE_LOCK" ]]; then
        cat >> "$prompt_file" <<PROMPT
SCOPE-LOCKED FILES (you may ONLY modify files in these directories):
$SCOPE_LOCK

PROMPT
    fi

    # Inject error context
    cat >> "$prompt_file" <<PROMPT
FAILURE CONTEXT:
$(cat "$error_context_file")

ATTEMPT: $attempt of $MAX_RETRIES
PROMPT

    # Inject previous attempts if retry > 1
    if [[ "$attempt" -gt 1 ]]; then
        cat >> "$prompt_file" <<PROMPT

PREVIOUS ATTEMPTS (all failed — try a DIFFERENT approach):
PROMPT
        for prev in $(seq 1 $((attempt - 1))); do
            if [[ -f "$TMPDIR_HEAL/heal_diff_${prev}.txt" ]]; then
                cat >> "$prompt_file" <<PROMPT

--- Attempt $prev Diff ---
$(cat "$TMPDIR_HEAL/heal_diff_${prev}.txt")

--- Attempt $prev Result ---
$(cat "$TMPDIR_HEAL/heal_result_${prev}.txt" 2>/dev/null || echo "No result captured")

PROMPT
            fi
        done
    fi

    cat >> "$prompt_file" <<PROMPT

INSTRUCTION: Fix the failing code. After making changes, run the following command to verify:
$COMMAND
PROMPT

    echo "$prompt_file"
}

# ── Run Command ──────────────────────────────────────────────────────────────
run_command() {
    local output_file="$TMPDIR_HEAL/command_output.txt"
    local exit_code=0

    log_info "Running: $COMMAND"

    eval "$COMMAND" > "$output_file" 2>&1 || exit_code=$?
    echo "$exit_code" > "$TMPDIR_HEAL/exit_code"

    # Mirror output to terminal
    cat "$output_file"

    return "$exit_code"
}

# ── Heal Attempt ─────────────────────────────────────────────────────────────
heal_attempt() {
    local attempt="$1"
    local output_file="$TMPDIR_HEAL/command_output.txt"

    log_warn "Healing attempt $attempt of $MAX_RETRIES [executor: $ACTIVE_AGENT]"

    # Extract structured error
    local error_context
    error_context=$(extract_error_context "$output_file")

    # Build prompt
    local prompt_file
    prompt_file=$(build_healing_prompt "$error_context" "$attempt")

    # Log the prompt for audit
    cp "$prompt_file" "$HEAL_LOG_DIR/prompt_${TIMESTAMP}_attempt${attempt}.txt"

    # Capture pre-heal diff for tracking
    git diff > "$TMPDIR_HEAL/pre_heal_${attempt}.diff" 2>/dev/null || true

    # Invoke the agent
    log_info "Invoking $ACTIVE_AGENT in headless mode..."

    local agent_exit=0
    if [[ "$ACTIVE_AGENT" == "claude" ]]; then
        timeout "${TIMEOUT}s" "$ACTIVE_AGENT" -p "$(cat "$prompt_file")" \
            --allowedTools bash,edit,read \
            > "$HEAL_LOG_DIR/response_${TIMESTAMP}_attempt${attempt}.txt" 2>&1 || agent_exit=$?
    elif [[ "$ACTIVE_AGENT" == "gemini" ]]; then
        # Gemini CLI prompt mode (adjust flags as Gemini CLI evolves)
        timeout "${TIMEOUT}s" "$ACTIVE_AGENT" -p "$(cat "$prompt_file")" \
            > "$HEAL_LOG_DIR/response_${TIMESTAMP}_attempt${attempt}.txt" 2>&1 || agent_exit=$?
    else
        log_fail "Unknown agent: $ACTIVE_AGENT"
        return 1
    fi

    if [[ "$agent_exit" -eq 124 ]]; then
        log_warn "Healing attempt $attempt timed out after ${TIMEOUT}s."
    fi

    # Capture post-heal diff
    git diff > "$TMPDIR_HEAL/heal_diff_${attempt}.txt" 2>/dev/null || true

    # Re-run the command
    log_info "Re-running command after heal attempt $attempt..."
    local rerun_exit=0
    eval "$COMMAND" > "$TMPDIR_HEAL/rerun_output_${attempt}.txt" 2>&1 || rerun_exit=$?

    # Save result for future attempt context
    tail -50 "$TMPDIR_HEAL/rerun_output_${attempt}.txt" > "$TMPDIR_HEAL/heal_result_${attempt}.txt"

    if [[ "$rerun_exit" -eq 0 ]]; then
        log_ok "Heal attempt $attempt SUCCEEDED."
        cat "$TMPDIR_HEAL/rerun_output_${attempt}.txt"

        # Auto-commit the fix
        local scope
        scope=$(basename "$(pwd)")
        git add -A
        git commit -m "fix(${scope}): auto-heal [attempt ${attempt}/${MAX_RETRIES}] [executor:${ACTIVE_AGENT}]" \
            --no-verify 2>/dev/null || true

        return 0
    else
        log_fail "Heal attempt $attempt FAILED. Exit code: $rerun_exit"
        # Update command output for next iteration
        cp "$TMPDIR_HEAL/rerun_output_${attempt}.txt" "$TMPDIR_HEAL/command_output.txt"
        echo "$rerun_exit" > "$TMPDIR_HEAL/exit_code"
        return 1
    fi
}

# ── Generate Escalation Report ───────────────────────────────────────────────
generate_escalation() {
    local report_file="$HEAL_DIR/escalation_${TIMESTAMP}.md"

    cat > "$report_file" <<REPORT
# Healing Failure Report

**Timestamp:** $(date -Iseconds)
**Executor:** $ACTIVE_AGENT
**Command:** \`$COMMAND\`
**Spec Reference:** ${SPEC_REF:-"None provided"}
**Max Retries:** $MAX_RETRIES
**All retries exhausted.**

## Original Error

\`\`\`
$(head -100 "$TMPDIR_HEAL/command_output.txt" 2>/dev/null || echo "No output captured")
\`\`\`

REPORT

    for attempt in $(seq 1 "$MAX_RETRIES"); do
        if [[ -f "$TMPDIR_HEAL/heal_diff_${attempt}.txt" ]]; then
            cat >> "$report_file" <<ATTEMPT

## Attempt $attempt

### Patch Applied
\`\`\`diff
$(cat "$TMPDIR_HEAL/heal_diff_${attempt}.txt")
\`\`\`

### Result After Patch
\`\`\`
$(cat "$TMPDIR_HEAL/heal_result_${attempt}.txt" 2>/dev/null || echo "No result captured")
\`\`\`

ATTEMPT
        fi
    done

    cat >> "$report_file" <<FOOTER

## Suggested Classification

- [ ] Spec ambiguity — acceptance criterion is unclear or contradictory
- [ ] Architectural gap — fix requires design change beyond spec scope
- [ ] Environment / toolchain issue — dependency, OS, or config problem
- [ ] Agent context limitation — problem exceeds agent's context window
- [ ] Spec overreach — single AC touches too many boundaries

## Action Required

Visionary must classify the root cause per §9.1 and respond:
- Spec ambiguity → refine spec, re-tag, re-execute from Phase 3.
- Architectural gap → return to Phase 1, update spec + MCP modules.
- Environment issue → fix environment, re-run pipeline.
- Context limitation → decompose feature into smaller specs.
FOOTER

    log_fail "Escalation report written to: $report_file"

    # Attempt to create GitHub Issue if gh CLI available
    if command -v gh &>/dev/null; then
        log_info "Creating GitHub Issue..."
        gh issue create \
            --title "[auto-heal-failed] $(basename "$(pwd)") — $TIMESTAMP" \
            --body "$(cat "$report_file")" \
            --label "auto-heal-failed" \
            2>/dev/null || log_warn "Could not create GitHub Issue (not in a GH repo?)"
    fi
}

# ── Main Loop ────────────────────────────────────────────────────────────────
main() {
    log_info "═══════════════════════════════════════════════════"
    log_info "  iDECP Orchestrator Pipeline"
    log_info "  Active executor: $ACTIVE_AGENT$([ "$ACTIVE_AGENT" != "claude" ] && echo ' (failover)')"
    log_info "  Command: $COMMAND"
    log_info "  Max retries: $MAX_RETRIES"
    log_info "  Timeout per attempt: ${TIMEOUT}s"
    [[ -n "$SPEC_REF" ]] && log_info "  Spec: $SPEC_REF"
    log_info "═══════════════════════════════════════════════════"

    # First run
    if run_command; then
        log_ok "Command succeeded on first run."
        exit 0
    fi

    log_fail "Command failed. Entering self-healing loop."

    # Healing loop
    for attempt in $(seq 1 "$MAX_RETRIES"); do
        if heal_attempt "$attempt"; then
            log_ok "═══════════════════════════════════════════════════"
            log_ok "  Pipeline recovered after $attempt healing attempt(s)."
            log_ok "═══════════════════════════════════════════════════"
            exit 0
        fi
    done

    # All retries exhausted
    log_fail "═══════════════════════════════════════════════════"
    log_fail "  All $MAX_RETRIES healing attempts exhausted."
    log_fail "  Generating escalation report..."
    log_fail "═══════════════════════════════════════════════════"

    generate_escalation

    # Revert any partial heal changes
    log_warn "Reverting uncommitted heal attempts..."
    git checkout -- . 2>/dev/null || true

    exit 1
}

main
