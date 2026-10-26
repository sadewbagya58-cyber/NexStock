# NexStock Mobile (`apps/mobile` — Flutter)

## Milestone 0 Status

- **Workspace Shell**: Reserved for the Flutter Mobile POS & Inventory application (scheduled for **Milestone 6**).
- **Cross-Language Parity Status (`Acceptance Criterion #4`)**:
  - Canonical fixed-point calculation test vectors (`roundingVectors`, `taxVectors`, `valuationVectors`) have been authored in [`packages/domain-core/test-vectors/calculation-vectors.json`](../../packages/domain-core/test-vectors/calculation-vectors.json) and **verified in TypeScript** (`@nexstock/domain-core`).
  - **Flutter/Dart execution is NOT yet implemented or verified** in Milestone 0 (the local environment does not currently have the Flutter/Dart SDK installed).
  - Cross-language TypeScript-to-Dart parity will only be claimed once the Dart domain calculator port and `flutter test` runner are implemented and executed against `calculation-vectors.json`.
- **Shared SQLite Schema**: Will execute the canonical SQLite `STRICT` migrations defined in [`packages/sqlite-schema/migrations/`](../../packages/sqlite-schema/migrations/).
