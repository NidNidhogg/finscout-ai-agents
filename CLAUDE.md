# CLAUDE.md — [PROJECT NAME]
# Inherits: ~/.claude/CLAUDE.md (iDECP Global Orchestrator Protocol)

## Execution Environment

- Language:        <!-- e.g., Rust 1.78, TypeScript 5.4, Python 3.12, Solidity 0.8.24 -->
- Runtime:         <!-- e.g., tokio, Node.js 22, EVM, CPython -->
- Package Manager: <!-- e.g., cargo, pnpm, pip, forge -->

## Testing Conventions

- Framework:       <!-- e.g., cargo test, vitest, pytest, forge test -->
- Test location:   <!-- e.g., tests/, src/**/*.test.ts, test/ -->
- Run all:         <!-- exact command: e.g., pytest tests/ -x -->
- Run single file: <!-- exact command: e.g., pytest tests/test_foo.py -->
- Run single test: <!-- exact command: e.g., pytest tests/test_foo.py::test_bar -->
- Coverage:        <!-- exact command: e.g., pytest --cov=src --cov-report=term-missing -->
- Fixture conventions: <!-- e.g., conftest.py fixtures, factory functions, test DBs -->

## Quality Gate Chain

<!-- Run in this exact order. All must pass before commit. -->

1. <!-- test command -->
2. <!-- lint command -->
3. <!-- typecheck command -->
4. <!-- security scan command -->
5. <!-- dependency audit command -->

## Directory Structure

- Source root:     <!-- e.g., src/, lib/, crates/ -->
- Test root:       <!-- e.g., tests/, test/ -->
- Configuration:   <!-- e.g., config/, .env -->
- Migrations:      <!-- e.g., migrations/ (if applicable) -->
- Generated code:  <!-- e.g., generated/ (do not manually edit) -->

## Stack-Specific Rules

<!-- Coding standards, idioms, and constraints unique to this project. -->
<!-- Examples: -->
<!-- - No panicking in non-test code. Use thiserror/anyhow. -->
<!-- - All async handlers require timeout middleware. -->
<!-- - On-chain functions must have NatSpec documentation. -->
<!-- - All API responses use the shared envelope type. -->
<!-- - No unwrap() outside #[cfg(test)] blocks. -->

## MCP Context Modules Active

<!-- Which modules are registered for this project. -->
<!-- - <module-name>: mcp/<path>/ (reads: <what it exposes>) -->
