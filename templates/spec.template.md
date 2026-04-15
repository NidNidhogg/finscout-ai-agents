# SPEC: <Feature Name>
<!-- spec-version: 1.0 -->
<!-- status: draft -->
<!-- signed-by: -->
<!-- date: YYYY-MM-DD -->
<!-- superseded-by: -->

## 1. Intent

<!-- 2-5 sentences. Business purpose ONLY. No implementation. No technology. -->
<!-- Answer: What does the user/system gain? Why does this matter? -->

## 2. Functional Contract

<!-- What the feature does, expressed as operation → input → output mappings. -->
<!-- Use abstract types where concrete type depends on the project stack. -->

| Operation | Input Shape | Output Shape | Idempotent | Side Effects |
|-----------|-------------|--------------|------------|--------------|
|           |             |              |            |              |

## 3. Interface Contract

<!-- The exact surface this feature exposes to consumers. -->
<!-- For APIs: method, path, headers, request/response schemas. -->
<!-- For events: event name, payload schema, channel/topic. -->
<!-- For libraries: public function signatures, type exports. -->
<!-- For contracts: function selectors, ABI fragments, emitted events. -->

## 4. Boundary Contract

<!-- What this feature explicitly does NOT do. -->
<!-- What it assumes about its execution environment. -->
<!-- What external systems it depends on and what happens if they fail. -->

- Does NOT: 
- Assumes: 
- Depends on: 
- If [dependency] fails: 

## 5. Acceptance Criteria

<!-- Numbered. Binary (pass/fail). Machine-verifiable. -->
<!-- Each criterion maps 1:1 to one or more test cases in the scaffold. -->

- AC-001: 
- AC-002: 
- AC-003: 

## 6. MVA Constraints

<!-- EVERY spec MUST address ALL subsections. -->
<!-- If a category is not applicable, state WHY explicitly. -->

### 6.1 Security Boundaries

<!-- Authentication, authorization, input validation, output encoding. -->

### 6.2 Resource Ceilings

<!-- Memory, CPU, network, storage, rate limits, connection pools. -->

### 6.3 Failure Modes & Degradation

<!-- What happens when each dependency fails? -->
<!-- Circuit breakers, fallbacks, cached responses, graceful degradation. -->

### 6.4 Rollback & Kill Switch

<!-- Feature flags, migration reversibility, deployment rollback steps. -->

### 6.5 Observability

<!-- Metrics, logs, and traces this feature must emit. -->
<!-- Alert conditions. Dashboard integration points. -->

## 7. Test Scaffold Reference

See: specs/<feature-name>/test-scaffold.md
