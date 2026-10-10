# Zoho Commerce read-only integration expansion

## Phase 1 — Verified API and isolated snapshot storage

- Confirm endpoint and OAuth scope for each requested dashboard area using Zoho's official API docs.
- Add an RLS-protected source snapshot store isolated from marketplace orders, payments, and customers.
- Sync documented read resources with bounded pagination, per-resource outcomes, and last-known-good batch behavior.

## Phase 2 — Admin review interface and accurate capability map

- Add admin-only record views that expose response fields only to authenticated administrators.
- Show summaries derived from imported orders with clear labels distinguishing them from Zoho reports.
- Mark unverified or unavailable dashboard modules clearly and avoid requesting write scopes.

## Phase 3 — Documentation, build verification, commit, and push

- Document precise scopes, migration steps, supported records, and unsupported areas.
- Run a production build and review the complete diff for secrets, authorization gaps, and unrelated changes.
- Commit on a new feature branch and push it without rewriting existing history.

## Status

Phase 1 API mapping and implementation are complete. The current implementation covers verified category, sales-order, tax, store-index, and published store-metadata reads, with existing product/coupon sync retained separately. Phase 2 admin presentation and capability mapping are complete. Phase 3 production build and diff review are complete; the feature is committed on `codex/zoho-commerce-data-mirror`.
