#!/usr/bin/env bash
# ============================================================================
# install-hooks.sh — iDECP Venture Builder Git Hook Installer
# Manifesto Reference: §6.3
#
# Installs a pre-push hook that wraps the quality gate in orchestrate.sh
# with self-healing on feature branches.
# ============================================================================
set -euo pipefail

HOOK_DIR=".git/hooks"
HOOK_FILE="$HOOK_DIR/pre-push"

if [[ ! -d ".git" ]]; then
    echo "ERROR: Not in a Git repository root. Run from project root."
    exit 1
fi

mkdir -p "$HOOK_DIR"

cat > "$HOOK_FILE" <<'HOOK'
#!/usr/bin/env bash
# ============================================================================
# pre-push hook — iDECP Orchestrator Pipeline
# Installed by: scripts/install-hooks.sh
# ============================================================================
set -euo pipefail

CURRENT_BRANCH=$(git branch --show-current)
SPEC_DIR="specs"

# ── Quality gate command (must match quality-gate.sh) ────────────────────────
QUALITY_CMD="./scripts/quality-gate.sh"

# ── Protected branches: run tests WITHOUT self-healing ───────────────────────
if [[ "$CURRENT_BRANCH" =~ ^(main|develop|release/.*)$ ]]; then
    echo "[orchestrator] Protected branch ($CURRENT_BRANCH) — running quality gates without healing."
    eval "$QUALITY_CMD"
    exit $?
fi

# ── Feature branches: run WITH self-healing ──────────────────────────────────
# Derive feature name from branch
FEATURE_NAME=$(echo "$CURRENT_BRANCH" | sed -E 's|^(feat\|fix)/||')
SPEC_PATH="${SPEC_DIR}/${FEATURE_NAME}/spec.md"

if [[ -f "$SPEC_PATH" ]]; then
    echo "[orchestrator] Spec found: $SPEC_PATH"
    ./scripts/orchestrate.sh "$QUALITY_CMD" --spec-ref "$SPEC_PATH"
else
    echo "[orchestrator] No spec found for branch '$FEATURE_NAME'. Running without spec context."
    ./scripts/orchestrate.sh "$QUALITY_CMD"
fi
HOOK

chmod +x "$HOOK_FILE"
echo "✓ Pre-push hook installed at $HOOK_FILE"

# ── Also install pre-commit for fast feedback (lint + typecheck only) ────────
PRECOMMIT_FILE="$HOOK_DIR/pre-commit"

cat > "$PRECOMMIT_FILE" <<'PCHOOK'
#!/usr/bin/env bash
# ============================================================================
# pre-commit hook — Fast quality check (no tests, no healing)
# Runs lint + typecheck only for fast feedback.
# ============================================================================
set -euo pipefail

# Detect staged files to scope the check
STAGED=$(git diff --cached --name-only --diff-filter=d)

if [[ -z "$STAGED" ]]; then
    exit 0
fi

echo "[orchestrator] Pre-commit: running fast quality checks on staged files..."

# ── CUSTOMIZE: Replace with your project's lint/typecheck commands ──
# Example Python:
#   ruff check $(echo "$STAGED" | grep '\.py$') 2>/dev/null || true
#   mypy --strict $(echo "$STAGED" | grep '\.py$') 2>/dev/null || true
#
# Example Rust:
#   cargo clippy --workspace -- -D warnings
#   cargo fmt --check
#
# Example TypeScript:
#   pnpm eslint $(echo "$STAGED" | grep '\.[tj]sx\?$')
#   pnpm tsc --noEmit

echo "[orchestrator] Pre-commit checks passed."
PCHOOK

chmod +x "$PRECOMMIT_FILE"
echo "✓ Pre-commit hook installed at $PRECOMMIT_FILE"

echo ""
echo "Done. Both hooks installed. Customize the commands inside:"
echo "  - $HOOK_FILE (pre-push: full quality gate + healing)"
echo "  - $PRECOMMIT_FILE (pre-commit: fast lint + typecheck)"
