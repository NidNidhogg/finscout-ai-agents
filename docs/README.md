# Documentation

Architecture documents and decision records for FinScout modules.

## Structure

- **Architecture documents** describe the design of a feature or subsystem that spans multiple modules. They live directly in this directory (e.g., `discovery-architecture.md`).
- **Decision records** capture resolutions to open questions raised in an architecture document. Naming convention: `<subject>-decisions.md` (e.g., `discovery-decisions.md`).
- **Module-level specs** (single-module functional + interface contracts) do NOT live here. They live under `/specs/<module>/spec.md` per iDECP convention.

## Relationship to `/specs/`

Architecture documents are the parent; specs are the children. An architecture document fixes the interfaces between modules; each module then has its own spec for the functional contract + test scaffold. Read the architecture document before writing any child spec.
