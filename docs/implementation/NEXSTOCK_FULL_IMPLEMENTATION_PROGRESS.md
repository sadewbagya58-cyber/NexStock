# NexStock — Full System Implementation Progress Tracker

**Branch:** `feat/nexstock-batch-pricing-hybrid-barcodes` (branched from `main` @ `b246b22`)  
**Reference Specification:** `phase01_nexstock_audit_and_spec.md`  
**Audit Baseline (Before Changes):**
- `corepack pnpm run typecheck`: PASS (`8/8` workspace projects, `0` errors)
- `corepack pnpm run lint`: FAIL (`4` errors in `apps/api/test/credit-management-and-pos-sync.test.ts` and `apps/api/test/smart-pricing.test.ts`)
- `corepack pnpm run test`: PASS (`32` test files, `637/637` tests passed in-memory; `apps/desktop` `0` test files with `--passWithNoTests`)
- Existing PG migrations: `0001`–`0026`
- Existing SQLite migrations: `0001`–`0006`
- Environment Constraints Noted at Baseline: `rustc`/`cargo` NOT installed (`apps/desktop` native Rust compile cannot run locally unless toolchain added); `psql`/`docker` NOT installed (isolated real PostgreSQL 15+ execution blocked locally; Chrome & Edge ARE installed for Playwright browser responsive testing).

---

## Implementation Checklist

### Phase 1A — Critical System Stabilization (COMPLETE)
- [x] **ESLint Cleanup:** Fixed 4 baseline ESLint errors in `credit-management-and-pos-sync.test.ts` and `smart-pricing.test.ts` without weakening rules (`eslint . --max-warnings=0` -> 0 errors, 0 warnings).
- [x] **BUG-096:** Fixed broken supervisor role queries in `pos.service.ts` (`resolveMemberAuthorizationContext` / `TENANT_OWNER`, `ORG_ADMIN`, `BRANCH_MANAGER`).
- [x] **BUG-097:** Fixed FIFO cost-layer `batch_id` filtering + exact consumed layer restoration on reversal in `inv.service.ts`.
- [x] **BUG-094 & BUG-095:** Fixed SSE / BroadcastChannel stock sync (`warehouseId`, signed base-UOM `qtyDelta`, authoritative `balanceAfter`, batch balances, event ID dedup, no double subtraction).
- [x] **BUG-089:** Fixed POS register switching (preserve selected register, prevent active-shift fallback revert, race-safe async token, cached catalog).
- [x] **BUG-098:** Fixed Org Settings `/v1/branches` -> `/v1/org/branches` + error handling.
- [x] **BUG-087:** Added product thumbnails (`imageUrl` via `resolveMediaUrl`), SKU, stock quantity, base UOM, warehouse/branch context to Inventory Balances (desktop & mobile).
- [x] **BUG-088:** Redesigned Weighed & Measured POS quick-pick cards for `360px`–`430px` mobile (44px targets, readable badges/UOM/price).
- [x] **BUG-090:** Made Product Create/Edit UOM grids single-column responsive (`<=640px`), removed duplicate mobile card title.
- [x] **BUG-091:** Replaced Stock Movement 100-cap `<select>` with async searchable/scannable paginated product selector.
- [x] **BUG-092:** Replaced Batch Create 100-cap `<select>` with async searchable/scannable batch-eligible product selector.
- [x] **BUG-093:** Added mobile responsive cards & actions to all 4 Smart Pricing tabs + Valuation Cost Layers + Supplier Returns.
- [x] **Phase 1A Verification Gate:** `corepack pnpm -r run typecheck` (8/8 pass), `corepack pnpm run lint` (0 warnings), `apps/web` (`125/125` pass), `packages/*` (`34/34` pass), `apps/api` (`482/483` prior to comment restore + `bug066-initialization-performance.test.ts` `12/12` pass after final edit, incl. `phase1a-stabilization.test.ts` `5/5` pass). Real browser responsive checks deferred to Phase 3 Playwright gate.

### Phase 1B — Database & Domain Foundation (COMPLETE)
- [x] PostgreSQL Migration `0027_batch_pricing_hybrid_barcodes_and_transfers.sql` (idempotent, RLS enabled & forced, composite FKs, immutable triggers on `batch_price_history` and `batch_barcode_print_logs`, `stock_transfers`/`stock_transfer_lines`, `TRANSFER_OUT`/`TRANSFER_IN` ledger types) — verified executing against PGlite PG16 in `foundation.test.ts` (`13/13` pass) and `phase2-inventory.test.ts` (`7/7` pass).
- [x] SQLite Migration `0007_local_batch_pricing_and_barcodes.sql` + parity test update (`sqlite-schema.test.ts`: `7` migrations, idempotent re-exec, `2/2` pass).
- [x] `packages/domain-core/src/gs1.ts` (GS1 AI `01`, `10`, `11`, `17`, `21`, symbology prefixes, FNC1, month-end `00` leap-year-aware expiry, EAN/UPC normalization, `NB-B...` classification).
- [x] Shared batch pricing precedence resolver `resolveEffectiveBatchPrice()` in `packages/domain-core/src/pricing.ts` + unit tests (`gs1-and-batch-pricing.test.ts`: `6/6` pass, `26/26` total in `@nexstock/domain-core`).
- [x] Kysely database TypeScript definitions (`kysely-schema.ts`), `database-config.ts`, and `@nexstock/contracts` base unions updated; `typecheck` passed `8/8`.

