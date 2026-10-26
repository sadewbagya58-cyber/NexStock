# 01 — Product Requirements Document (PRD): NexStock

| Metadata | Details |
| :--- | :--- |
| **Document ID** | `NEX-DOC-01` |
| **Status** | Approved Baseline (Rev 1.1 — UD-01..UD-05 Incorporated) |
| **Target Release** | Phase 1–4 Incremental Rollout |
| **Scope** | Universal Inventory Management & Point-of-Sale (POS) SaaS Platform |

---

## 1. Executive Vision & Purpose

**NexStock** is a production-oriented, multi-tenant Universal Inventory Management and Point-of-Sale (POS) SaaS platform engineered for retail, wholesale, distribution, and multi-branch commercial operations worldwide.

The platform is designed around three non-negotiable operational realities of global commerce:
1. **Uninterrupted Storefront Operations**: Checkout registers and warehouse scanners must continue operating during internet outages via local SQLite persistence and deterministic synchronization.
2. **Financial & Inventory Auditability**: Every stock movement and monetary transaction must be immutable, double-entry/ledger-backed, idempotent, and traceable to an actor, terminal, branch, and timestamp.
3. **Strict Multi-Tenant & Multi-Branch Isolation**: Organizations range from single-store merchants to multi-warehouse enterprises requiring strict tenant data isolation and granular branch/warehouse access control.

> [!IMPORTANT]
> **Explicit Non-Goals (Initial Phases)**:
> - **AI-Powered Features**: Demand forecasting, automated reorder ML models, generative analytics, and AI chat assistants are strictly out of scope for initial phases.
> - **Premature Microservices**: The system will be built and deployed as a modular monolith with strict internal module boundaries.
> - **Custom Payment Gateway Processing Hardware Drivers**: Initial POS payments record external terminal authorizations/tenders and standard webhook-driven gateways rather than low-level EMV kernel certification inside the core codebase.

---

## 2. User Personas & Actor Matrix

| Persona | Primary Platforms | Core Responsibilities | Offline Requirement |
| :--- | :--- | :--- | :--- |
| **Platform Super-Admin** (NexStock Ops) | Web | Tenant provisioning, subscription plan management, compliance auditing, system health monitoring. | Online only |
| **Tenant Owner / Org Admin** | Web, Mobile | Organization settings, subscription billing, tax profiles, currency configuration, branch/warehouse creation, user & role management. | Online only |
| **Branch / Store Manager** | Web, Desktop, Mobile | Register shift management, cash drawer reconciliation, local price overrides, stock adjustments (within approval thresholds), branch reporting. | Online + Offline read/approve |
| **POS Cashier / Sales Associate** | Desktop, Web, Mobile | Fast barcode/SKU checkout, customer lookup, split tenders, hold/park sales, receipts, returns/exchanges, cash-in/cash-out shift tracking. | **Critical (Full Offline Checkout)** |
| **Warehouse / Inventory Clerk** | Mobile, Web, Desktop | Goods receipt (GRN), cycle counting, stock transfers (dispatch/receive), barcode label verification, damaged goods write-offs. | **High (Offline Count & Scan)** |
| **Procurement / Purchasing Officer** | Web, Desktop | Supplier catalog management, Purchase Order (PO) creation, approval workflows, supplier invoice matching (3-way match). | Online primary |
| **Finance / Accountant** | Web | Tax reports, COGS valuation, journal export, payment reconciliation, supplier payables, customer receivables, audit log inspection. | Online only |

---

## 3. Functional Requirements by Domain

### 3.1 Multi-Tenant Organization & Branch Hierarchy (`ORG`)
- **FR-ORG-01**: Support self-service and admin-assisted creation of Tenant Organizations.
- **FR-ORG-02**: Each Tenant may configure multiple **Branches** (retail storefronts/offices) and **Warehouses** (storage locations). A Branch may have one or more linked Warehouses (including a default sales-floor warehouse) and multiple **POS Registers/Terminals**.
- **FR-ORG-03**: Support tenant-level base currency, fiscal year start, timezone defaults, and branch-level overrides (e.g., local timezone, local tax jurisdiction, receipt header/footer).

