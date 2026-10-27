# NexStock — Universal Inventory Management & POS SaaS Platform

NexStock is a multi-tenant, multi-branch, and multi-warehouse Inventory Management and Point-of-Sale (POS) SaaS platform engineered with a strict **Modular Monolith** backend (`Fastify + TypeBox + Kysely`), **PostgreSQL Row Level Security (`FORCE ROW LEVEL SECURITY` + `NOBYPASSRLS`)**, **Supabase Auth (`ES256`/`RS256` JWKS)**, fixed-point financial & inventory arithmetic (`Money` / `Quantity`), and separated online/offline database schemas (`PostgreSQL` for cloud/API and `SQLite STRICT` for Tauri Desktop & Flutter Mobile edge terminals).

---

## 1. Implementation Status (Milestones 0–1, Phase 2 Core Inventory & Phase 3 POS)

| Workspace Path | Layer / Role | Status |
| :--- | :--- | :--- |
| [`packages/config`](file:///c:/Users/x/.antigravity/inventor/packages/config) | Shared ESLint (`eslint-plugin-boundaries` DAG enforcement) & TypeScript configuration | **Implemented & Verified** |
| [`packages/domain-core`](file:///c:/Users/x/.antigravity/inventor/packages/domain-core) | Pure fixed-point `Money` (4-decimal scale), `Quantity` (6-decimal scale), `TaxCalculator`, and `ValuationCalculator` (`MAC`, `FIFO`, negative-stock recovery, post-sale landed-cost PPV split) + canonical JSON test vectors | **Implemented & Verified (TypeScript)** *(Dart parity runner scheduled for Milestone 6)* |
| [`packages/contracts`](file:///c:/Users/x/.antigravity/inventor/packages/contracts) | TypeBox OpenAPI 3.1 schemas, RFC 9457 Problem Details error taxonomy, Phase 1 + Phase 2 (`CAT`, `PUR`, `INV`) and Phase 3 (`POS`, `Shifts`, `Sales`, `Receipts`) contracts | **Implemented & Verified** |
| [`packages/sqlite-schema`](file:///c:/Users/x/.antigravity/inventor/packages/sqlite-schema) | Canonical local offline SQLite `STRICT` schema (`0001_local_sync_foundation.sql`, `0002_local_catalog_and_inventory.sql`, `0003_local_pos_and_billing.sql`) and `initializeLocalSqliteDatabase` runner | **Implemented & Verified** |
| [`packages/ui`](file:///c:/Users/x/.antigravity/inventor/packages/ui) | Shared presentation design tokens (light/dark palette, stock level badges, sync banner descriptors) consumed by Web & Desktop | **Implemented & Verified** |
| [`apps/api`](file:///c:/Users/x/.antigravity/inventor/apps/api) | Fastify + TypeBox + Kysely Modular Monolith (`SHARED`, `IAM`, `ORG`, `SUB`, `I18N`, `CAT`, `PUR`, `INV`, `POS`) + PostgreSQL migrations (`0001`, `0002`, `0003`, `0004`) | **Implemented & Verified** |
| [`apps/web`](file:///c:/Users/x/.antigravity/inventor/apps/web) | Interactive Local UI Preview SPA (`apps/web/public/index.html` + `apps/web/src/server.ts`) serving Dashboard, Inventory, and POS Checkout on `http://localhost:3000` | **Implemented & Verified** |
| [`apps/desktop`](file:///c:/Users/x/.antigravity/inventor/apps/desktop) | Tauri v2 + Vite React/TS SPA shell | **Phase 1 Workspace Shell** *(Offline POS UI scheduled for Milestone 6)* |
| [`apps/mobile`](file:///c:/Users/x/.antigravity/inventor/apps/mobile/README.md) | Flutter mobile client placeholder (`README.md` only) | **Deferred to Milestone 6** *(Not yet initialized as a Dart/Flutter workspace)* |

---

## 2. Architecture & Module Boundaries

### 2.1 Approved Architecture Decisions (`UD-01` – `UD-05`)
- **`UD-01` (Backend Framework)**: `Fastify + TypeBox + Kysely` with `coerceTypes: false` on request bodies, OpenAPI 3.1 schema generation, explicit SQL queries, and transaction-scoped tenant context (`withTenantTransaction`).
- **`UD-02` (Desktop & Web Frontends)**: Vite + React + TypeScript SPA inside Tauri (`apps/desktop`) and Next.js (`apps/web`) sharing `packages/ui`. All business logic and authorization remain exclusively in `apps/api`.
- **`UD-03` (Inventory Valuation)**: Moving Average Cost (`MAC`) for standard/serialized items and `FIFO` cost layers for batch/expiry-tracked items; historical posted entries are immutable, and post-sale variances route to `Purchase Price Variance / COGS Adjustment`.
- **`UD-04` (Offline Scope)**: Online-first browser (`apps/web`); full offline-first SQLite outbox/watermark sync in Tauri Desktop (`apps/desktop`) and Flutter Mobile (`apps/mobile`).
- **`UD-05` (Subscription Billing)**: Provider-neutral `SubscriptionBillingPort` backed in Phase 1 by `ManualAdminBillingAdapter` (admin-provisioned plans, trials, lifecycle status, manual invoices, payments, and audited administrative overrides).

### 2.2 Backend Module Dependency Acyclic Graph (DAG)
Enforced via `eslint-plugin-boundaries` ([`packages/config/eslint-preset.mjs`](file:///c:/Users/x/.antigravity/inventor/packages/config/eslint-preset.mjs)) and [`apps/api/test/module-boundaries.test.ts`](file:///c:/Users/x/.antigravity/inventor/apps/api/test/module-boundaries.test.ts):

```text
Tier 0: shared   -> (may only import shared / workspace packages)
Tier 1: iam      -> shared
        sub      -> shared
        i18n     -> shared
Tier 2: org      -> shared, iam, sub, i18n
        cat      -> shared, iam, sub, i18n, org
        crm      -> shared, iam, sub, i18n, org
Tier 3: inv      -> shared, iam, sub, i18n, org, cat
        fin      -> shared, iam, sub, i18n, org
Tier 4: pos      -> shared, iam, sub, i18n, org, cat, crm, inv, fin
        pur      -> shared, iam, sub, i18n, org, cat, inv, fin
Tier 5: sync     -> shared, iam, sub, i18n, org, cat, crm, inv, fin, pos, pur
```
No cross-module imports into another module's `infrastructure/` or internal implementation files are permitted; cross-module communication goes strictly through public module `index.ts` contracts/services.

---

## 3. Environment Configuration & Credential Separation

### 3.1 Setup from `.env.example`
1. Copy [`.env.example`](file:///c:/Users/x/.antigravity/inventor/.env.example) to `.env` for local configuration:
   ```powershell
   Copy-Item .env.example .env
   ```
2. Never commit `.env`, `.env.local`, private keys, or database passwords to Git (enforced by [`.gitignore`](file:///c:/Users/x/.antigravity/inventor/.gitignore)).

### 3.2 Required Environment Variables
Validated at startup by `validateEnvironmentConfig` and `validateDatabaseCredentialSeparation` in [`apps/api/src/modules/shared/infrastructure/database-config.ts`](file:///c:/Users/x/.antigravity/inventor/apps/api/src/modules/shared/infrastructure/database-config.ts):

| Variable | Purpose | Security Requirement |
| :--- | :--- | :--- |
| `SUPABASE_URL` | Supabase project base URL (`https://tokylhdgzyoxiqwvncis.supabase.co`) | Must be a valid `https://` URL |
| `SUPABASE_JWKS_URL` | Public JWKS endpoint (`.../auth/v1/.well-known/jwks.json`) | Must be a valid `https://` URL |
| `SUPABASE_JWT_ISSUER` | Expected JWT `iss` claim (`.../auth/v1`) | Must match Supabase Auth issuer |
| `SUPABASE_JWT_AUDIENCE` | Expected JWT `aud` claim (`authenticated`) | Validated on every Bearer token |
| `SUPABASE_PUBLISHABLE_KEY` | Public client publishable key | Safe for public clients; never use service-role keys in clients |
| `APP_DATABASE_URL` | Runtime API PostgreSQL connection string | **MUST** connect as a non-superuser `NOBYPASSRLS` role (`nexstock_app_user`); forbidden from using `postgres`, `supabase_admin`, or matching `MIGRATION_DATABASE_URL` |
| `MIGRATION_DATABASE_URL` | Privileged DDL migration connection string | Used exclusively for schema migrations (`nexstock_migrator`); never used by runtime API traffic |

---

## 4. Local Development & Verification Commands

Install dependencies, run the full verification suite, and start the local interactive preview from the repository root (`c:\Users\x\.antigravity\inventor`):

```powershell
# 1. Install workspace dependencies
corepack pnpm install

# 2. Build all packages and applications
corepack pnpm run build

# 3. Run ESLint (including module boundary checks)
corepack pnpm run lint

# 4. Run TypeScript typechecking across all workspaces
corepack pnpm run typecheck

# 5. Run automated unit, RLS, auth, quota, inventory, and POS tests (69 tests)
corepack pnpm run test

# 6. Start Local Development Servers (API on http://localhost:4000 and Web UI on http://localhost:3000)
corepack pnpm run dev
```

When started with `pnpm run dev` without an external database URL, the API automatically runs in safe zero-config local mode using `@electric-sql/pglite`, applies all migrations 1–4, seeds a complete demo store ("NexStock Global Retail Ltd"), and connects to the interactive Web UI on `http://localhost:3000`.

---

## 5. Authentication & 3-Dimensional Authorization Flow

### 5.1 Supabase JWT Authentication (`apps/api/src/modules/iam/domain/jwt-verifier.ts`)
- Verifies `Authorization: Bearer <token>` against Supabase's JWKS endpoint (`ES256` P-256 ECDSA and `RS256` supported).
- Enforces `iss` (`SUPABASE_JWT_ISSUER`), `aud` (`SUPABASE_JWT_AUDIENCE`), `exp` (expiration), `nbf` (not-before), and `sub` (UUID user identifier).
- **Key Rotation & Timeout Resilience**: `RemoteJwksProvider` caches JWKS keys in memory, enforces an HTTP fetch timeout (`AbortSignal.timeout`), and performs a cooldown-protected forced refresh (`forceRefresh`) when a token presents an unrecognized `kid` (supporting zero-downtime key rotation).

### 5.2 Transaction-Scoped Multi-Tenancy & PostgreSQL RLS
- Every tenant-scoped API request executes inside `withTenantTransaction(db, { tenantId, userId, traceId }, fn)`.
- Inside `BEGIN ... COMMIT`, the transaction executes:
  - `SET LOCAL ROLE nexstock_app_user` (`rolsuper = false`, `rolbypassrls = false`)
  - `SELECT set_config('app.current_tenant_id', $1, true)`
  - `SELECT set_config('app.current_user_id', $2, true)`
  - `SELECT set_config('app.current_trace_id', $3, true)`
- All tenant-owned tables enforce `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` with a permissive `tenant_id = app.current_tenant_id()` isolation policy and composite foreign keys `(tenant_id, id)` preventing cross-tenant reference spoofing.
- If any operation inside `withTenantTransaction` throws an error, the entire transaction rolls back atomically (`audit_logs`, `outbox_events`, and domain mutations included).

### 5.3 Three-Dimensional Authorization (`assertAuthorized`)
Every protected operation evaluates three server-side dimensions inside PostgreSQL before executing business logic:
1. **Active Tenant Membership**: User must have an `ACTIVE` row in `tenant_memberships` for `app.current_tenant_id()`. Setting a member's status to `SUSPENDED` or `DISABLED` revokes access on the very next API request even if their Supabase JWT has not expired.
2. **Role Permission**: Member's assigned roles (`member_roles` -> `role_permissions` -> `permissions`) must grant the required `<module>:<resource>:<action>` permission key.
3. **Location Scope**: Unless `all_locations_access = true`, the member must hold an active row in `member_location_scopes` covering the target `branchId` or `warehouseId` (including parent branch inheritance for warehouses).

| System Role Code | Default Location Scope | Granted Phase 1 & Phase 2 Permissions |
| :--- | :--- | :--- |
| `TENANT_OWNER` | All Locations (`all_locations_access = true`) | All 27 Phase 1 & Phase 2 permissions (`org:*`, `iam:*`, `sub:*`, `i18n:*`, `cat:*`, `pur:*`, `inv:*`, `pos:sale:execute`) |
| `ORG_ADMIN` | All Locations (`all_locations_access = true`) | All 27 Phase 1 & Phase 2 permissions |
| `BRANCH_MANAGER` | Assigned Branch(es) | `org:branch:read`, `org:warehouse:read`, `org:warehouse:manage`, `org:register:read`, `org:register:manage`, `iam:member:read`, `i18n:currency:read`, `i18n:tax:read`, `cat:category:read`, `cat:category:manage`, `cat:product:read`, `cat:product:manage`, `pur:supplier:read`, `pur:supplier:manage`, `inv:balance:read`, `inv:movement:read`, `inv:movement:post`, `inv:movement:reverse`, `pos:sale:execute` |
| `WAREHOUSE_CLERK` | Assigned Branch/Warehouse(s) | `org:branch:read`, `org:warehouse:read`, `i18n:settings:read`, `cat:category:read`, `cat:product:read`, `pur:supplier:read`, `inv:balance:read`, `inv:movement:read`, `inv:movement:post` |
| `PURCHASER` | Assigned Branch/Warehouse(s) | `org:branch:read`, `org:warehouse:read`, `i18n:settings:read`, `cat:category:read`, `cat:product:read`, `pur:supplier:read`, `pur:supplier:manage`, `inv:balance:read`, `inv:movement:read` |
| `CASHIER` | Assigned Branch | `org:branch:read`, `org:register:read`, `i18n:currency:read`, `i18n:tax:read`, `cat:category:read`, `cat:product:read`, `inv:balance:read`, `pos:sale:execute` |
| `ACCOUNTANT` | All Locations | `org:branch:read`, `org:warehouse:read`, `sub:subscription:read`, `i18n:currency:read`, `i18n:currency:manage`, `i18n:tax:read`, `i18n:tax:manage`, `cat:category:read`, `cat:product:read`, `pur:supplier:read`, `inv:balance:read`, `inv:movement:read` |

---

## 6. Database Migrations (PostgreSQL vs. Local SQLite)

> [!CAUTION]
> **Never Run SQLite Migrations in PostgreSQL / Supabase SQL Editor**
> NexStock maintains two strictly separated migration paths for two different database engines:
> 1. **PostgreSQL / Supabase (Cloud API)**: [`apps/api/migrations/`](file:///c:/Users/x/.antigravity/inventor/apps/api/migrations)
> 2. **SQLite (Offline Edge Terminals — Tauri Desktop & Flutter Mobile)**: [`packages/sqlite-schema/migrations/`](file:///c:/Users/x/.antigravity/inventor/packages/sqlite-schema/migrations)

### 6.1 PostgreSQL / Supabase Migration Order (`apps/api/migrations/`)
When applying migrations to a PostgreSQL 16 or Supabase database (either via the programmatic runner `runPostgresMigrations` in [`apps/api/src/modules/shared/infrastructure/postgres-migrator.ts`](file:///c:/Users/x/.antigravity/inventor/apps/api/src/modules/shared/infrastructure/postgres-migrator.ts) or manually in the Supabase SQL Editor), execute **only** the files in `apps/api/migrations/` in exact numerical order:

1. **Step 1**: [`apps/api/migrations/0001_shared_foundation_rls.sql`](file:///c:/Users/x/.antigravity/inventor/apps/api/migrations/0001_shared_foundation_rls.sql)
   - Creates the `schema_migrations` version ledger and records version `1` (`0001_shared_foundation_rls`).
   - Creates or verifies the runtime role `nexstock_app_user` (`NOBYPASSRLS`, `NOSUPERUSER`, compatible with managed Supabase non-superuser `CREATEROLE`).
   - Creates `app.current_tenant_id()`, `app.current_user_id()`, `app.current_trace_id()`, and the `SHARED` tables (`idempotency_keys`, `outbox_events`, `audit_logs`) with `ENABLE + FORCE ROW LEVEL SECURITY`.
2. **Step 2**: [`apps/api/migrations/0002_milestone1_iam_org_sub_i18n.sql`](file:///c:/Users/x/.antigravity/inventor/apps/api/migrations/0002_milestone1_iam_org_sub_i18n.sql)
   - Runs a preflight check confirming `0001_shared_foundation_rls` is recorded in `schema_migrations`.
   - Creates all Milestone 1 global reference tables (`subscription_plans`, `currencies`, `permissions`, `users`) and tenant-scoped tables (`tenants`, `roles`, `role_permissions`, `tenant_memberships`, `member_roles`, `member_location_scopes`, `branches`, `warehouses`, `storage_bins`, `pos_registers`, `tenant_subscriptions`, `subscription_invoices`, `subscription_payments`, `tenant_currencies`, `exchange_rates`, `tax_groups`, `tax_rules`) with `FORCE ROW LEVEL SECURITY`.
   - Seeds default subscription plans (`STARTER`, `GROWTH`, `ENTERPRISE`), permissions, and ISO 4217 currencies (`LKR`, `USD`, `EUR`, `GBP`, `INR`, `JPY`, `KWD`), and records version `2` in `schema_migrations`.
3. **Step 3**: [`apps/api/migrations/0003_phase2_core_inventory.sql`](file:///c:/Users/x/.antigravity/inventor/apps/api/migrations/0003_phase2_core_inventory.sql)
   - Runs a preflight check confirming both `0001_shared_foundation_rls` and `0002_milestone1_iam_org_sub_i18n` are recorded in `schema_migrations`.
   - Seeds Phase 2 permissions (`cat:*`, `pur:*`, `inv:*`) and backfills `role_permissions` for existing tenants.
   - Creates Phase 2 tenant-scoped tables (`categories`, `products`, `product_barcodes`, `product_unit_conversions`, `suppliers`, `supplier_products`, `stock_ledger_entries`, `inventory_balances`) with composite foreign keys and `ENABLE + FORCE ROW LEVEL SECURITY`.
   - Attaches database-level triggers blocking hard deletion of master records (`prevent_master_record_hard_delete`), blocking mutation/deletion of `stock_ledger_entries` (`prevent_immutable_row_mutation`), and blocking direct manipulation of `inventory_balances` without a matching `stock_ledger_entries` row (`enforce_inventory_balance_ledger_integrity`). Records version `3` in `schema_migrations`.
4. **Step 4**: [`apps/api/migrations/0004_phase3_pos_and_billing.sql`](file:///c:/Users/x/.antigravity/inventor/apps/api/migrations/0004_phase3_pos_and_billing.sql)
   - Runs a preflight check confirming `0001_shared_foundation_rls`, `0002_milestone1_iam_org_sub_i18n`, and `0003_phase2_core_inventory` are recorded in `schema_migrations`.
   - Seeds Phase 3 permissions (`pos:*`) and assigns default cashier and owner permissions.
   - Creates POS cashier shift lifecycle tables (`pos_cashier_shifts`), sales invoices (`sales_invoices`, `sales_invoice_lines`, `sales_invoice_line_taxes`), multi-tender payments (`sales_payments`), and POS receipt templates (`pos_receipt_templates`).
   - Implements consecutive invoice numbering via atomic `pos_registers.last_invoice_seq`, immutable invoice lines with strict anti-mutation triggers, and cashier cash variance tracking. Records version `4` in `schema_migrations`.

### 6.2 Safe Recovery Procedure for Failed or Partially Applied Migrations
All PostgreSQL migrations (`0001`–`0004`) are authored idempotently (`CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS` before `CREATE POLICY`, `ON CONFLICT DO UPDATE` for seed data and `schema_migrations`).
- **If a migration fails in the Supabase SQL Editor**:
  1. Check the error message:
     - If `ERROR: 42601: syntax error at or near "PRAGMA"`, you pasted a local SQLite file (`packages/sqlite-schema/migrations/0001_local_sync_foundation.sql`, `0002_local_catalog_and_inventory.sql`, or `0003_local_pos_and_billing.sql`). No PostgreSQL objects were modified; run the PostgreSQL files in `apps/api/migrations/`.
     - If any migration fails with `MIGRATION_ORDER_ERROR`, apply the prerequisite PostgreSQL migrations in exact order (`0001` -> `0002` -> `0003` -> `0004`).
  2. Inspect `SELECT * FROM public.schema_migrations ORDER BY version;` to verify which migrations have completed cleanly.
  3. Because every statement in `0001`–`0004` is idempotent, you can safely re-run them in numerical order to converge a partially initialized schema without dropping existing data.

---

## 7. Verification Scope & Production Prerequisites

1. **Local Automated Verification vs. Live Supabase `PRODUCTION`**:
   - All PostgreSQL migrations (`0001`–`0004`), non-superuser `CREATEROLE` role provisioning (`nexstock_app_user`), RLS policies (`FORCE ROW LEVEL SECURITY` + `NOBYPASSRLS`), composite foreign keys, JWT verification, 3D RBAC/location authorization, subscription quotas, multi-currency/tax rules, Phase 2 Core Inventory (`CAT`, `PUR`, `INV`), and Phase 3 POS/Billing are verified locally against **in-process PostgreSQL 16 (`@electric-sql/pglite`)**.
   - Per safety rules, no SQL has been automatically executed against the remote Supabase `PRODUCTION` database (`https://tokylhdgzyoxiqwvncis.supabase.co`).
2. **Production Cutover Checklist**:
   - Execute `apps/api/migrations/0001_shared_foundation_rls.sql`, `0002_milestone1_iam_org_sub_i18n.sql`, `0003_phase2_core_inventory.sql`, and `0004_phase3_pos_and_billing.sql` in the Supabase SQL Editor (or via a non-production staging branch first).
   - Provision a dedicated login role or connection pooler user that assumes/inherits `nexstock_app_user` (`NOBYPASSRLS`) for `APP_DATABASE_URL`, keeping `MIGRATION_DATABASE_URL` restricted to migration pipelines.
   - Configure `.env` in the deployment environment and verify `validateEnvironmentConfig` + `GET /v1/health/ready` pass before routing traffic.
