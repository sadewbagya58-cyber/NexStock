# NexStock — Enterprise SaaS Architecture Documentation Index

Welcome to the architecture specification suite for **NexStock**, a production-oriented Universal Inventory Management and Point-of-Sale (POS) SaaS platform.

## Architecture Deliverables

| # | Document | ID | Summary |
| :--- | :--- | :--- | :--- |
| **01** | [Product Requirements Document (PRD)](./01-product-requirements.md) | `NEX-DOC-01` | Personas, functional requirements across 9 domains, non-functional SLAs, and scope boundaries. |
| **02** | [System Architecture Document](./02-system-architecture.md) | `NEX-DOC-02` | Stack compatibility evaluation, monorepo topology, hexagonal module layering, and ADRs. |
| **03** | [Module Boundaries and Dependencies](./03-module-boundaries.md) | `NEX-DOC-03` | 12 internal modules, exclusive table ownership, acyclic dependency graph (DAG), and lint rules. |
| **04** | [Database Entity Relationship Design](./04-database-erd.md) | `NEX-DOC-04` | UUIDv7 conventions, composite tenant FKs, Mermaid ERDs, immutable ledgers, and indexing. |
| **05** | [Multi-Tenant Security Model](./05-multi-tenant-security.md) | `NEX-DOC-05` | 7-layer isolation model, `NOBYPASSRLS`, connection-pool safe `SET LOCAL`, and offline device binding. |
| **06** | [Authentication and Authorization Strategy](./06-auth-and-authorization.md) | `NEX-DOC-06` | Supabase Auth integration, offline Argon2id POS PINs, supervisor overrides, and RBAC + location scopes. |
| **07** | [API Design Strategy](./07-api-design.md) | `NEX-DOC-07` | OpenAPI 3.1 contract-first workflow, ACID `Idempotency-Key` state machine, RFC 9457 errors, and endpoints. |
| **08** | [Offline Synchronization Design](./08-offline-synchronization.md) | `NEX-DOC-08` | Hybrid Outbox Command Push + Watermark Delta Pull, SQLite `STRICT` schema, and 7 conflict policies. |
| **09** | [Testing and Quality Assurance Strategy](./09-testing-and-qa.md) | `NEX-DOC-09` | TS/Dart JSON parity vectors, Testcontainers RLS penetration suite, concurrency race tests, and CI gates. |
| **10** | [Development Roadmap & Open Decisions](./10-development-roadmap.md) | `NEX-DOC-10` | Milestones M0–M6 implementation sequence, technical risk register, and unresolved decisions. |