### 3.2 Catalog & Product Information Management (`CAT`)
- **FR-CAT-01**: Hierarchical categories, brands, units of measure (UoM) with conversion ratios (e.g., `1 Box = 12 Pieces`, `1 Case = 24 Boxes`).
- **FR-CAT-02**: Support standard items, variant matrices (size/color/style), composite/bundled items (kits assembled at sale or pre-assembled), and non-stock service items.
- **FR-CAT-03**: Multi-barcode support per SKU (EAN-13, UPC-A, Code128, QR, internal SKU codes).
- **FR-CAT-04**: Flexible pricing tiers (Base Price, Branch Override Price, Wholesale Tier Price, Promotional/Time-bound Price) and multi-rate tax rules (inclusive vs. exclusive tax, compound taxes, regional tax groups).
- **FR-CAT-05**: Tracking mode configuration per product:
  - Standard quantity tracking
  - Batch / Lot + Expiry date tracking
  - Serial number (unique unit) tracking

### 3.3 Advanced Inventory & Warehouse Management (`INV`)
- **FR-INV-01**: **Immutable Stock Ledger**: On-hand quantities are never mutated without appending an immutable `stock_ledger_entries` record containing reason code, source document reference, actor, warehouse, bin/location, delta quantity, and unit cost snapshot.
- **FR-INV-02**: Track distinct inventory buckets per SKU + Warehouse:
  - `on_hand` (physically present)
  - `reserved` (allocated to open orders/transfers)
  - `available` (`on_hand - reserved`)
  - `in_transit` (dispatched from source warehouse, not yet received at destination)
  - `quarantined / damaged` (non-sellable)
- **FR-INV-03**: Inter-warehouse and inter-branch **Stock Transfers** with state machine (`DRAFT` → `APPROVED` → `IN_TRANSIT` → `PARTIALLY_RECEIVED` / `RECEIVED` / `CANCELLED`) and variance handling.
- **FR-INV-04**: **Stock Adjustments & Cycle Counts**: Blind or guided stocktake sessions, snapshot comparison against expected stock at count timestamp, variance approval workflows, and automatic adjustment ledger postings.
- **FR-INV-05**: **Inventory Valuation & Costing**:
  - Use **Moving Average Cost (MAC)** for all standard inventory (`tracking_mode = 'NONE' | 'SERIAL'`).
  - Use **FIFO Cost Layers** (`inventory_cost_layers`) for inventory configured for Batch/Lot tracking (`tracking_mode = 'BATCH_EXPIRY'`).
  - Historical financial and stock ledger postings are strictly immutable; subsequent purchase-cost adjustments or landed cost allocations must never retroactively alter already-posted transactions (variances for already-sold units post directly to a Purchase Price Variance / COGS Adjustment account in the current open period).
- **FR-INV-06**: Low-stock reorder point (ROP) and safety stock threshold alerts per warehouse.

### 3.4 Point of Sale (POS) & Shift Operations (`POS`)
- **FR-POS-01**: **Register Shift Lifecycle**: Cashiers must open a shift on an assigned Register Terminal with an opening float before processing cash sales, record mid-shift cash drops/pay-ins/pay-outs, and close the shift with blind or counted cash reconciliation (`expected_cash` vs. `counted_cash` = `over_short_variance`).
- **FR-POS-02**: **High-Speed Checkout**: Sub-100ms local barcode/SKU lookup, cart line-item discounts, order-level discounts (role-gated), tax calculation, customer attachment, and order notes.
- **FR-POS-03**: **Park / Hold & Resume Orders**: Locally or server-synced parked carts within a branch.
- **FR-POS-04**: **Split & Multi-Tender Payments**: Support combining Cash, Card (external terminal reference), Mobile Money/QR, Store Credit, and Gift Cards on a single invoice, including multi-currency tender acceptance with locked exchange rate snapshot.
- **FR-POS-05**: **Returns, Exchanges & Refunds**: Reference original sale receipt (online or synced local history) or authorized unreferenced return; enforce restocking condition (`RESTOCK_SELLABLE` vs. `WRITE_OFF_DAMAGED`), restore inventory at the original sale's captured unit cost snapshot (or current MAC if unreferenced), and enforce refund tender rules.
- **FR-POS-06**: **Platform Offline Scope (`UD-04`)**:
  - **Tauri Desktop (`apps/desktop`) & Flutter Mobile (`apps/mobile`)**: Full offline-first execution (cart creation, tax/price calculation, register-prefixed invoice numbering, receipt printing, shift cash tracking, and payment recording while completely offline, queueing idempotent command envelopes in local SQLite).
  - **Browser Web Application (`apps/web`)**: Online-first for back-office management, reporting, and cloud-connected POS. Browser OPFS/WebAssembly SQLite is explicitly deferred unless future requirements justify it.

