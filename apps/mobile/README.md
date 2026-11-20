# NexStock Mobile (`apps/mobile`)

## Phase 9.1 – 9.4 Offline POS Status

- **Runtime Engine (`@nexstock/mobile`)**:
  - Uses the shared [`@nexstock/offline-engine`](../../packages/offline-engine) and canonical SQLite `STRICT` migrations `0001..0008` in [`packages/sqlite-schema/migrations/`](../../packages/sqlite-schema/migrations/).
  - Provides `MobileOfflinePosRuntime` with camera barcode normalization (`parseMobileCameraBarcodeScan` for GS1-128, `NB-...` internal batch codes, EAN-13, UPC-A, and QR), catalog search, FEFO/FIFO batch pricing, cascading tax math (`@nexstock/domain-core`), local cash checkout, local `OFF-*` receipts (`PENDING_SYNC`), Option A stock balance projection, and restart recovery.
- **Browser / Mobile PWA Runtime (`apps/web/public`)**:
  - Ships touch-responsive Mobile POS (`360px`–`430px` viewports), Service Worker (`sw.js`), Web App Manifest (`manifest.webmanifest`), camera scanning (`getUserMedia` + `BarcodeDetector`), and persistent **IndexedDB (`nexstock_offline_v1`)** storage.
- **Flutter/Dart Toolchain Note**:
  - Flutter/Dart SDK is not currently installed on the build host, so no Dart binary compilation was claimed; cross-language TypeScript-to-SQLite parity is verified via `node:sqlite` + Vitest tests in `@nexstock/mobile` and headless Edge CDP responsive tests across mobile viewports.
