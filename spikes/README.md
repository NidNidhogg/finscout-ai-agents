# Spikes

Exploratory experiments that are explicitly NOT under the iDECP protocol.

## Rules

- Code in this directory has NO specs, NO tests, NO quality gate coverage.
- Spikes exist to de-risk architectural decisions before real implementation.
- Each spike lives in its own subdirectory with a `README.md` explaining its purpose and expected outcome.
- Spikes SHOULD be deleted once they have served their purpose. Long-lived spikes are a smell.
- Nothing under `/src/` may import from `/spikes/`. If a spike produces code worth keeping, it must be rewritten inside `/src/` with proper spec + tests.

## When to spike

- Before committing to an external dependency (API, service, library).
- Before writing a spec for a module whose feasibility is genuinely uncertain.
- When the answer to "will this approach work at all?" is not obviously yes.