### Phase 2 — Complete Backend Batch Pricing & Hybrid Barcode System (COMPLETE)
- [x] Unique internal batch barcode generation (`NB-B...` via Code 128) + cross-table collision guard (`CAT_DUPLICATE_BARCODE` for duplicate `product_barcodes`, `CAT_BARCODE_COLLISION` across `inventory_batches.internal_barcode`, `inventory_serials.serial_number`, `products`).
- [x] FEFO / FIFO / MANUAL allocation engine with `reserved_quantity` support, expired/inactive/quarantined/damaged exclusion, and fixed `listBatches` cursor pagination (`batch.service.ts`).
- [x] `POST /v1/barcodes/resolve` unified resolver supporting GS1 AI (`01`, `10`, `11`, `17`, `21`), manufacturer EAN/UPC/alternate barcodes, serials, and direct `NB-B` batch barcodes.
- [x] Batch pricing precedence (`EXPLICIT_BATCH_PRICE`, `POS_BATCH_OVERRIDE` with supervisor role verification, `BRANCH_DEFAULT_FALLBACK`, `PRODUCT_DEFAULT_FALLBACK`, `422 POS_BATCH_PRICE_REQUIRED`), `PATCH /v1/inventory/batches/:batchId/pricing`, `GET /v1/inventory/batches/:batchId/history`, and tenant shop branding (`GET`/`PUT /v1/org/branding`).
- [x] Multi-batch POS cart allocation/splitting & actual batch/FIFO COGS `unit_cost_snapshot`, batch number/internal barcode/expiry/price source on invoice lines (`pos.service.ts`).
- [x] GRN hybrid barcode intake + lot conflict policy (`REJECT`, `CREATE_NEW_LOT_SUFFIX`, `MANAGER_OVERRIDE`) + idempotency (`purchasing-orders.service.ts`).
- [x] Smart Pricing batch isolation (`D-04`: protect explicit batch prices & batch cost on GRN for FIFO/priced batches, support `scope: 'BATCH'` suggestions in `pricing.service.ts`).
- [x] Batch-aware POS returns & expired return restock guard (`409 POS_EXPIRED_BATCH_RESTOCK_BLOCKED`, `D-05` in `pos-returns.service.ts`).
- [x] Batch-aware multi-branch stock transfers (`POST /v1/inventory/transfers`, `DISPATCH` -> `TRANSFER_OUT`, `IN_TRANSIT`, `RECEIVE` -> `TRANSFER_IN` preserving selling price/cost/expiry + minting unique destination `NB-B` barcode).
- [x] Controlled Legacy UOM Correction Wizard (`409 CAT_UOM_CHANGE_REQUIRES_WIZARD`, preview & ACID rebase with append-only `stock_ledger_entries` adjustment + MAC/layer preservation in `cat.service.ts`).
- [x] Offline sync catalog snapshot (`GET /v1/sync/catalog-pricing`) & savepoint-isolated real idempotent execution (`POST /v1/sync/push` handling `POS_RECORD_SALE` & `POS_RECORD_RETURN`).
- [x] **Phase 2 Verification Gate:** `apps/api` full suite `25` test files (`488/488` tests passed sequentially via `--fileParallelism=false`), including `phase2-batch-pricing-hybrid-barcodes.test.ts` (`5/5`), `phase4-advanced-inventory.test.ts` (`47/47`), `phase6-barcode.test.ts` (`50/50`), `uom-and-variable-qty.test.ts`; `corepack pnpm -r run typecheck` (`8/9` pre-Phase-3 projects, exit 0); `corepack pnpm run lint` (`0` errors, `0` warnings).