### 3.5 Purchasing & Supplier Management (`PUR`)
- **FR-PUR-01**: Supplier directory with payment terms, lead times, tax IDs, currency defaults, and supplier-specific SKU catalog/cost mappings.
- **FR-PUR-02**: Purchase Requisition & Purchase Order (`PO`) lifecycle (`DRAFT` → `PENDING_APPROVAL` → `APPROVED` → `SENT` → `PARTIALLY_RECEIVED` → `RECEIVED` → `CLOSED` / `CANCELLED`).
- **FR-PUR-03**: **Goods Receipt Notes (GRN)**: Receive against PO (full or partial), capture batch/expiry/serial numbers, record rejected/damaged quantities, and trigger immediate stock ledger increments.
- **FR-PUR-04**: **Supplier Invoices & Landed Cost**: Record supplier bills, match against PO and GRN quantities/prices, and allocate landed costs (freight, customs duty) across received inventory cost layers.
- **FR-PUR-05**: **Purchase Returns (RTV - Return to Vendor)**: Debit note generation and stock deduction for defective or over-shipped goods.

### 3.6 Financial Recording & Reporting (`FIN`)
- **FR-FIN-01**: Double-entry style sub-ledger entries for Sales Revenue, Sales Tax Payable, Inventory Asset, Cost of Goods Sold (COGS), Cash/Clearing Accounts, Accounts Payable (AP), and Accounts Receivable (AR).
- **FR-FIN-02**: Branch and consolidated reporting:
  - Daily/Shift Z-Reports and X-Reports
  - Sales by Product, Category, Cashier, Branch, Payment Method
  - Gross Margin and COGS valuation reports
  - Inventory Aging, Stock Valuation, and Movement Ledger reports
  - Tax Liability summaries (input vs. output tax)
- **FR-FIN-03**: Exportable financial summaries (CSV, JSON, accounting integration formats) with immutable period locking (preventing backdated mutations into closed accounting periods).

### 3.7 Role-Based Access Control (`RBAC`) & Auditability
- **FR-RBAC-01**: Built-in system roles (`TenantOwner`, `OrgAdmin`, `BranchManager`, `Cashier`, `WarehouseClerk`, `Purchaser`, `Accountant`, `Auditor`) plus custom tenant-defined roles.
- **FR-RBAC-02**: Permission assignment scoped by **Organization**, **Branch(es)**, or **Warehouse(s)** (e.g., a Branch Manager at Branch A cannot view or modify stock or POS shifts at Branch B unless granted cross-branch scope).
- **FR-RBAC-03**: Sensitive action policies (e.g., discount > 15%, voiding a completed sale, negative stock override, price override below cost) require supervisor PIN/token authorization or specific permission grants, logged in the security audit trail.

### 3.8 Subscription & Entitlement Management (`SUB`)
- **FR-SUB-01**: Tiered SaaS plans (`Starter`, `Growth`, `Enterprise`) governing hard and soft quotas:
  - Maximum active branches & warehouses
  - Maximum registered POS terminals/devices
  - Maximum active users
  - Feature entitlements (e.g., multi-currency, batch/serial tracking, API access)
