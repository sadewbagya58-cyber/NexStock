use crate::db::DesktopDbState;
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use uuid::Uuid;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimeStatus {
    pub schema_version: i64,
    pub db_path: String,
    pub pending_outbox_count: i64,
    pub quarantined_outbox_count: i64,
    pub queued_print_jobs: i64,
    pub cached_batches_count: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineBarcodeLookupRequest {
    pub tenant_id: String,
    pub warehouse_id: String,
    pub code: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineBarcodeResolution {
    pub match_type: String,
    pub product_id: Option<String>,
    pub sku: Option<String>,
    pub name: Option<String>,
    pub base_uom: Option<String>,
    pub batch_id: Option<String>,
    pub batch_number: Option<String>,
    pub internal_barcode: Option<String>,
    pub available_quantity: Option<String>,
    pub selling_price: Option<String>,
    pub pricing_source: Option<String>,
    pub expiry_date: Option<String>,
    pub allocation_policy: Option<String>,
    pub is_blocked: bool,
    pub block_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OfflineSaleLineInput {
    pub product_id: String,
    pub sku: String,
    pub product_name: String,
    pub batch_id: Option<String>,
    pub uom_code: String,
    pub quantity: String,
    pub unit_price: String,
    pub unit_cost_snapshot: String,
    pub line_total: String,
    pub entry_source: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueOfflineSaleRequest {
    pub tenant_id: String,
    pub branch_id: String,
    pub warehouse_id: String,
    pub register_id: String,
    pub shift_id: String,
    pub cashier_user_id: String,
    pub device_id: String,
    pub currency_code: String,
    pub grand_total: String,
    pub payment_method: String,
    pub tendered_amount: String,
    pub customer_id: Option<String>,
    pub customer_name: Option<String>,
    pub lines: Vec<OfflineSaleLineInput>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueOfflineSaleResult {
    pub invoice_id: String,
    pub invoice_number: String,
    pub command_id: String,
    pub outbox_status: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuePrintJobRequest {
    pub tenant_id: String,
    pub branch_id: Option<String>,
    pub product_id: String,
    pub batch_id: String,
    pub barcode_value: String,
    pub label_format: String,
    pub print_quantity: i64,
    pub is_reprint: bool,
    pub printed_by_user_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlushSyncOutboxRequest {
    pub api_base_url: String,
    pub bearer_token: String,
    pub tenant_id: String,
    pub device_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlushSyncOutboxResult {
    pub submitted: usize,
    pub applied: usize,
    pub duplicates: usize,
    pub quarantined: usize,
    pub errors: Vec<String>,
}

#[tauri::command]
pub fn desktop_get_status(db: State<'_, DesktopDbState>) -> Result<DesktopRuntimeStatus, String> {
    let conn = db.conn.lock().map_err(|_| "DB lock poisoned".to_string())?;

    let schema_version: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM nexstock_schema_migrations",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let pending_outbox_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_sync_outbox WHERE status = 'PENDING'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let quarantined_outbox_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_sync_outbox WHERE status = 'QUARANTINED'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let queued_print_jobs: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM local_batch_barcode_print_queue WHERE synced = 0",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let cached_batches_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM local_batch_pricing_profiles", [], |r| {
            r.get(0)
        })
        .unwrap_or(0);

    Ok(DesktopRuntimeStatus {
        schema_version,
        db_path: db.db_path.to_string_lossy().to_string(),
        pending_outbox_count,
        quarantined_outbox_count,
        queued_print_jobs,
        cached_batches_count,
    })
}

#[tauri::command]
pub fn desktop_save_sync_snapshot(
    db: State<'_, DesktopDbState>,
    tenant_id: String,
    snapshot_json: Value,
) -> Result<Value, String> {
    let mut conn = db.conn.lock().map_err(|_| "DB lock poisoned".to_string())?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed starting snapshot tx: {e}"))?;
    let now = Utc::now().to_rfc3339();

    if let Some(branding) = snapshot_json.get("branding") {
        let shop_display_name = branding
            .get("shopDisplayName")
            .and_then(|v| v.as_str())
            .map(ToOwned::to_owned);
        let logo_url = branding
            .get("logoUrl")
            .and_then(|v| v.as_str())
            .map(ToOwned::to_owned);
        let fallback_policy = snapshot_json
            .pointer("/policies/batchPricingFallbackPolicy")
            .and_then(|v| v.as_str())
            .unwrap_or("ALLOW_PRODUCT_FALLBACK");
        let alloc_policy = snapshot_json
            .pointer("/policies/defaultBatchAllocationPolicy")
            .and_then(|v| v.as_str())
            .unwrap_or("FEFO");

        tx.execute(
            "INSERT OR REPLACE INTO local_tenant_branding
             (tenant_id, shop_display_name, logo_url, batch_pricing_fallback_policy, default_batch_allocation_policy, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                tenant_id,
                shop_display_name,
                logo_url,
                fallback_policy,
                alloc_policy,
                now
            ],
        )
        .map_err(|e| format!("Failed saving local_tenant_branding: {e}"))?;
    }

    let mut batch_count = 0usize;
    if let Some(batches) = snapshot_json.get("batches").and_then(|v| v.as_array()) {
        for b in batches {
            let batch_id = b.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            let product_id = b.get("productId").and_then(|v| v.as_str()).unwrap_or_default();
            let warehouse_id = b.get("warehouseId").and_then(|v| v.as_str()).unwrap_or_default();
            let batch_number = b.get("batchNumber").and_then(|v| v.as_str()).unwrap_or_default();
            if batch_id.is_empty() || product_id.is_empty() || warehouse_id.is_empty() {
                continue;
            }
            let status = b.get("status").and_then(|v| v.as_str()).unwrap_or("ACTIVE");
            let avail_qty = b
                .get("availableQuantity")
                .and_then(|v| v.as_str())
                .unwrap_or("0.000000");
            let current_qty = b
                .get("currentQuantity")
                .and_then(|v| v.as_str())
                .unwrap_or(avail_qty);
            let reserved_qty = b
                .get("reservedQuantity")
                .and_then(|v| v.as_str())
                .unwrap_or("0.000000");
            let selling_price = b
                .get("sellingPrice")
                .and_then(|v| v.as_str())
                .map(ToOwned::to_owned);
            let min_price = b
                .get("minSellingPrice")
                .and_then(|v| v.as_str())
                .map(ToOwned::to_owned);
            let max_disc = b
                .get("maxDiscountPct")
                .and_then(|v| v.as_str())
                .map(ToOwned::to_owned);
            let pricing_mode = b
                .get("batchPricingMode")
                .and_then(|v| v.as_str())
                .unwrap_or(if selling_price.is_some() { "EXPLICIT" } else { "INHERIT_PRODUCT" });
            let internal_barcode = b
                .get("internalBarcode")
                .and_then(|v| v.as_str())
                .map(ToOwned::to_owned);
            let expiry_date = b
                .get("expiryDate")
                .and_then(|v| v.as_str())
                .map(ToOwned::to_owned);
            let branch_id = b
                .get("branchId")
                .and_then(|v| v.as_str())
                .map(ToOwned::to_owned);
            let unit_cost = b.get("unitCost").and_then(|v| v.as_str()).unwrap_or("0.0000");
            let received_date = b
                .get("receivedDate")
                .and_then(|v| v.as_str())
                .unwrap_or(&now);

            let base_status = match status {
                "QUARANTINED" => "QUARANTINED",
                "DEPLETED" => "DEPLETED",
                _ => "ACTIVE",
            };

            tx.execute(
                "INSERT OR REPLACE INTO local_inventory_batches
                 (id, tenant_id, product_id, warehouse_id, batch_number, supplier_id, status, received_date, manufacturing_date, expiry_date, initial_quantity, current_quantity, unit_cost, currency_code, quarantine_reason, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, NULL, ?8, ?9, ?9, ?10, 'LKR', NULL, ?11, ?11)",
                params![
                    batch_id,
                    tenant_id,
                    product_id,
                    warehouse_id,
                    batch_number,
                    base_status,
                    received_date,
                    expiry_date,
                    current_qty,
                    unit_cost,
                    now
                ],
            )
            .map_err(|e| format!("Failed saving local_inventory_batches: {e}"))?;

            tx.execute(
                "INSERT OR REPLACE INTO local_batch_pricing_profiles
                 (tenant_id, batch_id, product_id, warehouse_id, branch_id, batch_number, status, reserved_quantity, available_quantity, selling_price, min_selling_price, max_discount_pct, batch_pricing_mode, internal_barcode, internal_barcode_type, sync_version, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'CODE128', 1, ?15)",
                params![
                    tenant_id,
                    batch_id,
                    product_id,
                    warehouse_id,
                    branch_id,
                    batch_number,
                    status,
                    reserved_qty,
                    avail_qty,
                    selling_price,
                    min_price,
                    max_disc,
                    pricing_mode,
                    internal_barcode,
                    now
                ],
            )
            .map_err(|e| format!("Failed saving local_batch_pricing_profiles: {e}"))?;
            batch_count += 1;
        }
    }

    tx.commit()
        .map_err(|e| format!("Failed committing snapshot tx: {e}"))?;

    Ok(json!({ "savedBatches": batch_count, "updatedAt": now }))
}

#[tauri::command]
pub fn desktop_resolve_barcode(
    db: State<'_, DesktopDbState>,
    req: OfflineBarcodeLookupRequest,
) -> Result<OfflineBarcodeResolution, String> {
    let conn = db.conn.lock().map_err(|_| "DB lock poisoned".to_string())?;
    let trimmed = req.code.trim().to_string();

    // 1. Direct internal batch barcode match (never auto-switches batch)
    let direct_batch: Option<(String, String, String, String, String, String, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT bp.batch_id, bp.product_id, bp.batch_number, bp.status, bp.available_quantity, bp.batch_pricing_mode, bp.selling_price, ib.expiry_date
             FROM local_batch_pricing_profiles bp
             JOIN local_inventory_batches ib ON ib.tenant_id = bp.tenant_id AND ib.id = bp.batch_id
             WHERE bp.tenant_id = ?1 AND bp.internal_barcode = ?2 AND bp.warehouse_id = ?3",
            params![req.tenant_id, trimmed, req.warehouse_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("Failed querying local batch barcode: {e}"))?;

    if let Some((batch_id, product_id, batch_number, status, avail_qty, pricing_mode, selling_price, expiry_date)) = direct_batch {
        let today = Utc::now().format("%Y-%m-%d").to_string();
        let is_expired = status == "EXPIRED"
            || expiry_date.as_deref().map(|d| d < today.as_str()).unwrap_or(false);
        let prod: Option<(String, String, String, i64)> = conn
            .query_row(
                "SELECT sku, name, base_uom, selling_price_scaled FROM local_products WHERE tenant_id = ?1 AND id = ?2",
                params![req.tenant_id, product_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .unwrap_or(None);
        let fallback_price = prod
            .as_ref()
            .map(|p| format!("{:.4}", (p.3 as f64) / 10000.0));
        let eff_price = selling_price.clone().or_else(|| {
            if pricing_mode == "INHERIT_PRODUCT" {
                fallback_price
            } else {
                None
            }
        });

        return Ok(OfflineBarcodeResolution {
            match_type: "INTERNAL_BATCH_BARCODE".to_string(),
            product_id: Some(product_id),
            sku: prod.as_ref().map(|p| p.0.clone()),
            name: prod.as_ref().map(|p| p.1.clone()),
            base_uom: prod.as_ref().map(|p| p.2.clone()),
            batch_id: Some(batch_id),
            batch_number: Some(batch_number),
            internal_barcode: Some(trimmed),
            available_quantity: Some(avail_qty),
            selling_price: eff_price,
            pricing_source: if selling_price.is_some() {
                Some("EXPLICIT_BATCH_PRICE".to_string())
            } else {
                Some("PRODUCT_DEFAULT_FALLBACK".to_string())
            },
            expiry_date,
            allocation_policy: Some("MANUAL".to_string()),
            is_blocked: is_expired || status != "ACTIVE",
            block_reason: if is_expired {
                Some("POS_BATCH_EXPIRED".to_string())
            } else if status != "ACTIVE" {
                Some("POS_BATCH_UNSELLABLE".to_string())
            } else {
                None
            },
        });
    }

    // 2. Fallback to product primary / alternate barcode -> select FEFO active batch
    let prod_row: Option<(String, String, String, String, i64)> = conn
        .query_row(
            "SELECT id, sku, name, base_uom, selling_price_scaled
             FROM local_products
             WHERE tenant_id = ?1 AND (primary_barcode = ?2 OR id IN (SELECT product_id FROM local_product_barcodes WHERE tenant_id = ?1 AND barcode = ?2))",
            params![req.tenant_id, trimmed],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .map_err(|e| format!("Failed querying local_products: {e}"))?;

    if let Some((product_id, sku, name, base_uom, selling_price_scaled)) = prod_row {
        let today = Utc::now().format("%Y-%m-%d").to_string();
        let next_batch: Option<(String, String, String, Option<String>, Option<String>, Option<String>)> = conn
            .query_row(
                "SELECT bp.batch_id, bp.batch_number, bp.available_quantity, bp.selling_price, ib.expiry_date, bp.internal_barcode
                 FROM local_batch_pricing_profiles bp
                 JOIN local_inventory_batches ib ON ib.tenant_id = bp.tenant_id AND ib.id = bp.batch_id
                 WHERE bp.tenant_id = ?1 AND bp.product_id = ?2 AND bp.warehouse_id = ?3
                   AND bp.status = 'ACTIVE'
                   AND CAST(bp.available_quantity AS REAL) > 0
                   AND (ib.expiry_date IS NULL OR ib.expiry_date >= ?4)
                 ORDER BY CASE WHEN ib.expiry_date IS NULL THEN 1 ELSE 0 END ASC, ib.expiry_date ASC, ib.received_date ASC
                 LIMIT 1",
                params![req.tenant_id, product_id, req.warehouse_id, today],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .optional()
            .unwrap_or(None);

        let fallback_price = format!("{:.4}", (selling_price_scaled as f64) / 10000.0);
        return Ok(OfflineBarcodeResolution {
            match_type: "PRODUCT_BARCODE".to_string(),
            product_id: Some(product_id),
            sku: Some(sku),
            name: Some(name),
            base_uom: Some(base_uom),
            batch_id: next_batch.as_ref().map(|b| b.0.clone()),
            batch_number: next_batch.as_ref().map(|b| b.1.clone()),
            internal_barcode: next_batch.as_ref().and_then(|b| b.5.clone()),
            available_quantity: next_batch.as_ref().map(|b| b.2.clone()),
            selling_price: next_batch
                .as_ref()
                .and_then(|b| b.3.clone())
                .or(Some(fallback_price)),
            pricing_source: if next_batch.as_ref().and_then(|b| b.3.clone()).is_some() {
                Some("EXPLICIT_BATCH_PRICE".to_string())
            } else {
                Some("PRODUCT_DEFAULT_FALLBACK".to_string())
            },
            expiry_date: next_batch.and_then(|b| b.4),
            allocation_policy: Some("FEFO".to_string()),
            is_blocked: false,
            block_reason: None,
        });
    }

    Ok(OfflineBarcodeResolution {
        match_type: "NOT_FOUND".to_string(),
        product_id: None,
        sku: None,
        name: None,
        base_uom: None,
        batch_id: None,
        batch_number: None,
        internal_barcode: None,
        available_quantity: None,
        selling_price: None,
        pricing_source: None,
        expiry_date: None,
        allocation_policy: None,
        is_blocked: false,
        block_reason: None,
    })
}

#[tauri::command]
pub fn desktop_queue_offline_sale(
    db: State<'_, DesktopDbState>,
    req: QueueOfflineSaleRequest,
) -> Result<QueueOfflineSaleResult, String> {
    let mut conn = db.conn.lock().map_err(|_| "DB lock poisoned".to_string())?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed starting offline sale tx: {e}"))?;

    let now = Utc::now().to_rfc3339();
    let invoice_id = Uuid::new_v4().to_string();
    let command_id = Uuid::new_v4().to_string();
    let idempotency_key = Uuid::new_v4().to_string();
    let invoice_number = format!(
        "OFF-{}",
        &invoice_id.replace('-', "")[..10].to_uppercase()
    );

    tx.execute(
        "INSERT INTO local_sales_invoices
         (id, tenant_id, branch_id, warehouse_id, register_id, shift_id, customer_id, cashier_user_id, invoice_number, status, currency_code, subtotal_amount, grand_total, total_paid, customer_name, idempotency_key, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'COMPLETED', ?10, ?11, ?11, ?11, ?12, ?13, ?14)",
        params![
            invoice_id,
            req.tenant_id,
            req.branch_id,
            req.warehouse_id,
            req.register_id,
            req.shift_id,
            req.customer_id,
            req.cashier_user_id,
            invoice_number,
            req.currency_code,
            req.grand_total,
            req.customer_name,
            idempotency_key,
            now
        ],
    )
    .map_err(|e| format!("Failed inserting local_sales_invoices: {e}"))?;

    let mut payload_lines = Vec::with_capacity(req.lines.len());
    for (idx, line) in req.lines.iter().enumerate() {
        let line_id = Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO local_sales_invoice_lines
             (id, tenant_id, invoice_id, line_number, product_id, sku, product_name, uom_code, quantity, unit_price, line_total, unit_cost_snapshot, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                line_id,
                req.tenant_id,
                invoice_id,
                (idx + 1) as i64,
                line.product_id,
                line.sku,
                line.product_name,
                line.uom_code,
                line.quantity,
                line.unit_price,
                line.line_total,
                line.unit_cost_snapshot,
                now
            ],
        )
        .map_err(|e| format!("Failed inserting local_sales_invoice_lines: {e}"))?;

        if let Some(batch_id) = &line.batch_id {
            tx.execute(
                "INSERT INTO local_sales_line_batch_links
                 (line_id, tenant_id, invoice_id, batch_id, serial_id, unit_cost_snapshot, selling_price_snapshot, created_at)
                 VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7)",
                params![
                    line_id,
                    req.tenant_id,
                    invoice_id,
                    batch_id,
                    line.unit_cost_snapshot,
                    line.unit_price,
                    now
                ],
            )
            .map_err(|e| format!("Failed inserting local_sales_line_batch_links: {e}"))?;

            let qty_val: f64 = line.quantity.parse().unwrap_or(0.0);
            if qty_val > 0.0 {
                tx.execute(
                    "UPDATE local_batch_pricing_profiles
                     SET available_quantity = printf('%.6f', MAX(0.0, CAST(available_quantity AS REAL) - ?1)), updated_at = ?2
                     WHERE tenant_id = ?3 AND batch_id = ?4",
                    params![qty_val, now, req.tenant_id, batch_id],
                )
                .map_err(|e| format!("Failed decrementing local batch qty: {e}"))?;
            }
        }

        payload_lines.push(json!({
            "productId": line.product_id,
            "batchId": line.batch_id,
            "quantity": line.quantity,
            "uomCode": line.uom_code,
            "entrySource": line.entry_source,
            "unitPrice": line.unit_price
        }));
    }

    let command_payload = json!({
        "registerId": req.register_id,
        "shiftId": req.shift_id,
        "customerId": req.customer_id,
        "customerName": req.customer_name,
        "lines": payload_lines,
        "payments": [{
            "paymentMethod": req.payment_method,
            "amount": req.grand_total,
            "tenderedAmount": req.tendered_amount
        }],
        "offlineInvoiceNumber": invoice_number
    });

    tx.execute(
        "INSERT INTO local_sync_outbox
         (command_id, tenant_id, branch_id, device_id, actor_user_id, command_type, schema_version, payload_json, occurred_at, status)
         VALUES (?1, ?2, ?3, ?4, ?5, 'POS_RECORD_SALE', 1, ?6, ?7, 'PENDING')",
        params![
            command_id,
            req.tenant_id,
            req.branch_id,
            req.device_id,
            req.cashier_user_id,
            command_payload.to_string(),
            now
        ],
    )
    .map_err(|e| format!("Failed inserting local_sync_outbox: {e}"))?;

    tx.commit()
        .map_err(|e| format!("Failed committing offline sale: {e}"))?;

    Ok(QueueOfflineSaleResult {
        invoice_id,
        invoice_number,
        command_id,
        outbox_status: "PENDING".to_string(),
    })
}

#[tauri::command]
pub fn desktop_queue_print_job(
    db: State<'_, DesktopDbState>,
    req: QueuePrintJobRequest,
) -> Result<Value, String> {
    let conn = db.conn.lock().map_err(|_| "DB lock poisoned".to_string())?;
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO local_batch_barcode_print_queue
         (id, tenant_id, branch_id, product_id, batch_id, barcode_value, label_format, print_quantity, is_reprint, printed_by_user_id, printed_at, synced)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0)",
        params![
            id,
            req.tenant_id,
            req.branch_id,
            req.product_id,
            req.batch_id,
            req.barcode_value,
            req.label_format,
            req.print_quantity,
            if req.is_reprint { 1 } else { 0 },
            req.printed_by_user_id,
            now
        ],
    )
    .map_err(|e| format!("Failed inserting print queue job: {e}"))?;

    Ok(json!({
        "id": id,
        "queuedAt": now,
        "labelFormat": req.label_format,
        "printQuantity": req.print_quantity
    }))
}

#[tauri::command]
pub async fn desktop_flush_sync_outbox(
    db: State<'_, DesktopDbState>,
    req: FlushSyncOutboxRequest,
) -> Result<FlushSyncOutboxResult, String> {
    let pending_rows: Vec<(String, String, String, String, i64, String, String)> = {
        let conn = db.conn.lock().map_err(|_| "DB lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT command_id, branch_id, device_id, command_type, schema_version, payload_json, occurred_at
                 FROM local_sync_outbox
                 WHERE tenant_id = ?1 AND status = 'PENDING'
                 ORDER BY local_seq ASC
                 LIMIT 50",
            )
            .map_err(|e| format!("Failed preparing outbox query: {e}"))?;
        let rows = stmt
            .query_map(params![req.tenant_id], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            })
            .map_err(|e| format!("Failed reading outbox: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed collecting outbox: {e}"))?
    };

    if pending_rows.is_empty() {
        return Ok(FlushSyncOutboxResult {
            submitted: 0,
            applied: 0,
            duplicates: 0,
            quarantined: 0,
            errors: vec![],
        });
    }

    let commands_json: Vec<Value> = pending_rows
        .iter()
        .map(
            |(cmd_id, branch_id, dev_id, cmd_type, schema_ver, payload_str, occurred_at)| {
                let payload_val: Value =
                    serde_json::from_str(payload_str).unwrap_or_else(|_| json!({}));
                json!({
                    "commandId": cmd_id,
                    "deviceId": dev_id,
                    "branchId": branch_id,
                    "commandType": cmd_type,
                    "schemaVersion": schema_ver,
                    "occurredAt": occurred_at,
                    "payload": payload_val
                })
            },
        )
        .collect();

    let client = reqwest::Client::new();
    let url = format!("{}/v1/sync/push", req.api_base_url.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .header("authorization", format!("Bearer {}", req.bearer_token))
        .header("x-tenant-id", &req.tenant_id)
        .header("content-type", "application/json")
        .json(&json!({
            "deviceId": req.device_id,
            "commands": commands_json
        }))
        .send()
        .await
        .map_err(|e| format!("Sync push network failure: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Sync push failed ({status}): {text}"));
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid sync push response JSON: {e}"))?;
    let acked = body.get("ackedCommandIds").and_then(|v| v.as_array());
    let quarantined_arr = body.get("quarantinedCommands").and_then(|v| v.as_array());

    let conn = db.conn.lock().map_err(|_| "DB lock poisoned".to_string())?;
    let now = Utc::now().to_rfc3339();
    if let Some(arr) = acked {
        for item in arr {
            if let Some(cmd_id) = item.as_str() {
                let _ = conn.execute(
                    "UPDATE local_sync_outbox SET status = 'SYNCED', server_ack_at = ?1 WHERE command_id = ?2",
                    params![now, cmd_id],
                );
            }
        }
    }
    let mut err_msgs = Vec::new();
    if let Some(arr) = quarantined_arr {
        for item in arr {
            if let Some(cmd_id) = item.get("commandId").and_then(|v| v.as_str()) {
                let reason = item
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Quarantined by server");
                err_msgs.push(format!("{cmd_id}: {reason}"));
                let _ = conn.execute(
                    "UPDATE local_sync_outbox SET status = 'QUARANTINED', last_error = ?1 WHERE command_id = ?2",
                    params![reason, cmd_id],
                );
            }
        }
    }

    Ok(FlushSyncOutboxResult {
        submitted: pending_rows.len(),
        applied: body.get("appliedCount").and_then(|v| v.as_u64()).unwrap_or(0) as usize,
        duplicates: body
            .get("duplicateCount")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize,
        quarantined: body
            .get("quarantinedCount")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize,
        errors: err_msgs,
    })
}
