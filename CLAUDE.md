# CLAUDE.md — finscout-ai-agents
# Inherits: ~/.claude/CLAUDE.md (iDECP Global Orchestrator Protocol)

## Execution Environment

- Language:        TypeScript 5.x
- Runtime:         Node.js 20
- Package Manager: npm

## Testing Conventions

- Framework:       Jest
- Test location:   src/**/*.test.ts
- Run all:         npm run test
- Run single file: npx jest src/path/to/file.test.ts
- Run single test: npx jest -t "test name"
- Coverage:        npm run test -- --coverage
- Fixture conventions: Jest beforeEach/afterEach; mock external I/O at module boundaries

## Quality Gate Chain

1. npm run lint
2. npm run test
3. npm run build

## Directory Structure

- Source root:     src/
- Test root:       src/**/*.test.ts
- Configuration:   src/config/
- Generated code:  dist/ (do not manually edit)

## Stack-Specific Rules

- Use Zod for ALL input validation and schema definitions — no raw type assertions at system boundaries.
- Centralize all Redis configuration in `src/config/redis.ts`; never instantiate Redis clients inline.
- No `any` type outside of test files.
- All async functions must have explicit return types.

## MCP Context Modules Active

<!-- Which modules are registered for this project. -->
<!-- - <module-name>: mcp/<path>/ (reads: <what it exposes>) -->