### Phase 3 — Frontend, All 15 Responsive Screens, Thermal Printing, Tauri & Sync (COMPLETE)
- [x] **Structured API Error Propagation & Context Hydration:** Attached `status`, `errorCode`, and `data` onto `apiFetch` error instances and pre-warmed `/v1/org/branding` + `/v1/pricing/settings` during `hydrateTenantLocationContext()` in `apps/web/public/index.html`.
- [x] **Org Branding & Smart Pricing Batch Policies:** Added **Shop & Thermal Label Branding** settings (`GET`/`PATCH /v1/org/branding` with live preview) in Org Settings and tenant batch allocation (`FEFO`/`FIFO`) + missing batch price policy (`ALLOW_PRODUCT_FALLBACK`/`BLOCK_MISSING`) controls in Smart Pricing Settings.
- [x] **Batches Console, Price History & Shop-Branded Thermal Labels:** Upgraded `renderBatchesView` with search/expiry/status/missing-price filters, `NB-B` generation, `reservedQuantity` display, cursor pagination, **Edit Batch Price** modal (`PATCH /v1/inventory/batches/:batchId/pricing`), **Batch History Drawer** (`GET /v1/inventory/batches/:batchId/history` showing Price History, Stock Movements, and Print Audit Logs), and `openBatchLabelPrintModal` supporting `THERMAL_40X30`, `THERMAL_50X30`, `THERMAL_50X40`, `THERMAL_58`, `THERMAL_80`, and `A4_SHEET` + `POST /v1/inventory/batches/:batchId/barcode/print-log`.
- [x] **GRN Hybrid Scanner, Lot Conflict & Post-Receive Labeling:** Added GS1/EAN-13 top barcode scanner (`POST /v1/barcodes/resolve`), per-line batch selling price & min price capture, structured `409 INV_BATCH_LOT_CONFLICT` resolution modal (`CREATE_NEW_LOT_SUFFIX` / `MANAGER_OVERRIDE`), and post-GRN prompt to print `NB-B` labels.
- [x] **Cross-Branch Batch Transfers UI & Legacy UOM Wizard UI:** Added `renderTransfersTab` (`GET`/`POST /v1/inventory/transfers`, `/dispatch`, `/receive`, destination batch label shortcut) under Stock Movements and added **Legacy UOM Correction Wizard** (`409 CAT_UOM_CHANGE_REQUIRES_WIZARD`, preview & atomic rebase) in Product Edit modal.
- [x] **POS Hybrid Barcode & Multi-Batch Split Cart UI:** Updated `executeBarcodeScan`, `handlePosProductCardClick`, `addNextFefoBatchLine`, `addToCart` (`productId + batchId + uomCode + unitPrice + isExactBatchLocked`), `updateCartQty`, `setCartQty`, `openPosBatchOverridePriceModal`, `submitPosCheckout`, and POS receipts for FEFO rollover splitting, exact `NB-B` lock enforcement, expired batch blocking, and batch-level receipt lines.
- [x] **SSE Cross-Origin Header Fix:** Fixed missing `Access-Control-Allow-Origin: *` on raw `reply.raw` headers in `GET /v1/realtime/events` (`apps/api/src/app.ts`) discovered during real-browser Playwright testing.
- [x] **Tauri v2 Desktop Offline Runtime (`apps/desktop`):** Implemented `apps/desktop/src-tauri/` (`Cargo.toml`, `build.rs`, `tauri.conf.json`, `capabilities/default.json`, `src/main.rs`, `src/lib.rs`, `src/db.rs` over embedded SQLite `0001..0007`, `src/commands.rs`) and Node `node:sqlite` `DesktopOfflineStore` TypeScript bridge + tests (`desktop-offline-runtime.test.ts`: `2/2` pass). *(Note: `rustc`/`cargo` is not installed in the local Windows environment, so native Cargo compilation was not executed locally.)*
- [x] **Playwright Real-Browser & 8-Viewport Verification (Microsoft Edge Headless + Fastify + PGlite):** Verified Org Branding (`PATCH /v1/org/branding`), Batches list & `THERMAL_40X30` shop-branded preview, POS hybrid scan (`EAN-13` FEFO `SOAP-A @ 150.0000` + exact locked `NB-B` `SOAP-B @ 180.0000` + expired `SOAP-EXP` blocked), Transfers UI, and zero horizontal overflow (`scrollWidth <= innerWidth`) across `360, 390, 430, 768, 1024, 1366, 1440, 1920` px with `0` page errors, `0` console errors, and `0` server `5xx` responses.
- [x] **Final Verification Gate (Post-Final-Edit):**
  - `corepack pnpm -r run typecheck`: PASS (`8/8` TypeScript projects, `0` errors)
  - `corepack pnpm run lint`: PASS (`eslint . --max-warnings=0`, `0` errors, `0` warnings)
  - `@nexstock/domain-core`: `4/4` files, `26/26` tests passed
  - `@nexstock/sqlite-schema`: `1/1` file, `2/2` tests passed
  - `@nexstock/desktop`: `1/1` file, `2/2` tests passed
  - `@nexstock/web`: `2/2` files, `129/129` tests passed
  - `@nexstock/api` (`--fileParallelism=false --testTimeout=60000 --hookTimeout=60000`): `25/25` files, `488/488` tests passed
  - **Total Automated Vitest Suite:** `33/33` test files, `647/647` tests passed in-memory.