- **FR-SUB-02**: Subscription lifecycle states (`TRIALING`, `ACTIVE`, `PAST_DUE`, `GRACE_PERIOD`, `SUSPENDED`, `CANCELLED`).
- **FR-SUB-03**: Graceful degradation during `PAST_DUE` / `GRACE_PERIOD` (warnings in UI, block creation of new branches/registers) before read-only enforcement in `SUSPENDED` state, ensuring merchants do not lose access to historical tax/financial records.
- **FR-SUB-04**: **Provider-Neutral Subscription Billing (`UD-05`)**:
  - Initially support **admin-provisioned plans, trials, subscription lifecycle management, subscription invoices, and manual/recorded payment records** (`BANK_TRANSFER`, `MANUAL_RECEIPT`, `EXTERNAL_GATEWAY_REF`) without requiring a mandatory automated payment gateway.
  - Define a strict server-side `SubscriptionBillingPort` adapter interface to plug in automated billing gateways in the future only after verifying merchant eligibility, **Sri Lankan business entity support, LKR/USD settlement & payout availability**, foreign exchange regulations, fees, and compliance requirements.
  - Keep all payment-provider credentials and webhook signature verifiers strictly server-side.

### 3.9 Internationalization (i18n), Localization (l10n) & Multi-Currency (`I18N`)
- **FR-I18N-01**: Full UI localization framework supporting LTR and RTL (e.g., Arabic, Hebrew) layouts across Web, Desktop, and Mobile.
- **FR-I18N-02**: Multi-currency monetary storage using exact integer minor units (`amount_minor` + ISO 4217 `currency_code` + `decimal_places`) or exact fixed-point `NUMERIC(19, 4)` with explicit rounding modes (Half-Even / Banker's Rounding or jurisdiction-specific cash rounding).
- **FR-I18N-03**: Exchange rate table per tenant with effective timestamps; every foreign-currency transaction stores an immutable `exchange_rate_snapshot` to the tenant's base currency.
- **FR-I18N-04**: Region-aware formatting for dates, numbers, addresses, tax identifiers (VAT/GST/TIN), and thermal receipt templates (58mm / 80mm ESC/POS and PDF).

---

## 4. Non-Functional Requirements (NFRs)

| Category | Target Requirement | Architectural Mechanism |
| :--- | :--- | :--- |
| **POS Local Latency** | `< 50 ms` barcode scan-to-cart; `< 150 ms` local checkout commit | Local SQLite database with indexed SKU/barcode tables and local write-ahead queue |
| **API Latency (Online)** | `p95 < 200 ms` for standard reads/writes; `p99 < 500 ms` | Indexed PostgreSQL queries, connection pooling, bounded batch sizes |
| **Data Integrity** | Zero lost financial transactions or unrecorded stock mutations | ACID PostgreSQL transactions, append-only ledgers, client-generated idempotency keys |
| **Tenant Isolation** | Zero cross-tenant data leakage | Defence-in-depth: Application context guard + PostgreSQL RLS on all tenant tables |
| **Offline Resilience** | 72+ hours of autonomous offline POS & stock count operation per terminal | Deterministic local command log + delta pull sync + conflict resolution policies |
| **Availability** | `99.9%` cloud API uptime target; `100%` local terminal availability (hardware permitting) | Stateless API tier, health checks, zero-downtime additive DB migrations |
| **Audit Retention** | 7+ years immutable financial & stock ledger retention | Append-only partitioned ledger tables; soft-delete/archival only for master data |

---

## 5. Key Assumptions & Constraints

1. **Device Enrollment**: Offline-capable POS terminals and warehouse scanners must be explicitly registered and bound to a single Tenant and default Branch/Warehouse while online before entering offline operation.
2. **Stock Reservation vs. Offline Reality**: When multiple POS terminals operate offline simultaneously, physical customers standing at a register hold the physical item in their hand. Therefore, offline POS sales must always be accepted (`ALLOW_NEGATIVE_ON_CONFLICT`) and reconciled via post-sync variance flags rather than rejecting a completed physical sale during sync.
3. **Regulatory Fiscalization**: Certain countries (e.g., Germany KassenSichV/TSE, Italy, Kenya TIMS, Brazil NF-e) mandate country-specific fiscal signing modules. The architecture must provide a pluggable `FiscalReceiptSigner` interface per branch jurisdiction without hardcoding a single country's fiscal law into the core POS engine.
