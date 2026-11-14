export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      preorder_watch: { Row: { branch_id: string; product_id: string; zoho_last: number; held: number; held_since: string | null; opened_at: string; read_at: string; last_waiting: number; last_unbilled: number; last_raw: number | null; updated_at: string; pending_delta: number; suspect_lines: string[]; suspect_cap: number; push_pending: number | null; push_delta: number | null; push_started_at: string | null }; Insert: never; Update: never; Relationships: [] }
      batch_lot_events: { Row: { id: number; batch_id: string | null; branch_id: string; product_id: string; kind: string; qty: number | null; detail: Json; by_user: string | null; by_name: string; note: string; created_at: string }; Insert: never; Update: never; Relationships: [] }
      zoho_bill_line_cache: { Row: { bill_id: string; modified: string; bill_number: string; bill_date: string | null; created_time: string; status: string; location_id: string; vendor_name: string; lines: Json; fetched_at: string }; Insert: { bill_id: string; modified: string; bill_number?: string; bill_date?: string | null; created_time?: string; status?: string; location_id?: string; vendor_name?: string; lines?: Json; fetched_at?: string }; Update: { bill_id?: string; modified?: string; bill_number?: string; bill_date?: string | null; created_time?: string; status?: string; location_id?: string; vendor_name?: string; lines?: Json; fetched_at?: string }; Relationships: [] }
      zoho_cost_documents: { Row: { id: number; source: string; zoho_id: string; zoho_line_id: string; doc_number: string; doc_date: string; account_id: string; account_name: string; vendor_name: string; description: string; location_id: string; currency_code: string; amount_before_gst: number; gst_amount: number; gst_claimable: boolean; gst_override: boolean | null; reverse_charge: boolean; rebilled: boolean; cost_amount: number; accepted_cost_amount: number | null; zoho_status: string; zoho_modified: string; flag: string; flag_at: string | null; gone_at: string | null; fetched_at: string; checked_at: string | null }; Insert: never; Update: never; Relationships: [] }
      batch_cost_tags: { Row: { id: number; document_id: number; batch_id: string; amount: number; method: string; weight: number; note: string; tagged_by: string | null; tagged_by_name: string; tagged_at: string }; Insert: never; Update: never; Relationships: [] }
      batch_cost_tag_events: { Row: { id: number; document_id: number; action: string; before: Json; after: Json; by_id: string | null; by_name: string; at: string }; Insert: never; Update: never; Relationships: [] }
      partner_payouts: { Row: { id: string; payout_no: string; partner_id: string; branch_id: string; paid_on: string; amount: number; lines_total: number; recovered_total: number; mode: string; reference: string; note: string; period_from: string | null; period_to: string | null; status: string; request_key: string | null; created_by: string; created_by_name: string; created_at: string; voided_at: string | null; voided_by: string | null; voided_by_name: string; void_reason: string; statement_id: string | null }; Insert: never; Update: never; Relationships: [] }
      godown_commission_schemes: { Row: { id: string; branch_id: string; from_month: string; starts_at: string; scheme: string; share_percent: number | null; tax_percent: number; updated_by: string | null; updated_by_name: string; updated_at: string }; Insert: never; Update: never; Relationships: [] }
      partner_payout_lines: { Row: { id: string; payout_id: string; order_item_id: string; order_id: string | null; order_no: string; partner_id: string; product_name: string; placed_at: string; amount: number }; Insert: never; Update: never; Relationships: [] }
      partner_payout_events: { Row: { id: string; payout_id: string; event: string; at: string; by_user: string | null; by_name: string; detail: Json }; Insert: never; Update: never; Relationships: [] }
      deleted_payments_log: { Row: { id: string; kind: string; order_no: string; payment: Json; order_paid_before: number; order_paid_after: number; reason: string; deleted_by: string; deleted_by_name: string; deleted_at: string }; Insert: never; Update: never; Relationships: [] }
      deleted_orders_log: { Row: { id: number; order_no: string; order_status: string; total: number; item_count: number; order_created_at: string | null; reason: string; deleted_by: string | null; deleted_by_name: string; deleted_at: string; utrs: string; zoho_salesorder_id: string; zoho_order_status: string; snapshot: Json | null }; Insert: never; Update: never; Relationships: [] }
      order_cancellations: { Row: { id: string; order_id: string; order_no: string; stage: string; goods_back: boolean | null; refunded: number; reason: string; cancelled_by: string | null; cancelled_by_name: string; cancelled_at: string; placed_again_at: string | null; placed_again_by_name: string | null; earlier: Json | null }; Insert: never; Update: never; Relationships: [] }
      order_refunds: { Row: { id: string; order_id: string; order_no: string; payment_id: string | null; paid_ref: string; amount: number; mode: string; reference: string; refunded_on: string; created_by: string | null; created_by_name: string; created_at: string; zoho_payment_id: string | null; zoho_refund_id: string | null; zoho_claimed_at: string | null; zoho_refunded_at: string | null; zoho_problem: string | null }; Insert: never; Update: { zoho_payment_id?: string | null; zoho_refund_id?: string | null; zoho_claimed_at?: string | null; zoho_refunded_at?: string | null; zoho_problem?: string | null }; Relationships: [] }
      refunded_transfers: { Row: { id: number; utr: string; order_no: string; amount: number | null; source: string; refunded_at: string }; Insert: never; Update: never; Relationships: [] }
      branches: {
        Row: { signature_path: string | null; id: string; code: string; name: string; address: string; city: string; state: string; state_code: string; pincode: string; phone: string; email: string; map_url: string; instructions: string; gstin: string; zoho_location_id: string; zoho_location_name: string; zoho_pricebook_id: string; zoho_pricebook_name: string; serves_pincodes: string[]; pickup_enabled: boolean; delivery_enabled: boolean; delivery_fee: number; free_delivery_above: number | null; is_default: boolean; active: boolean; sort_order: number; created_at: string; updated_at: string; vendor_id: string | null; latitude: number | null; longitude: number | null; attendance_radius_m: number; shift_start: string; late_grace_min: number; weekly_off: number | null; shift_end: string; presence_interval_min: number }
        Insert: { signature_path?: string | null; id: string; code: string; name: string; address?: string; city?: string; state?: string; state_code?: string; pincode?: string; phone?: string; email?: string; map_url?: string; instructions?: string; gstin?: string; zoho_location_id?: string; zoho_location_name?: string; zoho_pricebook_id?: string; zoho_pricebook_name?: string; serves_pincodes?: string[]; pickup_enabled?: boolean; delivery_enabled?: boolean; delivery_fee?: number; free_delivery_above?: number | null; is_default?: boolean; active?: boolean; sort_order?: number; created_at?: string; updated_at?: string; vendor_id?: string | null; latitude?: number | null; longitude?: number | null; attendance_radius_m?: number; shift_start?: string; late_grace_min?: number; weekly_off?: number | null; shift_end?: string; presence_interval_min?: number }
        Update: { signature_path?: string | null; id?: string; code?: string; name?: string; address?: string; city?: string; state?: string; state_code?: string; pincode?: string; phone?: string; email?: string; map_url?: string; instructions?: string; gstin?: string; zoho_location_id?: string; zoho_location_name?: string; zoho_pricebook_id?: string; zoho_pricebook_name?: string; serves_pincodes?: string[]; pickup_enabled?: boolean; delivery_enabled?: boolean; delivery_fee?: number; free_delivery_above?: number | null; is_default?: boolean; active?: boolean; sort_order?: number; created_at?: string; updated_at?: string; vendor_id?: string | null; latitude?: number | null; longitude?: number | null; attendance_radius_m?: number; shift_start?: string; late_grace_min?: number; weekly_off?: number | null; shift_end?: string; presence_interval_min?: number }
        Relationships: []
      }
      rice_samples: {
        Row: { id: string; sample_no: number; arrival_date: string; variety: string; method: string; price_per_qntl: number; quantity_qntl: number; quantity_bags: number | null; bag_kg: number | null; party_role: string; party_name: string; party_phone: string; seller_name: string; notes: string; status: string; status_reason: string; status_changed_at: string; created_by: string | null; created_by_name: string; created_at: string; updated_at: string; deleted_at: string | null; deleted_by: string | null; deleted_by_name: string; deleted_reason: string }
        Insert: never
        Update: never
        Relationships: []
      }
      rice_sample_tests: {
        Row: { moisture_percent: number | null; glazing: string; id: string; sample_id: string; tested_at: string; tested_by_name: string; score: number; grain: string; swelling: string; taste: string; broken: string; notes: string; recorded_by: string | null; recorded_at: string }
        Insert: never
        Update: never
        Relationships: []
      }
      rice_sample_events: {
        Row: { id: number; sample_id: string; action: string; from_status: string | null; to_status: string | null; detail: string; actor: string | null; actor_name: string; at: string }
        Insert: never
        Update: never
        Relationships: []
      }
      rice_sample_purchase_orders: {
        Row: { sample_id: string; reference: string; state: string; generation: number; retired_pos: Json; attempt_id: string; attempts: number; snapshot: Json; claimed_by: string | null; claimed_by_name: string; claimed_at: string; last_error: string; last_error_detail: string; zoho_po_id: string; zoho_po_number: string; zoho_po_status: string; zoho_sub_total: number | null; zoho_tax_total: number | null; zoho_total: number | null; differences: string[]; duplicates: Json; zoho_gone: boolean; zoho_checked_at: string | null; raised_at: string | null; raised_by: string | null; raised_by_name: string; updated_at: string }
        Insert: never
        Update: never
        Relationships: []
      }
      price_lots: {
        Row: { id: string; lot_code: string; purchase_date: string | null; order_folio: string; factory: string; item: string; product_id: string | null; branch_id: string | null; quantity_qntl: number; price: number; commission: number; gst_rate: number; transport: number; amali_transport: number; amali_shami: number; driver_tips: number; unloading: number; margin: number; bag_kg: number; gst: number; landing_price: number; selling_qntl: number; selling_bag: number; applied_price: number | null; applied_branch_id: string | null; applied_at: string | null; notes: string; created_by: string | null; created_at: string; updated_at: string }
        Insert: { id?: string; lot_code?: string; purchase_date?: string | null; order_folio?: string; factory?: string; item?: string; product_id?: string | null; branch_id?: string | null; quantity_qntl?: number; price?: number; commission?: number; gst_rate?: number; transport?: number; amali_transport?: number; amali_shami?: number; driver_tips?: number; unloading?: number; margin?: number; bag_kg?: number; applied_price?: number | null; applied_branch_id?: string | null; applied_at?: string | null; notes?: string; created_by?: string | null; created_at?: string; updated_at?: string }
        Update: { id?: string; lot_code?: string; purchase_date?: string | null; order_folio?: string; factory?: string; item?: string; product_id?: string | null; branch_id?: string | null; quantity_qntl?: number; price?: number; commission?: number; gst_rate?: number; transport?: number; amali_transport?: number; amali_shami?: number; driver_tips?: number; unloading?: number; margin?: number; bag_kg?: number; applied_price?: number | null; applied_branch_id?: string | null; applied_at?: string | null; notes?: string; created_by?: string | null; created_at?: string; updated_at?: string }
        Relationships: []
      }
      branch_prices: {
        Row: { branch_id: string; product_id: string; price: number; listed: boolean; pending: boolean; updated_at: string }
        Insert: { branch_id: string; product_id: string; price: number; listed?: boolean; pending?: boolean; updated_at?: string }
        Update: { branch_id?: string; product_id?: string; price?: number; listed?: boolean; pending?: boolean; updated_at?: string }
        Relationships: []
      }
      branch_stock: {
        /** stock = ready (in Zoho, not promised); incoming = arriving units of pre-order batches on sale now; free_total = everything that may be promised (ready + arriving), set by the database. */
        Row: { branch_id: string; product_id: string; stock: number; zoho_pending: boolean; updated_at: string; free_total: number; incoming: number; incoming_detail: Json }
        Insert: { branch_id: string; product_id: string; stock?: number; zoho_pending?: boolean; updated_at?: string; free_total?: number; incoming?: number; incoming_detail?: Json }
        Update: { branch_id?: string; product_id?: string; stock?: number; zoho_pending?: boolean; updated_at?: string; free_total?: number; incoming?: number; incoming_detail?: Json }
        Relationships: []
      }
      zoho_oauth_states: {
        Row: { state_hash: string; user_id: string; organization_id: string; region: string; expires_at: string; created_at: string }
        Insert: { state_hash: string; user_id: string; organization_id: string; region: string; expires_at: string; created_at?: string }
        Update: { state_hash?: string; user_id?: string; organization_id?: string; region?: string; expires_at?: string; created_at?: string }
        Relationships: []
      }
      zoho_contact_links: {
        Row: { user_id: string; contact_type: string; zoho_contact_id: string; updated_at: string; last_polled_at: string | null; last_zoho_modified_at: string | null; zoho_contact_number: string | null; zoho_contact_number_checked_at: string | null }
        Insert: { user_id: string; contact_type: string; zoho_contact_id: string; updated_at?: string; last_polled_at?: string | null; last_zoho_modified_at?: string | null; zoho_contact_number?: string | null; zoho_contact_number_checked_at?: string | null }
        Update: { user_id?: string; contact_type?: string; zoho_contact_id?: string; updated_at?: string; last_polled_at?: string | null; last_zoho_modified_at?: string | null; zoho_contact_number?: string | null; zoho_contact_number_checked_at?: string | null }
        Relationships: []
      }
      zoho_item_links: {
        Row: { product_id: string; zoho_item_id: string; track_batches: boolean; updated_at: string; last_polled_at: string | null; last_zoho_modified_at: string | null; app_fingerprint: string | null }
        Insert: { product_id: string; zoho_item_id: string; track_batches?: boolean; updated_at?: string; last_polled_at?: string | null; last_zoho_modified_at?: string | null; app_fingerprint?: string | null }
        Update: { product_id?: string; zoho_item_id?: string; track_batches?: boolean; updated_at?: string; last_polled_at?: string | null; last_zoho_modified_at?: string | null; app_fingerprint?: string | null }
        Relationships: []
      }
      zoho_catalog_tombstones: {
        Row: { product_id: string; zoho_item_id: string; deleted_at: string }
        Insert: { product_id: string; zoho_item_id: string; deleted_at?: string }
        Update: { product_id?: string; zoho_item_id?: string; deleted_at?: string }
        Relationships: []
      }
      zoho_webhook_inbox: {
        Row: { id: number; received_at: string; body: string; signature: string; content_type: string | null; query: string; attempts: number }
        Insert: { id?: never; received_at?: string; body: string; signature: string; content_type?: string | null; query?: string; attempts?: number }
        Update: { id?: never; received_at?: string; body?: string; signature?: string; content_type?: string | null; query?: string; attempts?: number }
        Relationships: []
      }
      zoho_sync_outbox: {
        Row: { id: string; entity_type: string; entity_id: string; event_type: string; status: string; attempts: number; available_at: string; locked_until: string | null; last_error: string | null; created_at: string; updated_at: string; push_holder: string | null }
        Insert: { id?: string; entity_type: string; entity_id: string; event_type: string; status?: string; attempts?: number; available_at?: string; locked_until?: string | null; last_error?: string | null; created_at?: string; updated_at?: string; push_holder?: string | null }
        Update: { id?: string; entity_type?: string; entity_id?: string; event_type?: string; status?: string; attempts?: number; available_at?: string; locked_until?: string | null; last_error?: string | null; created_at?: string; updated_at?: string; push_holder?: string | null }
        Relationships: []
      }
      zoho_order_push_claims: {
        Row: { order_id: string; holder: string | null; locked_until: string | null; create_attempted_at: string | null; write_unanswered_at: string | null; updated_at: string }
        Insert: { order_id: string; holder?: string | null; locked_until?: string | null; create_attempted_at?: string | null; write_unanswered_at?: string | null; updated_at?: string }
        Update: { order_id?: string; holder?: string | null; locked_until?: string | null; create_attempted_at?: string | null; write_unanswered_at?: string | null; updated_at?: string }
        Relationships: []
      }
      zoho_commerce_sync_state: {
        Row: {
          organization_id: string
          resource: string
          current_batch_id: string
          record_count: number
          last_synced_at: string
          last_error: string | null
        }
        Insert: {
          organization_id: string
          resource: string
          current_batch_id: string
          record_count?: number
          last_synced_at?: string
          last_error?: string | null
        }
        Update: {
          organization_id?: string
          resource?: string
          current_batch_id?: string
          record_count?: number
          last_synced_at?: string
          last_error?: string | null
        }
        Relationships: []
      }
      zoho_commerce_sync_data: {
        Row: {
          organization_id: string
          resource: string
          batch_id: string
          external_id: string
          payload: Json
          captured_at: string
        }
        Insert: {
          organization_id: string
          resource: string
          batch_id: string
          external_id: string
          payload: Json
          captured_at?: string
        }
        Update: {
          organization_id?: string
          resource?: string
          batch_id?: string
          external_id?: string
          payload?: Json
          captured_at?: string
        }
        Relationships: []
      }
      addresses: {
        Row: {
          latitude: number | null
          longitude: number | null
          location_accuracy_m: number | null
          located_at: string | null
          city: string
          created_at: string
          id: string
          is_default: boolean
          label: string
          landmark: string | null
          line: string
          name: string
          phone: string
          pin: string
          state: string
          user_id: string
          updated_at: string
        }
        Insert: {
          latitude?: number | null
          longitude?: number | null
          location_accuracy_m?: number | null
          located_at?: string | null
          city: string
          created_at?: string
          id?: string
          is_default?: boolean
          label?: string
          landmark?: string | null
          line: string
          name: string
          phone: string
          pin: string
          state: string
          user_id: string
          updated_at?: string
        }
        Update: {
          latitude?: number | null
          longitude?: number | null
          location_accuracy_m?: number | null
          located_at?: string | null
          city?: string
          created_at?: string
          id?: string
          is_default?: boolean
          label?: string
          landmark?: string | null
          line?: string
          name?: string
          phone?: string
          pin?: string
          state?: string
          user_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      batch_transfers: {
        Row: {
          id: number; transfer_no: string; kind: string; status: string; from_branch_id: string | null; from_location_id: string;
          from_location_name: string; to_branch_id: string; to_location_id: string; parent_batch_id: string | null; product_id: string | null;
          quantity: number | null; bill: Json | null; cost_basis: string | null; lines: Json; zoho_transfer_order_id: string; zoho_status: string;
          attempts: number; last_error: string; result: Json | null; created_by: string | null; created_by_name: string; created_at: string; finished_at: string | null
          sent_at: string | null; received_at: string | null; received_by: string | null; received_by_name: string; received_by_role: string | null
          claim_id: string | null; claimed_until: string | null; create_sent_at: string | null; zoho_number_taken: boolean
          request_id: string | null; reserved: number
        }
        Insert: Record<string, never>
        Update: Record<string, never>
        Relationships: []
      }
      batches: {
        Row: {
          stage: string
          expected_quantity: number | null
          expected_date: string | null
          hold_back: number
          selling_paused: boolean
          paused_reason: string
          est_unit_cost_ex_gst: number | null
          est_unit_cost_inc_gst: number | null
          zoho_po_id: string
          zoho_po_number: string
          zoho_po_line_id: string
          split_from_batch_id: string | null
          preorder_checks: Json
          matched_at: string | null
          matched_by: string | null
          matched_by_name: string
          closed_at: string | null
          closed_note: string
          overdue_notified_at: string | null
          not_preorder_note: string
          unit_cost_ex_gst: number | null
          unit_cost_inc_gst: number | null
          cost_basis: string | null
          zoho_bill_id: string
          zoho_bill_line_id: string
          zoho_bill_number: string
          zoho_bill_modified: string
          zoho_bill_total: number | null
          parent_batch_id: string | null
          transfer_id: number | null
          sent_quantity: number
          bill_flag: string
          bill_flag_at: string | null
          bill_checked_at: string | null
          branch_id: string | null
          source: string
          supplier: string
          purchase_ref: string
          notes: string
          received_by: string | null
          received_by_name: string
          zoho_item_id: string
          zoho_batch_id: string
          zoho_adjustment_id: string
          zoho_balance: number | null
          zoho_checked_at: string | null
          depleted_at: string | null
          batch_code: string
          created_at: string
          expiry_date: string | null
          id: string
          mfg_date: string | null
          product_id: string
          product_name: string
          purchase_date: string | null
          quantity: number
          remaining_quantity: number
          status: string
          unit: string
          unit_cost: number
          updated_at: string
          vendor: string | null
          vendor_id: string | null
          warehouse: string | null
        }
        Insert: {
          stage?: string
          expected_quantity?: number | null
          expected_date?: string | null
          hold_back?: number
          selling_paused?: boolean
          paused_reason?: string
          est_unit_cost_ex_gst?: number | null
          est_unit_cost_inc_gst?: number | null
          zoho_po_id?: string
          zoho_po_number?: string
          zoho_po_line_id?: string
          split_from_batch_id?: string | null
          preorder_checks?: Json
          matched_at?: string | null
          matched_by?: string | null
          matched_by_name?: string
          closed_at?: string | null
          closed_note?: string
          overdue_notified_at?: string | null
          not_preorder_note?: string
          unit_cost_ex_gst?: number | null
          unit_cost_inc_gst?: number | null
          cost_basis?: string | null
          zoho_bill_id?: string
          zoho_bill_line_id?: string
          zoho_bill_number?: string
          zoho_bill_modified?: string
          zoho_bill_total?: number | null
          parent_batch_id?: string | null
          transfer_id?: number | null
          sent_quantity?: number
          bill_flag?: string
          bill_flag_at?: string | null
          bill_checked_at?: string | null
          branch_id?: string | null
          source?: string
          supplier?: string
          purchase_ref?: string
          notes?: string
          received_by?: string | null
          received_by_name?: string
          zoho_item_id?: string
          zoho_batch_id?: string
          zoho_adjustment_id?: string
          zoho_balance?: number | null
          zoho_checked_at?: string | null
          depleted_at?: string | null
          batch_code: string
          created_at?: string
          expiry_date?: string | null
          id?: string
          mfg_date?: string | null
          product_id: string
          product_name: string
          purchase_date?: string | null
          quantity?: number
          remaining_quantity?: number
          status?: string
          unit?: string
          unit_cost?: number
          updated_at?: string
          vendor?: string | null
          vendor_id?: string | null
          warehouse?: string | null
        }
        Update: {
          stage?: string
          expected_quantity?: number | null
          expected_date?: string | null
          hold_back?: number
          selling_paused?: boolean
          paused_reason?: string
          est_unit_cost_ex_gst?: number | null
          est_unit_cost_inc_gst?: number | null
          zoho_po_id?: string
          zoho_po_number?: string
          zoho_po_line_id?: string
          split_from_batch_id?: string | null
          preorder_checks?: Json
          matched_at?: string | null
          matched_by?: string | null
          matched_by_name?: string
          closed_at?: string | null
          closed_note?: string
          overdue_notified_at?: string | null
          not_preorder_note?: string
          unit_cost_ex_gst?: number | null
          unit_cost_inc_gst?: number | null
          cost_basis?: string | null
          zoho_bill_id?: string
          zoho_bill_line_id?: string
          zoho_bill_number?: string
          zoho_bill_modified?: string
          zoho_bill_total?: number | null
          parent_batch_id?: string | null
          transfer_id?: number | null
          sent_quantity?: number
          bill_flag?: string
          bill_flag_at?: string | null
          bill_checked_at?: string | null
          branch_id?: string | null
          source?: string
          supplier?: string
          purchase_ref?: string
          notes?: string
          received_by?: string | null
          received_by_name?: string
          zoho_item_id?: string
          zoho_batch_id?: string
          zoho_adjustment_id?: string
          zoho_balance?: number | null
          zoho_checked_at?: string | null
          depleted_at?: string | null
          batch_code?: string
          created_at?: string
          expiry_date?: string | null
          id?: string
          mfg_date?: string | null
          product_id?: string
          product_name?: string
          purchase_date?: string | null
          quantity?: number
          remaining_quantity?: number
          status?: string
          unit?: string
          unit_cost?: number
          updated_at?: string
          vendor?: string | null
          vendor_id?: string | null
          warehouse?: string | null
        }
        Relationships: []
      }
      batch_adjustments: {
        Row: { id: string; batch_id: string; qty: number; reason: string; note: string; unit_cost: number; stock_count_id: string | null; zoho_adjustment_id: string; created_by: string | null; created_by_name: string; created_at: string }
        Insert: { id?: string; batch_id: string; qty: number; reason: string; note?: string; unit_cost?: number; stock_count_id?: string | null; zoho_adjustment_id?: string; created_by?: string | null; created_by_name?: string; created_at?: string }
        Update: { id?: string; batch_id?: string; qty?: number; reason?: string; note?: string; unit_cost?: number; stock_count_id?: string | null; zoho_adjustment_id?: string; created_by?: string | null; created_by_name?: string; created_at?: string }
        Relationships: []
      }
      batch_code_reservations: {
        Row: { code: string; branch_id: string | null; created_at: string }
        Insert: { code: string; branch_id?: string | null; created_at?: string }
        Update: { code?: string; branch_id?: string | null; created_at?: string }
        Relationships: []
      }
      order_item_batch_allocations: {
        Row: { id: string; order_item_id: string; batch_id: string; reserved_quantity: number; released_quantity: number; unit_cost: number; created_at: string; moved_from_allocation_id: string | null }
        Insert: { id?: string; order_item_id: string; batch_id: string; reserved_quantity: number; released_quantity?: number; unit_cost?: number; created_at?: string; moved_from_allocation_id?: string | null }
        Update: { id?: string; order_item_id?: string; batch_id?: string; reserved_quantity?: number; released_quantity?: number; unit_cost?: number; created_at?: string; moved_from_allocation_id?: string | null }
        Relationships: []
      }
      catalog_products: {
        Row: { id: string; vendor_id: string; category: string; status: string; active: boolean; payload: Json; created_at: string; updated_at: string }
        Insert: { id: string; vendor_id: string; category: string; status?: string; active?: boolean; payload: Json; created_at?: string; updated_at?: string }
        Update: { id?: string; vendor_id?: string; category?: string; status?: string; active?: boolean; payload?: Json; created_at?: string; updated_at?: string }
        Relationships: []
      }
      contact_enquiries: {
        Row: { id: string; name: string; email: string; phone: string | null; message: string; recipient_email: string; status: string; email_sent: boolean; email_delivery_status: string; metadata: Json; created_at: string; updated_at: string }
        Insert: { id?: string; name: string; email: string; phone?: string | null; message: string; recipient_email?: string; status?: string; email_sent?: boolean; email_delivery_status?: string; metadata?: Json; created_at?: string; updated_at?: string }
        Update: { id?: string; name?: string; email?: string; phone?: string | null; message?: string; recipient_email?: string; status?: string; email_sent?: boolean; email_delivery_status?: string; metadata?: Json; created_at?: string; updated_at?: string }
        Relationships: []
      }
      crm_notes: {
        Row: {
          author_id: string | null
          created_at: string
          id: string
          note: string
          status: string | null
          subject_id: string
          subject_name: string | null
          subject_type: string
        }
        Insert: {
          author_id?: string | null
          created_at?: string
          id?: string
          note: string
          status?: string | null
          subject_id: string
          subject_name?: string | null
          subject_type?: string
        }
        Update: {
          author_id?: string | null
          created_at?: string
          id?: string
          note?: string
          status?: string | null
          subject_id?: string
          subject_name?: string | null
          subject_type?: string
        }
        Relationships: []
      }
      integrations: {
        Row: {
          category: string
          config: Json
          enabled: boolean
          id: string
          key: string
          name: string
          provider: string | null
          secret_names: string[]
          updated_at: string
        }
        Insert: {
          category?: string
          config?: Json
          enabled?: boolean
          id?: string
          key: string
          name: string
          provider?: string | null
          secret_names?: string[]
          updated_at?: string
        }
        Update: {
          category?: string
          config?: Json
          enabled?: boolean
          id?: string
          key?: string
          name?: string
          provider?: string | null
          secret_names?: string[]
          updated_at?: string
        }
        Relationships: []
      }
      invoices: {
        Row: {
          amount: number
          gst_amount: number
          id: string
          invoice_no: string
          issued_at: string
          order_id: string | null
          order_no: string | null
          status: string
          user_id: string | null
        }
        Insert: {
          amount?: number
          gst_amount?: number
          id?: string
          invoice_no: string
          issued_at?: string
          order_id?: string | null
          order_no?: string | null
          status?: string
          user_id?: string | null
        }
        Update: {
          amount?: number
          gst_amount?: number
          id?: string
          invoice_no?: string
          issued_at?: string
          order_id?: string | null
          order_no?: string | null
          status?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      zoho_order_invoices: {
        Row: { invoice_date: string | null; order_id: string; order_no: string; zoho_invoice_id: string | null; invoice_number: string | null; status: string; total: number | null; balance: number | null; auto_attempts: number; admin_approved: boolean; approved_by: string | null; approved_at: string | null; last_event: string; updated_at: string }
        Insert: { invoice_date?: string | null; order_id: string; order_no: string; zoho_invoice_id?: string | null; invoice_number?: string | null; status?: string; total?: number | null; balance?: number | null; auto_attempts?: number; admin_approved?: boolean; approved_by?: string | null; approved_at?: string | null; last_event?: string; updated_at?: string }
        Update: { invoice_date?: string | null; order_id?: string; order_no?: string; zoho_invoice_id?: string | null; invoice_number?: string | null; status?: string; total?: number | null; balance?: number | null; auto_attempts?: number; admin_approved?: boolean; approved_by?: string | null; approved_at?: string | null; last_event?: string; updated_at?: string }
        Relationships: []
      }
      stock_counts: {
        Row: { id: string; branch_id: string; product_id: string; product_name: string; counted: number; zoho_physical_before: number; zoho_delta: number; site_before: number; site_after: number; reason: string; note: string; flagged: boolean; zoho_adjustment_id: string; counted_by: string | null; counted_by_name: string; employee_id: string | null; created_at: string }
        Insert: { branch_id: string; product_id: string; counted: number; zoho_physical_before: number; zoho_delta: number; site_after: number; reason: string; id?: string; product_name?: string; site_before?: number; note?: string; flagged?: boolean; zoho_adjustment_id?: string; counted_by?: string | null; counted_by_name?: string; employee_id?: string | null; created_at?: string }
        Update: { id?: string; branch_id?: string; product_id?: string; product_name?: string; counted?: number; zoho_physical_before?: number; zoho_delta?: number; site_before?: number; site_after?: number; reason?: string; note?: string; flagged?: boolean; zoho_adjustment_id?: string; counted_by?: string | null; counted_by_name?: string; employee_id?: string | null; created_at?: string }
        Relationships: []
      }
      godown_devices: {
        Row: { id: string; branch_id: string; label: string; token_hash: string; active: boolean; registered_by: string | null; created_at: string; last_seen_at: string | null; revoked_at: string | null }
        Insert: { branch_id: string; token_hash: string; id?: string; label?: string; active?: boolean; registered_by?: string | null; created_at?: string; last_seen_at?: string | null; revoked_at?: string | null }
        Update: { id?: string; branch_id?: string; label?: string; token_hash?: string; active?: boolean; registered_by?: string | null; created_at?: string; last_seen_at?: string | null; revoked_at?: string | null }
        Relationships: []
      }
      godown_device_codes: {
        Row: { code_hash: string; branch_id: string; label: string; created_by: string | null; created_at: string; expires_at: string; used_at: string | null; device_id: string | null }
        Insert: { code_hash: string; branch_id: string; expires_at: string; label?: string; created_by?: string | null; created_at?: string; used_at?: string | null; device_id?: string | null }
        Update: { code_hash?: string; branch_id?: string; label?: string; created_by?: string | null; created_at?: string; expires_at?: string; used_at?: string | null; device_id?: string | null }
        Relationships: []
      }
      attendance_presence: {
        Row: { id: string; attendance_day_id: string; employee_id: string; branch_id: string; taken_at: string; lat: number; lng: number; accuracy_m: number; distance_m: number | null; inside: boolean; selfie: string; device_id: string | null; created_at: string }
        Insert: { attendance_day_id: string; employee_id: string; branch_id: string; lat: number; lng: number; accuracy_m: number; inside: boolean; selfie: string; id?: string; taken_at?: string; distance_m?: number | null; device_id?: string | null; created_at?: string }
        Update: { id?: string; attendance_day_id?: string; employee_id?: string; branch_id?: string; taken_at?: string; lat?: number; lng?: number; accuracy_m?: number; distance_m?: number | null; inside?: boolean; selfie?: string; device_id?: string | null; created_at?: string }
        Relationships: []
      }
      staff_employees: {
        Row: { id: string; user_id: string; branch_id: string; name: string; phone: string; designation: string; status: string; joined_on: string; created_by: string | null; created_at: string; updated_at: string; login_email: string | null; is_incharge: boolean; incharge_set_at: string | null; incharge_set_by: string }
        Insert: { user_id: string; branch_id: string; name: string; phone: string; id?: string; designation?: string; status?: string; joined_on?: string; created_by?: string | null; created_at?: string; updated_at?: string; login_email?: string | null; is_incharge?: boolean; incharge_set_at?: string | null; incharge_set_by?: string }
        Update: { id?: string; user_id?: string; branch_id?: string; name?: string; phone?: string; designation?: string; status?: string; joined_on?: string; created_by?: string | null; created_at?: string; updated_at?: string; login_email?: string | null }
        Relationships: []
      }
      godown_rule_versions: {
        Row: { id: string; branch_id: string; effective_from: string; shift_start: string; shift_end: string; late_grace_min: number; late_counted_from: string; early_grace_min: number; half_day_below_min: number; absent_below_min: number; missed_checkout: string; weekly_off: number | null; radius_m: number; gps_accuracy_limit_m: number; require_device: boolean; presence_interval_min: number; presence_early_min: number; presence_late_min: number; leave_types: string[]; leave_max_days: number; leave_back_days: number; leave_ahead_days: number; leave_partner_required: boolean; note: string; created_by: string | null; created_by_name: string; created_at: string; cancelled_at: string | null; cancelled_by: string | null }
        Insert: { branch_id: string; effective_from: string; shift_start: string; shift_end: string; late_grace_min: number; radius_m: number; presence_interval_min: number; id?: string; late_counted_from?: string; early_grace_min?: number; half_day_below_min?: number; absent_below_min?: number; missed_checkout?: string; weekly_off?: number | null; gps_accuracy_limit_m?: number; require_device?: boolean; presence_early_min?: number; presence_late_min?: number; leave_types?: string[]; leave_max_days?: number; leave_back_days?: number; leave_ahead_days?: number; leave_partner_required?: boolean; note?: string; created_by?: string | null; created_by_name?: string; created_at?: string; cancelled_at?: string | null; cancelled_by?: string | null }
        Update: { id?: string; branch_id?: string; effective_from?: string; shift_start?: string; shift_end?: string; late_grace_min?: number; late_counted_from?: string; early_grace_min?: number; half_day_below_min?: number; absent_below_min?: number; missed_checkout?: string; weekly_off?: number | null; radius_m?: number; gps_accuracy_limit_m?: number; require_device?: boolean; presence_interval_min?: number; presence_early_min?: number; presence_late_min?: number; leave_types?: string[]; leave_max_days?: number; leave_back_days?: number; leave_ahead_days?: number; leave_partner_required?: boolean; note?: string; created_by?: string | null; created_by_name?: string; created_at?: string; cancelled_at?: string | null; cancelled_by?: string | null }
        Relationships: []
      }
      product_code_sets: {
        Row: { id: string; category: string; prefix: string; first_label: string; second_label: string; brand: string; created_at: string; updated_at: string }
        Insert: { category: string; id?: string; prefix?: string; first_label?: string; second_label?: string; brand?: string; created_at?: string; updated_at?: string }
        Update: { id?: string; category?: string; prefix?: string; first_label?: string; second_label?: string; brand?: string; created_at?: string; updated_at?: string }
        Relationships: []
      }
      product_code_methods: {
        Row: { id: string; set_id: string; letter: string; name: string; sort_order: number; retired_at: string | null; created_at: string; updated_at: string }
        Insert: { set_id: string; letter: string; name: string; id?: string; sort_order?: number; retired_at?: string | null; created_at?: string; updated_at?: string }
        Update: { id?: string; set_id?: string; letter?: string; name?: string; sort_order?: number; retired_at?: string | null; created_at?: string; updated_at?: string }
        Relationships: []
      }
      product_code_varieties: {
        Row: { id: string; set_id: string; letter: string; name: string; sort_order: number; retired_at: string | null; created_at: string; updated_at: string }
        Insert: { set_id: string; letter: string; name: string; id?: string; sort_order?: number; retired_at?: string | null; created_at?: string; updated_at?: string }
        Update: { id?: string; set_id?: string; letter?: string; name?: string; sort_order?: number; retired_at?: string | null; created_at?: string; updated_at?: string }
        Relationships: []
      }
      product_codes: {
        Row: { id: string; set_id: string; method_id: string; variety_id: string; serial: number; code: string; name: string; description: string; subcategory: string; images: string[]; retired_at: string | null; retired_with_part: boolean; created_at: string; updated_at: string }
        Insert: { set_id: string; method_id: string; variety_id: string; id?: string; serial?: number; code?: string; name?: string; description?: string; subcategory?: string; images?: string[]; retired_at?: string | null; retired_with_part?: boolean; created_at?: string; updated_at?: string }
        Update: { id?: string; set_id?: string; method_id?: string; variety_id?: string; serial?: number; code?: string; name?: string; description?: string; subcategory?: string; images?: string[]; retired_at?: string | null; retired_with_part?: boolean; created_at?: string; updated_at?: string }
        Relationships: []
      }
      godown_holidays: {
        Row: { id: string; branch_id: string; holiday_date: string; name: string; created_by: string | null; created_by_name: string; created_at: string; removed_at: string | null; removed_by: string | null }
        Insert: { branch_id: string; holiday_date: string; name: string; id?: string; created_by?: string | null; created_by_name?: string; created_at?: string; removed_at?: string | null; removed_by?: string | null }
        Update: { id?: string; branch_id?: string; holiday_date?: string; name?: string; created_by?: string | null; created_by_name?: string; created_at?: string; removed_at?: string | null; removed_by?: string | null }
        Relationships: []
      }
      attendance_days: {
        Row: { id: string; rule_version_id: string; employee_id: string; branch_id: string; work_date: string; check_in_at: string; in_lat: number; in_lng: number; in_accuracy_m: number; in_distance_m: number | null; in_selfie: string; late_minutes: number; flags: string[]; employee_note: string; check_out_at: string | null; out_lat: number | null; out_lng: number | null; out_accuracy_m: number | null; out_distance_m: number | null; out_inside: boolean | null; out_selfie: string | null; early_leave_minutes: number; in_device_id: string | null; out_device_id: string | null; status: string; head_office_decision: string | null; head_office_by: string | null; head_office_at: string | null; head_office_note: string; partner_decision: string | null; partner_by: string | null; partner_at: string | null; partner_note: string; created_at: string; updated_at: string }
        Insert: { rule_version_id?: string; employee_id: string; branch_id: string; work_date: string; in_lat: number; in_lng: number; in_accuracy_m: number; in_selfie: string; id?: string; check_in_at?: string; in_distance_m?: number | null; late_minutes?: number; flags?: string[]; employee_note?: string; check_out_at?: string | null; out_lat?: number | null; out_lng?: number | null; out_accuracy_m?: number | null; out_distance_m?: number | null; out_inside?: boolean | null; out_selfie?: string | null; early_leave_minutes?: number; in_device_id?: string | null; out_device_id?: string | null; status?: string; head_office_decision?: string | null; head_office_by?: string | null; head_office_at?: string | null; head_office_note?: string; partner_decision?: string | null; partner_by?: string | null; partner_at?: string | null; partner_note?: string; created_at?: string; updated_at?: string }
        Update: { id?: string; rule_version_id?: string; employee_id?: string; branch_id?: string; work_date?: string; check_in_at?: string; in_lat?: number; in_lng?: number; in_accuracy_m?: number; in_distance_m?: number | null; in_selfie?: string; late_minutes?: number; flags?: string[]; employee_note?: string; check_out_at?: string | null; out_lat?: number | null; out_lng?: number | null; out_accuracy_m?: number | null; out_distance_m?: number | null; out_inside?: boolean | null; out_selfie?: string | null; early_leave_minutes?: number; in_device_id?: string | null; out_device_id?: string | null; status?: string; head_office_decision?: string | null; head_office_by?: string | null; head_office_at?: string | null; head_office_note?: string; partner_decision?: string | null; partner_by?: string | null; partner_at?: string | null; partner_note?: string; created_at?: string; updated_at?: string }
        Relationships: []
      }
      leave_requests: {
        Row: { id: string; rule_version_id: string; employee_id: string; branch_id: string; from_date: string; to_date: string; leave_type: string; reason: string; status: string; head_office_decision: string | null; head_office_by: string | null; head_office_at: string | null; head_office_note: string; partner_decision: string | null; partner_by: string | null; partner_at: string | null; partner_note: string; created_at: string; updated_at: string }
        Insert: { rule_version_id: string; employee_id: string; branch_id: string; from_date: string; to_date: string; leave_type: string; reason: string; id?: string; status?: string; head_office_decision?: string | null; head_office_by?: string | null; head_office_at?: string | null; head_office_note?: string; partner_decision?: string | null; partner_by?: string | null; partner_at?: string | null; partner_note?: string; created_at?: string; updated_at?: string }
        Update: { id?: string; rule_version_id?: string; employee_id?: string; branch_id?: string; from_date?: string; to_date?: string; leave_type?: string; reason?: string; status?: string; head_office_decision?: string | null; head_office_by?: string | null; head_office_at?: string | null; head_office_note?: string; partner_decision?: string | null; partner_by?: string | null; partner_at?: string | null; partner_note?: string; created_at?: string; updated_at?: string }
        Relationships: []
      }
      channel_partners: {
        Row: { id: string; user_id: string; branch_id: string; name: string; email: string; phone: string; status: string; created_by: string | null; created_at: string; updated_at: string; status_changed_by: string | null; status_changed_at: string | null; signature_path: string | null }
        Insert: { user_id: string; branch_id: string; name: string; email: string; id?: string; phone?: string; status?: string; created_by?: string | null; created_at?: string; updated_at?: string; status_changed_by?: string | null; status_changed_at?: string | null; signature_path?: string | null }
        Update: { id?: string; user_id?: string; branch_id?: string; name?: string; email?: string; phone?: string; status?: string; created_by?: string | null; created_at?: string; updated_at?: string; status_changed_by?: string | null; status_changed_at?: string | null; signature_path?: string | null }
        Relationships: []
      }
      channel_partner_events: {
        Row: { id: string; partner_id: string; branch_id: string; event: string; at: string; by_user: string | null; by_name: string; backfilled: boolean }
        Insert: { id?: string; partner_id: string; branch_id: string; event: string; at?: string; by_user?: string | null; by_name?: string; backfilled?: boolean }
        Update: { id?: string; partner_id?: string; branch_id?: string; event?: string; at?: string; by_user?: string | null; by_name?: string; backfilled?: boolean }
        Relationships: []
      }
      partner_commission_rules: {
        Row: { id: string; branch_id: string; product_id: string | null; kind: string; value: number; enabled: boolean; updated_by: string | null; updated_at: string }
        Insert: { branch_id: string; kind: string; value: number; enabled?: boolean; id?: string; product_id?: string | null; updated_by?: string | null; updated_at?: string }
        Update: { id?: string; branch_id?: string; product_id?: string | null; kind?: string; value?: number; enabled?: boolean; updated_by?: string | null; updated_at?: string }
        Relationships: []
      }
      stock_indents: {
        Row: { id: string; indent_no: string; branch_id: string; partner_id: string | null; partner_name: string; needed_by: string | null; notes: string; status: string; status_note: string; status_changed_at: string | null; status_changed_by: string | null; status_changed_by_name: string; created_by: string | null; created_at: string; updated_at: string }
        Insert: { indent_no: string; branch_id: string; id?: string; partner_id?: string | null; partner_name?: string; needed_by?: string | null; notes?: string; status?: string; status_note?: string; created_by?: string | null }
        Update: { status?: string; status_note?: string }
        Relationships: []
      }
      stock_indent_lines: {
        Row: { id: string; indent_id: string; line_no: number; product_id: string | null; product_name: string; quantity: number; unit: string; grade: string; remarks: string }
        Insert: { indent_id: string; line_no: number; product_name: string; quantity: number; unit: string; id?: string; product_id?: string | null; grade?: string; remarks?: string }
        Update: { grade?: string; remarks?: string }
        Relationships: []
      }
      stock_indent_events: {
        Row: { id: number; indent_id: string; event: string; note: string; by_user: string | null; by_name: string; by_role: string; at: string }
        Insert: { indent_id: string; event: string; note?: string; by_user?: string | null; by_name?: string; by_role?: string; id?: never; at?: string }
        Update: { note?: string }
        Relationships: []
      }
      panel_favourites: {
        Row: { id: number; user_id: string; panel: string; item_key: string; label: string; to_path: string; find_text: string; position: number; created_at: string }
        Insert: { user_id: string; panel: string; item_key: string; label: string; to_path: string; find_text?: string; position?: number; id?: never; created_at?: string }
        Update: { user_id?: string; panel?: string; item_key?: string; label?: string; to_path?: string; find_text?: string; position?: number; created_at?: string }
        Relationships: []
      }
      ad_banners: {
        Row: { id: string; title: string; subtitle: string; media_kind: string; media_url: string; mobile_media_url: string | null; fit: string; background: string; link_url: string | null; cta_label: string; placement: string; sort_order: number; active: boolean; starts_at: string | null; ends_at: string | null; created_at: string; updated_at: string }
        Insert: { id?: string; title?: string; subtitle?: string; media_kind?: string; media_url: string; mobile_media_url?: string | null; fit?: string; background?: string; link_url?: string | null; cta_label?: string; placement?: string; sort_order?: number; active?: boolean; starts_at?: string | null; ends_at?: string | null }
        Update: { title?: string; subtitle?: string; media_kind?: string; media_url?: string; mobile_media_url?: string | null; fit?: string; background?: string; link_url?: string | null; cta_label?: string; placement?: string; sort_order?: number; active?: boolean; starts_at?: string | null; ends_at?: string | null }
        Relationships: []
      }
      bank_credits: {
        Row: { id: string; received_at: string; source: string; sender: string | null; raw: string | null; amount: number; utr: string; payer: string | null; status: string; order_id: string | null; order_no: string | null; note: string | null }
        Insert: never
        Update: never
        Relationships: []
      }
      utr_attempts: {
        Row: { id: string; at: string; user_id: string | null; order_id: string | null; order_no: string; utr: string; utr_key: string; amount: number | null; method: string | null; outcome: string; reason: string | null }
        Insert: never
        Update: never
        Relationships: []
      }
      utr_conflict_reviews: {
        Row: { utr_key: string; reviewed_by: string | null; reviewed_at: string; note: string }
        Insert: never
        Update: never
        Relationships: []
      }
      follow_up_tasks: {
        Row: { id: string; title: string; details: string; kind: string; employee_id: string | null; branch_id: string | null; due_on: string; repeat_every: string; remind_days: number; status: string; done_at: string | null; done_by: string | null; done_note: string; next_task_id: string | null; created_by: string | null; created_at: string; updated_at: string }
        Insert: { title: string; due_on: string; details?: string; kind?: string; employee_id?: string | null; branch_id?: string | null; repeat_every?: string; remind_days?: number; status?: string; id?: string }
        Update: { title?: string; due_on?: string; details?: string; kind?: string; employee_id?: string | null; branch_id?: string | null; repeat_every?: string; remind_days?: number; status?: string }
        Relationships: []
      }
      bank_credits_without_reference: {
        Row: { id: string; received_at: string; credited_at: string | null; sender: string | null; raw: string; fingerprint: string; account_ending: string; amount: number; balance: number | null; status: string; order_no: string | null; decided_by: string | null; decided_at: string | null; note: string | null; suggested_order_no: string | null }
        Insert: never
        Update: never
        Relationships: []
      }
      upi_payment_submissions: {
        Row: { late: boolean; sent_by: string | null; sent_by_role: string; id: string; order_id: string; order_no: string; user_id: string | null; customer_name: string; amount: number; utr: string; status: string; note: string | null; submitted_at: string; reviewed_at: string | null; reviewed_by: string | null; follow_up: string | null; refunded_at: string | null; refunded_by: string | null; refunded_from: string | null }
        Insert: never
        Update: never
        Relationships: []
      }
      bank_settings_audit: {
        Row: { id: number; changed_at: string; changed_by: string | null; old_value: Json | null; new_value: Json | null }
        Insert: never
        Update: never
        Relationships: []
      }
      upi_settings_audit: {
        Row: { id: number; changed_at: string; changed_by: string | null; old_vpa: string | null; new_vpa: string | null; old_enabled: boolean | null; new_enabled: boolean | null; payee_name: string | null }
        Insert: never
        Update: never
        Relationships: []
      }
      partner_targets: {
        Row: { partner_id: string; month: string; target_sales: number; updated_at: string }
        Insert: { partner_id: string; month: string; target_sales: number; updated_at?: string }
        Update: { partner_id?: string; month?: string; target_sales?: number; updated_at?: string }
        Relationships: []
      }
      partner_commissions: {
        Row: { order_item_id: string; order_id: string; order_no: string; partner_id: string; branch_id: string; product_id: string | null; product_name: string; qty: number; line_total: number; kind: string; rate: number; amount: number; status: string; placed_at: string; earned_at: string | null; updated_at: string }
        Insert: { order_item_id: string; order_id: string; order_no: string; partner_id: string; branch_id: string; qty: number; line_total: number; kind: string; rate: number; amount: number; product_id?: string | null; product_name?: string; status?: string; placed_at?: string; earned_at?: string | null; updated_at?: string }
        Update: { order_item_id?: string; order_id?: string; order_no?: string; partner_id?: string; branch_id?: string; product_id?: string | null; product_name?: string; qty?: number; line_total?: number; kind?: string; rate?: number; amount?: number; status?: string; placed_at?: string; earned_at?: string | null; updated_at?: string }
        Relationships: []
      }
      notifications: {
        Row: {
          created_at: string
          id: string
          message: string
          order_id: string | null
          order_no: string | null
          read: boolean
          recipient_id: string | null
          recipient_role: string
          recipient_vendor_id: string | null
          status: string | null
          title: string
        }
        Insert: {
          created_at?: string
          id?: string
          message: string
          order_id?: string | null
          order_no?: string | null
          read?: boolean
          recipient_id?: string | null
          recipient_role?: string
          recipient_vendor_id?: string | null
          status?: string | null
          title: string
        }
        Update: {
          created_at?: string
          id?: string
          message?: string
          order_id?: string | null
          order_no?: string | null
          read?: boolean
          recipient_id?: string | null
          recipient_role?: string
          recipient_vendor_id?: string | null
          status?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      delivery_notes: {
        Row: { id: string; seq: number; note_no: string; order_id: string; order_no: string; zoho_invoice_id: string; invoice_number: string; invoice_total: number; order_total: number; paid_amount: number; snapshot: Json; generated_at: string; generated_by: string; generated_by_name: string; generated_how: string }
        Insert: { id?: string; seq: number; note_no: string; order_id: string; order_no: string; zoho_invoice_id: string; invoice_number: string; invoice_total: number; order_total: number; paid_amount: number; snapshot: Json; generated_at?: string; generated_by: string; generated_by_name: string }
        Update: Record<string, never>
        Relationships: []
      }
      delivery_note_events: {
        Row: { id: number; note_id: string; kind: string; doc: string | null; slip_line: number | null; copy_no: number | null; gate_code: string | null; detail: string; actor_id: string | null; actor_name: string; occurred_at: string }
        Insert: { id?: number; note_id: string; kind: string; doc?: string | null; slip_line?: number | null; copy_no?: number | null; gate_code?: string | null; detail?: string; actor_id?: string | null; actor_name?: string; occurred_at?: string }
        Update: Record<string, never>
        Relationships: []
      }
      delivery_paper_codes: {
        Row: { id: number; note_id: string; print_event_id: number; doc: string; slip_line: number | null; copy_no: number; kind: string; duplicate_no: number | null; replaces_code_id: number | null; reason: string; printed_by: string; printed_at: string }
        Insert: Record<string, never>
        Update: Record<string, never>
        Relationships: []
      }
      delivery_handovers: {
        Row: { id: number; note_id: string; slip_line: number; round: number; code_id: number; actor_id: string; actor_name: string; actor_role: string; actor_phone: string; branch_id: string | null; branch_name: string; device_registered: boolean; device_label: string; gate_code: string; gate_source: string; handed_over_at: string }
        Insert: Record<string, never>
        Update: Record<string, never>
        Relationships: []
      }
      delivery_handover_reopens: {
        Row: { id: number; handover_id: number; note_id: string; slip_line: number; reason: string; actor_id: string; actor_name: string; reopened_at: string }
        Insert: Record<string, never>
        Update: Record<string, never>
        Relationships: []
      }
      delivery_scans: {
        Row: { id: number; code_id: number | null; note_id: string | null; code_hint: string; action: string; result: string; doc: string | null; slip_line: number | null; copy_no: number | null; paper_kind: string | null; duplicate_no: number | null; asked: number[]; lines: number[]; gate_code: string | null; gate_source: string | null; order_delivered: boolean; order_status_before: string | null; actor_id: string; actor_name: string; actor_role: string; branch_id: string | null; branch_name: string; device_registered: boolean; device_label: string; occurred_at: string }
        Insert: Record<string, never>
        Update: Record<string, never>
        Relationships: []
      }
      order_items: {
        Row: {
          /** Units of the line taken from pre-order batches when it was ordered, and the latest expected date then. */
          preorder_qty: number
          preorder_by: string | null
          batch_code: string | null
          capacity: string | null
          coupon_share: number
          created_at: string
          gst_rate: number
          id: string
          line_total: number
          order_id: string
          product_id: string
          product_name: string
          qty: number
          sku: string | null
          unit_price: number
          vendor: string | null
          vendor_id: string | null
        }
        Insert: {
          preorder_qty?: number
          preorder_by?: string | null
          batch_code?: string | null
          capacity?: string | null
          created_at?: string
          gst_rate?: number
          id?: string
          line_total?: number
          order_id: string
          product_id: string
          product_name: string
          qty?: number
          sku?: string | null
          unit_price?: number
          vendor?: string | null
          vendor_id?: string | null
        }
        Update: {
          preorder_qty?: number
          preorder_by?: string | null
          batch_code?: string | null
          capacity?: string | null
          created_at?: string
          gst_rate?: number
          id?: string
          line_total?: number
          order_id?: string
          product_id?: string
          product_name?: string
          qty?: number
          sku?: string | null
          unit_price?: number
          vendor?: string | null
          vendor_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      order_vendor_fulfillments: {
        Row: {
          created_at: string
          order_id: string
          status: string
          updated_at: string
          vendor_id: string
        }
        Insert: {
          created_at?: string
          order_id: string
          status?: string
          updated_at?: string
          vendor_id: string
        }
        Update: {
          created_at?: string
          order_id?: string
          status?: string
          updated_at?: string
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_vendor_fulfillments_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      order_tracking: {
        Row: {
          actor_role: string | null
          created_at: string
          id: string
          note: string | null
          order_id: string
          partner_id: string | null
          status: string
        }
        Insert: {
          actor_role?: string | null
          created_at?: string
          id?: string
          note?: string | null
          order_id: string
          partner_id?: string | null
          status: string
        }
        Update: {
          actor_role?: string | null
          created_at?: string
          id?: string
          note?: string | null
          order_id?: string
          partner_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_tracking_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_tracking_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "channel_partners"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          /** When the customer agreed to the pre-order terms (some units arrive later). */
          preorder_ack_at: string | null
          discount_taxable: number | null
          bank_credit_id: string | null
          bank_credit_seen_at: string | null
          zoho_salesorder_id: string | null
          branch_id: string | null
          zoho_last_polled_at: string | null
          zoho_order_status: string | null
          prices_include_gst: boolean
          zoho_last_modified_at: string | null
          advance_due: number
          balance_due: number
          coupon: string | null
          created_at: string
          customer_email: string
          customer_gstin: string | null
          customer_name: string
          customer_phone: string | null
          discount: number
          gst_amount: number
          gst_applied: boolean
          id: string
          order_no: string
          order_status: string
          paid_amount: number
          business_legal_name: string | null
          is_b2b: boolean
          parent_order_no: string | null
          payment_hold_outcome: string | null
          payment_hold_until: string | null
          payment_method: string | null
          payment_status: string
          shipping: number
          shipping_address: Json | null
          shipping_method: string
          split_count: number | null
          split_index: number | null
          subtotal: number
          total: number
          updated_at: string
          user_id: string | null
          vendor_ids: string[]
        }
        Insert: {
          preorder_ack_at?: string | null
          bank_credit_id?: string | null
          bank_credit_seen_at?: string | null
          branch_id?: string | null
          zoho_salesorder_id?: string | null
          zoho_last_polled_at?: string | null
          zoho_order_status?: string | null
          prices_include_gst?: boolean
          zoho_last_modified_at?: string | null
          advance_due?: number
          balance_due?: number
          coupon?: string | null
          created_at?: string
          customer_email?: string
          customer_gstin?: string | null
          customer_name?: string
          customer_phone?: string | null
          discount?: number
          gst_amount?: number
          gst_applied?: boolean
          id?: string
          order_no: string
          order_status?: string
          paid_amount?: number
          business_legal_name?: string | null
          is_b2b?: boolean
          parent_order_no?: string | null
          payment_hold_outcome?: string | null
          payment_hold_until?: string | null
          payment_method?: string | null
          payment_status?: string
          shipping?: number
          shipping_address?: Json | null
          shipping_method?: string
          split_count?: number | null
          split_index?: number | null
          subtotal?: number
          total?: number
          updated_at?: string
          user_id?: string | null
          vendor_ids?: string[]
        }
        Update: {
          preorder_ack_at?: string | null
          bank_credit_id?: string | null
          bank_credit_seen_at?: string | null
          branch_id?: string | null
          zoho_salesorder_id?: string | null
          zoho_last_polled_at?: string | null
          zoho_order_status?: string | null
          prices_include_gst?: boolean
          zoho_last_modified_at?: string | null
          advance_due?: number
          balance_due?: number
          coupon?: string | null
          created_at?: string
          customer_email?: string
          customer_gstin?: string | null
          customer_name?: string
          customer_phone?: string | null
          discount?: number
          gst_amount?: number
          gst_applied?: boolean
          id?: string
          order_no?: string
          order_status?: string
          paid_amount?: number
          business_legal_name?: string | null
          is_b2b?: boolean
          parent_order_no?: string | null
          payment_hold_outcome?: string | null
          payment_hold_until?: string | null
          payment_method?: string | null
          payment_status?: string
          shipping?: number
          shipping_address?: Json | null
          shipping_method?: string
          split_count?: number | null
          split_index?: number | null
          subtotal?: number
          total?: number
          updated_at?: string
          user_id?: string | null
          vendor_ids?: string[]
        }
        Relationships: []
      }
      payments: {
        Row: {
          amount: number
          created_at: string
          id: string
          kind: string
          method: string | null
          order_id: string | null
          session_expires_at: string | null
          status: string
          txn_ref: string | null
          updated_at: string
          user_id: string | null
          zoho_invoice_id: string | null
          zoho_payment_id: string | null
          zoho_pushed_at: string | null
        }
        Insert: {
          amount?: number
          created_at?: string
          id?: string
          kind?: string
          method?: string | null
          order_id?: string | null
          session_expires_at?: string | null
          status?: string
          txn_ref?: string | null
          updated_at?: string
          user_id?: string | null
          zoho_invoice_id?: string | null
          zoho_payment_id?: string | null
          zoho_pushed_at?: string | null
        }
        Update: {
          amount?: number
          created_at?: string
          id?: string
          kind?: string
          method?: string | null
          order_id?: string | null
          session_expires_at?: string | null
          status?: string
          txn_ref?: string | null
          updated_at?: string
          user_id?: string | null
          zoho_invoice_id?: string | null
          zoho_payment_id?: string | null
          zoho_pushed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payments_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      policies: {
        Row: {
          body: string
          id: string
          slug: string
          title: string
          updated_at: string
          version: string
        }
        Insert: {
          body?: string
          id?: string
          slug: string
          title: string
          updated_at?: string
          version?: string
        }
        Update: {
          body?: string
          id?: string
          slug?: string
          title?: string
          updated_at?: string
          version?: string
        }
        Relationships: []
      }
      policy_acceptance: {
        Row: {
          accepted_at: string
          accepted_slugs: string[]
          id: string
          order_id: string | null
          order_no: string | null
          policy_version: string
          user_id: string | null
        }
        Insert: {
          accepted_at?: string
          accepted_slugs?: string[]
          id?: string
          order_id?: string | null
          order_no?: string | null
          policy_version?: string
          user_id?: string | null
        }
        Update: {
          accepted_at?: string
          accepted_slugs?: string[]
          id?: string
          order_id?: string | null
          order_no?: string | null
          policy_version?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "policy_acceptance_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      coupons: {
        Row: { code: string; discount_type: string; discount_value: number; minimum_order: number; maximum_discount: number; starts_on: string; ends_on: string; usage_limit: number; used_count: number; active: boolean; created_by: string | null; created_at: string; zoho_coupon_id: string | null; zoho_redemption_count: number; zoho_usage_limit_per_user: number | null; zoho_notice_fingerprint: string | null }
        Insert: { code: string; discount_type: string; discount_value: number; minimum_order?: number; maximum_discount: number; starts_on: string; ends_on: string; usage_limit: number; used_count?: number; active?: boolean; created_by?: string | null; created_at?: string; zoho_coupon_id?: string | null; zoho_redemption_count?: number; zoho_usage_limit_per_user?: number | null; zoho_notice_fingerprint?: string | null }
        Update: { code?: string; discount_type?: string; discount_value?: number; minimum_order?: number; maximum_discount?: number; starts_on?: string; ends_on?: string; usage_limit?: number; used_count?: number; active?: boolean; created_by?: string | null; created_at?: string; zoho_coupon_id?: string | null; zoho_redemption_count?: number; zoho_usage_limit_per_user?: number | null; zoho_notice_fingerprint?: string | null }
        Relationships: []
      }
      product_reviews: {
        Row: { id: string; order_id: string; product_id: string; customer_id: string; vendor_id: string; rating: number; title: string; body: string; vendor_reply: string | null; status: string; created_at: string }
        Insert: { id?: string; order_id: string; product_id: string; customer_id: string; vendor_id: string; rating: number; title: string; body: string; vendor_reply?: string | null; status?: string; created_at?: string }
        Update: { id?: string; order_id?: string; product_id?: string; customer_id?: string; vendor_id?: string; rating?: number; title?: string; body?: string; vendor_reply?: string | null; status?: string; created_at?: string }
        Relationships: []
      }
      return_requests: {
        Row: { id: string; order_id: string; order_item_id: string; customer_id: string | null; product_id: string; vendor_id: string; quantity: number; amount: number; reason: string; status: string; refund_status: string; created_at: string; updated_at: string }
        Insert: { id?: string; order_id: string; order_item_id: string; customer_id?: string | null; product_id: string; vendor_id: string; quantity: number; amount: number; reason: string; status?: string; refund_status?: string; created_at?: string; updated_at?: string }
        Update: { id?: string; order_id?: string; order_item_id?: string; customer_id?: string | null; product_id?: string; vendor_id?: string; quantity?: number; amount?: number; reason?: string; status?: string; refund_status?: string; created_at?: string; updated_at?: string }
        Relationships: []
      }
      vendor_payout_requests: {
        Row: { id: string; vendor_id: string; amount: number; method: string; status: string; reference: string | null; requested_at: string; processed_at: string | null; processed_by: string | null }
        Insert: { id?: string; vendor_id: string; amount: number; method?: string; status?: string; reference?: string | null; requested_at?: string; processed_at?: string | null; processed_by?: string | null }
        Update: { id?: string; vendor_id?: string; amount?: number; method?: string; status?: string; reference?: string | null; requested_at?: string; processed_at?: string | null; processed_by?: string | null }
        Relationships: []
      }
      vendor_settings: {
        Row: { vendor_id: string; key: string; value: Json; updated_at: string }
        Insert: { vendor_id: string; key: string; value?: Json; updated_at?: string }
        Update: { vendor_id?: string; key?: string; value?: Json; updated_at?: string }
        Relationships: []
      }
      customer_data_requests: {
        Row: { id: string; kind: string; customer_id: string; customer_label: string; actor_id: string | null; actor_name: string; actor_email: string; summary: Json; login_removed_at: string | null; created_at: string }
        Insert: { id?: string; kind: string; customer_id: string; customer_label?: string; actor_id?: string | null; actor_name?: string; actor_email?: string; summary?: Json; login_removed_at?: string | null; created_at?: string }
        Update: { id?: string; kind?: string; customer_id?: string; customer_label?: string; actor_id?: string | null; actor_name?: string; actor_email?: string; summary?: Json; login_removed_at?: string | null; created_at?: string }
        Relationships: []
      }
      customer_settings: {
        Row: { user_id: string; key: string; value: Json; updated_at: string }
        Insert: { user_id: string; key: string; value?: Json; updated_at?: string }
        Update: { user_id?: string; key?: string; value?: Json; updated_at?: string }
        Relationships: []
      }
      vendor_kyc_documents: {
        Row: { id: string; vendor_id: string; user_id: string; document_type: string; object_path: string; status: string; admin_notes: string | null; created_at: string; reviewed_at: string | null; reviewed_by: string | null }
        Insert: { id?: string; vendor_id: string; user_id: string; document_type: string; object_path: string; status?: string; admin_notes?: string | null; created_at?: string; reviewed_at?: string | null; reviewed_by?: string | null }
        Update: { id?: string; vendor_id?: string; user_id?: string; document_type?: string; object_path?: string; status?: string; admin_notes?: string | null; created_at?: string; reviewed_at?: string | null; reviewed_by?: string | null }
        Relationships: []
      }
      vendor_applications: {
        Row: { id: string; applicant_id: string; business_name: string; owner_name: string; email: string; phone: string; gstin: string; city: string; address: string; status: string; admin_notes: string | null; vendor_id: string | null; created_at: string; reviewed_at: string | null; reviewed_by: string | null }
        Insert: { id?: string; applicant_id: string; business_name: string; owner_name: string; email: string; phone: string; gstin?: string; city: string; address: string; status?: string; admin_notes?: string | null; vendor_id?: string | null; created_at?: string; reviewed_at?: string | null; reviewed_by?: string | null }
        Update: { id?: string; applicant_id?: string; business_name?: string; owner_name?: string; email?: string; phone?: string; gstin?: string; city?: string; address?: string; status?: string; admin_notes?: string | null; vendor_id?: string | null; created_at?: string; reviewed_at?: string | null; reviewed_by?: string | null }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          business_address: string | null
          business_city: string | null
          company: string | null
          commission_rate: number
          created_at: string
          email: string
          full_name: string
          gstin: string | null
          id: string
          phone: string | null
          status: string
          updated_at: string
          vendor_id: string | null
        }
        Insert: {
          avatar_url?: string | null
          business_address?: string | null
          business_city?: string | null
          company?: string | null
          commission_rate?: number
          created_at?: string
          email?: string
          full_name?: string
          gstin?: string | null
          id: string
          phone?: string | null
          status?: string
          updated_at?: string
          vendor_id?: string | null
        }
        Update: {
          avatar_url?: string | null
          business_address?: string | null
          business_city?: string | null
          company?: string | null
          commission_rate?: number
          created_at?: string
          email?: string
          full_name?: string
          gstin?: string | null
          id?: string
          phone?: string | null
          status?: string
          updated_at?: string
          vendor_id?: string | null
        }
        Relationships: []
      }
      settings: {
        Row: {
          is_public: boolean
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          is_public?: boolean
          key: string
          updated_at?: string
          value?: Json
        }
        Update: {
          is_public?: boolean
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      store_categories: {
        Row: { id: string; name: string; enabled: boolean; sort_order: number; payload: Json; updated_at: string }
        Insert: { id: string; name: string; enabled?: boolean; sort_order?: number; payload: Json; updated_at?: string }
        Update: { id?: string; name?: string; enabled?: boolean; sort_order?: number; payload?: Json; updated_at?: string }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      website_content: {
        Row: {
          data: Json
          enabled: boolean
          id: string
          section: string
          title: string
          updated_at: string
        }
        Insert: {
          data?: Json
          enabled?: boolean
          id?: string
          section: string
          title?: string
          updated_at?: string
        }
        Update: {
          data?: Json
          enabled?: boolean
          id?: string
          section?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      create_incoming_batch: { Args: { _branch_id: string; _product_id: string; _quantity: number; _unit_cost_ex_gst: number; _expected_date: string; _hold_back: number; _supplier: string; _po: Json | null; _notes: string; _checks: Json; _readings: Json; _snapshot: Json; _read_at: string; _by: string; _by_name: string }; Returns: Json }
      admin_update_incoming_batch: { Args: { _batch_id: string; _quantity?: number | null; _expected_date?: string | null; _unit_cost_ex_gst?: number | null; _hold_back?: number | null; _paused?: boolean | null; _supplier?: string | null; _notes?: string | null; _note?: string | null }; Returns: Json }
      admin_cancel_incoming_batch: { Args: { _batch_id: string; _note: string }; Returns: Json }
      admin_join_incoming_batches: { Args: { _into: string; _from: string; _note: string }; Returns: Json }
      admin_move_to_ready: { Args: { _order_item_id: string; _qty: number; _note: string }; Returns: Json }
      apply_preorder_reading: { Args: { _branch_id: string; _product_id: string; _reading: number; _read_at: string; _snapshot: string[]; _explained?: number; _after_push?: boolean }; Returns: Json }
      preorder_push_plan: { Args: { _branch_id: string; _product_id: string; _reading: number; _snapshot: string[] }; Returns: Json }
      preorder_push_start: { Args: { _branch_id: string; _product_id: string }; Returns: Json }
      preorder_push_finish: { Args: { _branch_id: string; _product_id: string; _ok: boolean }; Returns: Json }
      partner_orders_waiting_goods: { Args: Record<string, never>; Returns: { order_no: string; waiting: number; expected_date: string | null }[] }
      release_preorder_hold: { Args: { _branch_id: string; _product_id: string; _qty: number; _note: string; _regular_bills: Json; _reading: number; _snapshot: string[]; _read_at: string; _by: string; _by_name: string }; Returns: Json }
      unmatch_incoming_batch: { Args: { _batch_id: string; _note: string; _readings: Json; _snapshot: Json; _read_at: string; _by: string; _by_name: string }; Returns: Json }
      receive_bill_lines: { Args: { _branch_id: string; _bill: Json; _lines: Json; _cost_basis: string; _readings: Json; _snapshot: Json; _read_at: string; _by: string; _by_name: string }; Returns: Json }
      preorder_waiting_items: { Args: { _product_ids: string[] }; Returns: { branch_id: string; product_id: string; order_item_id: string }[] }
      order_waiting_goods: { Args: { _order_id: string }; Returns: Json }
      order_item_arrivals: { Args: { _order_id: string }; Returns: { order_item_id: string; preorder_qty: number; waiting: number; expected_date: string | null; arrived_on: string | null }[] }
      godown_incoming_lots: { Args: { _branch_id: string }; Returns: { product_id: string; product_name: string; expected: number; sold: number; waiting_orders: number; expected_date: string; paused: boolean }[] }
      refresh_incoming_all: { Args: Record<PropertyKey, never>; Returns: number }
      admin_set_preorder_settings: { Args: { _enabled: boolean; _grace_days: number; _require_ack: boolean }; Returns: Json }
      save_cost_document: { Args: { _doc: Json }; Returns: number }
      tag_batch_costs: { Args: { _document_id: number; _rows: Json; _confirm_rebilled: boolean; _by: string; _by_name: string; _replace?: boolean }; Returns: Json }
      untag_batch_costs: { Args: { _document_id: number; _by: string; _by_name: string }; Returns: number }
      flag_cost_document_changes: { Args: { _rows: Json }; Returns: number }
      accept_cost_document_change: { Args: { _document_id: number; _by?: string | null; _by_name?: string | null }; Returns: Json }
      partner_settlement_summary: { Args: Record<PropertyKey, never>; Returns: { partner_id: string; partner_name: string; godown: string; partner_status: string; earned: number; pending: number; cancelled: number; paid: number; due: number; owed_back: number; payouts: number; last_paid_on: string | null }[] }
      partner_settlement_lines: { Args: { _partner_id?: string; _from?: string; _to?: string }; Returns: { order_item_id: string; partner_id: string; partner_name: string; order_no: string; placed_at: string; earned_at: string | null; order_status: string; payment_status: string; customer_name: string; pin: string; product_name: string; qty: number; line_total: number; kind: string; rate: number; amount: number; status: string; payable: number; paid_amount: number; due_amount: number; payout_nos: string[] }[] }
      admin_create_partner_payout: { Args: { _partner_id: string; _item_ids: string[]; _paid_on: string; _mode: string; _reference: string; _note?: string; _amount?: number; _period_from?: string; _period_to?: string; _request_key?: string }; Returns: Json }
      admin_void_partner_payout: { Args: { _payout_id: string; _reason: string }; Returns: boolean }
      partner_month_statement: { Args: { _month: string; _branch_id?: string }; Returns: Json }
      partner_add_month_deduction: { Args: { _month: string; _category: string; _label: string; _amount: number; _branch_id?: string; _request_key?: string }; Returns: Json }
      partner_remove_month_deduction: { Args: { _deduction_id: string }; Returns: boolean }
      admin_set_godown_commission_scheme: { Args: { _branch_id: string; _from_month: string; _scheme: string; _share_percent?: number; _tax_percent?: number }; Returns: Json }
      admin_set_partner_month_rates: { Args: { _branch_id: string; _month: string; _share_percent: number; _tax_percent: number }; Returns: boolean }
      admin_close_partner_month: { Args: { _branch_id: string; _month: string }; Returns: Json }
      admin_reopen_partner_month: { Args: { _branch_id: string; _month: string; _reason: string }; Returns: boolean }
      partner_statements_to_pay: { Args: Record<PropertyKey, never>; Returns: { statement_id: string; partner_id: string; partner_name: string; godown: string; month: string; share_amount: number; paid: number; due: number; closed_at: string | null }[] }
      admin_pay_partner_statement: { Args: { _statement_id: string; _paid_on: string; _mode: string; _reference: string; _note?: string; _amount?: number; _request_key?: string }; Returns: Json }
      admin_correct_partner_payout: { Args: { _payout_id: string; _paid_on: string; _mode: string; _reference: string; _note: string; _reason: string }; Returns: boolean }
      payment_delete_blocker: { Args: { _payment_id: string }; Returns: string | null }
      admin_delete_payment: { Args: { _payment_id: string; _reason: string }; Returns: Json }
      order_delete_all_check: { Args: { _order_no: string }; Returns: Json }
      admin_delete_order_all_details: { Args: { _order_no: string; _reason: string }; Returns: Json }
      rice_sample_save: { Args: { _id: string | null; _arrival_date: string; _variety: string; _method: string; _price_per_qntl: number; _quantity_qntl: number; _party_role: string; _party_name: string; _party_phone: string; _seller_name: string; _notes: string }; Returns: string }
      rice_sample_save_with_bags: { Args: { _id: string | null; _arrival_date: string; _variety: string; _method: string; _price_per_qntl: number; _quantity_qntl: number; _party_role: string; _party_name: string; _party_phone: string; _seller_name: string; _notes: string; _quantity_bags: number | null; _bag_kg: number | null }; Returns: string }
      rice_sample_add_test: { Args: { _sample_id: string; _tested_at: string | null; _tested_by_name: string; _score: number; _grain: string; _swelling: string; _taste: string; _broken: string; _notes: string }; Returns: string }
      rice_sample_add_measured_test: { Args: { _moisture_percent: number | null; _glazing: string; _sample_id: string; _tested_at: string | null; _tested_by_name: string; _score: number; _grain: string; _swelling: string; _taste: string; _broken: string; _notes: string }; Returns: string }
      rice_sample_set_status: { Args: { _sample_id: string; _action: string; _reason: string }; Returns: string }
      rice_sample_po_claim: { Args: { _sample_id: string; _attempt_id: string; _reference: string; _snapshot: Json; _user: string; _user_name: string }; Returns: Json }
      rice_sample_po_takeover: { Args: { _sample_id: string; _expected_attempt: string; _attempt_id: string; _snapshot: Json; _user: string; _user_name: string }; Returns: Json }
      rice_sample_po_mark_dead: { Args: { _sample_id: string; _po_id: string; _reason: string; _zoho_status: string; _note: string; _user: string | null; _user_name: string }; Returns: Json }
      rice_sample_po_release: { Args: { _sample_id: string; _expected_attempt: string; _user: string; _user_name: string; _by_hand?: boolean }; Returns: Json }
      rice_sample_po_mark_failed: { Args: { _sample_id: string; _attempt_id: string; _state: string; _message: string; _detail: string; _user: string; _user_name: string }; Returns: undefined }
      rice_sample_po_record: { Args: { _sample_id: string; _po_id: string; _po_number: string; _po_status: string; _sub_total: number | null; _tax_total: number | null; _total: number | null; _differences: string[]; _found_by_search: boolean; _user: string; _user_name: string }; Returns: Json }
      rice_sample_po_refresh: { Args: { _sample_id: string; _po_id?: string | null; _po_status: string | null; _sub_total: number | null; _tax_total: number | null; _total: number | null; _gone: boolean; _duplicates: Json | null }; Returns: undefined }
      rice_sample_po_cancel_asked: { Args: { _sample_id: string; _po_number: string; _reason: string; _user: string; _user_name: string }; Returns: undefined }
      rice_sample_po_poll_claim: { Args: { _gap_seconds: number }; Returns: boolean }
      rice_sample_po_poll_hold: { Args: { _seconds: number }; Returns: undefined }
      rice_sample_creation_claim: { Args: { _kind: string; _name_key: string; _display_name: string; _attempt_id: string; _user: string; _user_name: string }; Returns: Json }
      rice_sample_creation_takeover: { Args: { _kind: string; _name_key: string; _expected_attempt: string; _attempt_id: string; _user: string; _user_name: string }; Returns: Json }
      rice_sample_creation_finish: { Args: { _kind: string; _name_key: string; _attempt_id: string; _state: string; _zoho_id: string; _message: string }; Returns: undefined }
      enqueue_zoho_sync: { Args: { _entity_type: string; _entity_id: string }; Returns: undefined }
      claim_zoho_sync_jobs: { Args: { _limit?: number }; Returns: Database["public"]["Tables"]["zoho_sync_outbox"]["Row"][] }
      apply_zoho_contact_update: { Args: { _user_id: string; _contact_type: string; _full_name: string | null; _phone: string | null; _company: string | null; _gstin: string | null; _address?: Json | null }; Returns: undefined }
      retry_zoho_sync_job: { Args: { _id: string }; Returns: undefined }
      retry_zoho_sync_job_checked: { Args: { _id: string }; Returns: undefined }
      defer_zoho_sync_job: { Args: { _id: string; _seconds?: number; _message?: string | null }; Returns: undefined }
      claim_zoho_order_push: { Args: { _order_id: string; _holder: string }; Returns: { claimed: boolean; create_attempted_at: string | null; create_wait_over: boolean; writes_held_back: boolean }[] }
      renew_zoho_order_push: { Args: { _order_id: string; _holder: string }; Returns: boolean }
      note_zoho_order_create: { Args: { _order_id: string; _holder: string; _sent: boolean }; Returns: boolean }
      note_zoho_order_write_unanswered: { Args: { _order_id: string; _holder: string }; Returns: undefined }
      release_zoho_order_push: { Args: { _order_id: string; _holder: string }; Returns: undefined }
      apply_zoho_order_fulfillment: { Args: { _order_id: string; _status: string }; Returns: undefined }
      apply_zoho_order_cancellation: { Args: { _order_id: string }; Returns: string }
      branch_product_price: { Args: { _branch_id: string; _product_id: string }; Returns: number | null }
      admin_set_branch_price: { Args: { _branch_id: string; _product_id: string; _price: number | null; _listed?: boolean }; Returns: boolean }
      apply_zoho_branch_prices: { Args: { _branch_id: string; _pricebook_name: string; _prices: Json; _read_at: string }; Returns: number }
      apply_zoho_branch_stock: { Args: { _branch_id: string; _product_id: string; _stock: number; _read_at: string }; Returns: number | null }
      branch_pending_order_qty: { Args: { _branch_id: string }; Returns: { product_id: string; qty: number }[] }
      import_zoho_catalog_item: { Args: { _id: string; _vendor_id: string; _category: string; _payload: Json; _zoho_item_id: string; _zoho_modified_at: string; _fingerprint: string }; Returns: boolean }
      apply_zoho_catalog_item: { Args: { _product_id: string; _item: Json; _expected_updated_at: string }; Returns: undefined }
      finish_zoho_sync_job: { Args: { _id: string; _status: string; _error?: string | null }; Returns: undefined }
      submit_contact_enquiry: { Args: { _name: string; _email: string; _phone: string | null; _message: string; _metadata?: Json }; Returns: string }
      can_read_order: { Args: { _order: string }; Returns: boolean }
      current_vendor_id: { Args: never; Returns: string }
      admin_set_profile_status: { Args: { _profile_id: string; _status: string }; Returns: boolean }
      admin_set_vendor_commission: { Args: { _vendor_id: string; _rate: number | null }; Returns: boolean }
      admin_apply_commission_rules: { Args: Record<string, never>; Returns: number }
      vendor_fulfilment_branch: { Args: { _vendor_id: string }; Returns: string | null }
      vendor_fulfilment_points: { Args: Record<string, never>; Returns: { vendor_id: string; branch_id: string }[] }
      vendor_set_fulfilment: { Args: { _mode: string; _branch_id: string | null; _details: Json }; Returns: boolean }
      admin_set_review_status: { Args: { _id: string; _status: string }; Returns: boolean }
      admin_delete_review: { Args: { _id: string }; Returns: boolean }
      customer_delete_own_review: { Args: { _id: string }; Returns: boolean }
      vendor_reply_to_review: { Args: { _id: string; _reply: string }; Returns: boolean }
      vendor_report_review: { Args: { _id: string; _reason: string }; Returns: boolean }
      customer_request_return: { Args: { _order_item_id: string; _quantity: number; _reason: string }; Returns: string }
      customer_set_default_address: { Args: { _id: string }; Returns: boolean }
      admin_update_return: { Args: { _id: string; _status: string; _refund_status: string }; Returns: boolean }
      request_zoho_invoice_approval: { Args: { _order_no: string }; Returns: boolean }
      start_paid_checkout: {
        Args: { _order_no: string; _target_user_id: string; _customer_name: string; _customer_email: string; _customer_phone: string | null; _customer_gstin: string | null; _shipping_address: Json; _shipping_method: string; _payment_method: string; _items: Json; _coupon?: string | null; _is_b2b?: boolean | null; _business_gstin?: string | null; _business_name?: string | null }
        Returns: Json
      }
      godown_contact_phones: { Args: Record<PropertyKey, never>; Returns: { branch_id: string; phone: string | null }[] }
      expire_payment_holds: { Args: Record<PropertyKey, never>; Returns: number }
      bank_transfer_details: { Args: Record<PropertyKey, never>; Returns: Json }
      cancel_payment_hold: { Args: { _order_no: string }; Returns: boolean }
      record_bank_credit: { Args: { _utr: string; _amount: number; _payer?: string; _raw?: string; _source?: string; _sender?: string }; Returns: Json }
      settle_bank_credit: { Args: { _credit_id: string; _note: string; _refunded?: boolean }; Returns: { id: string; status: string; note: string | null } }
      reopen_bank_credit: { Args: { _credit_id: string }; Returns: { id: string; status: string; note: string | null } }
      send_payment_utr: { Args: { _order_no: string; _utr: string }; Returns: Json }
      admin_utr_conflicts: { Args: { _days?: number }; Returns: Json }
      review_utr_conflict: { Args: { _key: string; _note: string }; Returns: Json }
      record_bank_credit_without_reference: { Args: { _account_ending: string; _amount: number; _credited_at: string | null; _balance: number | null; _raw: string; _sender?: string }; Returns: Json }
      confirm_order_with_bank_credit: { Args: { _credit_id: string; _order_no: string; _expected_utr: string | null }; Returns: Json }
      dismiss_bank_credit_without_reference: { Args: { _credit_id: string; _note: string }; Returns: Json }
      reopen_bank_credit_without_reference: { Args: { _credit_id: string }; Returns: Json }
      submit_upi_utr: { Args: { _order_no: string; _utr: string }; Returns: { id: string; order_id: string; order_no: string; user_id: string | null; customer_name: string; amount: number; utr: string; status: string; note: string | null; submitted_at: string; reviewed_at: string | null; reviewed_by: string | null } }
      admin_end_payment_hold: { Args: { _order_no: string; _reason?: string }; Returns: boolean }
      admin_cancel_order: { Args: { _order_no: string; _reason: string; _goods_back?: boolean | null; _refund?: Json | null }; Returns: Json }
      partner_raise_stock_indent: { Args: { _lines: Json; _notes?: string; _needed_by?: string | null }; Returns: string }
      partner_cancel_stock_indent: { Args: { _indent_no: string; _reason?: string }; Returns: undefined }
      admin_set_stock_indent_status: { Args: { _indent_no: string; _status: string; _note?: string }; Returns: undefined }
      login_email_owner: { Args: { _email: string }; Returns: Json }
      current_partner_branch: { Args: Record<PropertyKey, never>; Returns: string }
      admin_delete_utr: { Args: { _order_no: string; _reason: string }; Returns: Json }
      submit_utr_for_order: { Args: { _order_no: string; _utr: string; _method?: string | null }; Returns: Json }
      admin_place_ended_checkout: { Args: { _order_no: string; _utr?: string | null; _method?: string | null; _checked_against?: string | null }; Returns: Json }
      admin_set_staff_incharge: { Args: { _employee_id: string; _on: boolean }; Returns: Json }
      delivery_qr_rules: { Args: Record<string, never>; Returns: Json }
      admin_set_delivery_qr_rules: { Args: { _rules: Json }; Returns: Json }
      invoice_delivery_code: { Args: { _order_no: string }; Returns: Json }
      admin_replace_invoice_delivery_code: { Args: { _order_no: string; _reason: string }; Returns: Json }
      delivery_invoice_order_no: { Args: { _code: string }; Returns: string | null }
      issue_delivery_note_auto: { Args: { _order_no: string; _zoho: Json; _actor?: string | null; _how?: string }; Returns: Json }
      delivery_invoice_scan: { Args: { _code: string; _action: string; _zoho: Json | null; _actor: string; _lines?: number[] | null; _device?: string | null }; Returns: Json }
      delivery_admin_release_print: { Args: { _order_no: string; _note: boolean; _slip_lines: number[]; _zoho: Json | null; _actor: string }; Returns: Json }
      godown_released_notes: { Args: Record<string, never>; Returns: { note_no: string; order_no: string; customer: string; items: number; to_go: number; released_at: string; released_how: string; delivered: boolean; godown: string; shop: string; contact: string; phone: string; address: string }[] }
      my_delivery_role: { Args: Record<string, never>; Returns: Json }
      partner_confirm_order: { Args: { _order_no: string }; Returns: Json }
      partner_orders_to_confirm: { Args: Record<string, never>; Returns: { order_no: string; placed_at: string; order_status: string; payment_status: string; payment_method: string; shipping_method: string; total: number; paid_amount: number; customer: string; items: string | null; zoho_void: boolean; invoice_number: string | null; invoice_mine: boolean; confirmed_at: string | null }[] }
      partner_payment_checkouts: { Args: Record<string, never>; Returns: { order_no: string; status: string; total: number; method: string; placed_at: string; hold_until: string | null; customer: string; items: string; utr: string | null; utr_status: string | null; utr_late: boolean; utr_sent_by: string | null }[] }
      order_delete_with_payments_check: { Args: { _order_no: string }; Returns: Json }
      complete_follow_up_task: { Args: { _id: string; _note?: string }; Returns: Json }
      admin_reject_utr_and_end_checkout: { Args: { _order_no: string; _note: string; _expected_utr?: string | null }; Returns: boolean }
      order_delete_blocker: { Args: { _order_no: string }; Returns: string | null }
      extend_my_payment_hold: { Args: { _order_no: string }; Returns: string | null }
      admin_delete_order: { Args: { _order_no: string; _reason: string }; Returns: Json }
      mark_utr_refunded: { Args: { _order_no: string }; Returns: boolean }
      delivery_note_check: { Args: { _order_no: string; _zoho: Json | null }; Returns: Json }
      issue_delivery_note: { Args: { _order_no: string; _zoho: Json; _actor: string; _actor_name: string }; Returns: Json }
      record_delivery_print: { Args: { _note_id: string; _note: boolean; _slip_lines: number[]; _zoho: Json; _actor: string; _actor_name: string; _replace_reason?: string | null }; Returns: Json }
      delivery_note_register: { Args: { _limit?: number }; Returns: Json }
      delivery_paper_order_no: { Args: { _code: string }; Returns: string | null }
      delivery_paper_scan: { Args: { _code: string; _handover: boolean; _zoho: Json | null; _actor: string; _lines?: number[] | null; _device?: string | null }; Returns: Json }
      reopen_delivery_handover: { Args: { _order_no: string; _line: number; _reason: string; _actor: string; _actor_name: string }; Returns: Json }
      set_delivery_stop: { Args: { _order_no: string; _stopped: boolean; _reason: string; _actor: string; _actor_name: string }; Returns: boolean }
      review_upi_utr: { Args: { _order_no: string; _decision: string; _note?: string | null; _expected_utr?: string | null }; Returns: { id: string; order_id: string; order_no: string; user_id: string | null; customer_name: string; amount: number; utr: string; status: string; note: string | null; submitted_at: string; reviewed_at: string | null; reviewed_by: string | null } }
      record_stock_count: {
        Args: { _branch_id: string; _product_id: string; _counted: number; _zoho_physical_before: number; _zoho_delta: number; _site_after: number; _reason: string; _note: string; _flagged: boolean; _zoho_adjustment_id: string; _counted_by: string; _counted_by_name: string; _employee_id: string | null; _zoho_after?: number | null; _snapshot?: string[] | null }
        Returns: string
      }
      next_batch_code: { Args: { _branch_id: string; _purchase_date: string | null }; Returns: string }
      record_batch_receipt: {
        Args: { _batch_code: string; _branch_id: string; _product_id: string; _quantity: number; _unit_cost: number; _purchase_date: string | null; _mfg_date: string | null; _expiry_date: string | null; _supplier: string; _purchase_ref: string; _notes: string; _zoho_item_id: string; _zoho_batch_id: string; _zoho_adjustment_id: string; _zoho_done: boolean; _received_by: string | null; _received_by_name: string }
        Returns: string
      }
      record_batch_adjustments: { Args: { _rows: Json; _created_by: string | null; _created_by_name: string }; Returns: number }
      apply_zoho_batches: { Args: { _rows: Json }; Returns: Json }
      create_batches_from_bill: { Args: { _branch_id: string; _bill: Json; _lines: Json; _cost_basis: string; _by: string | null; _by_name: string }; Returns: Json }
      relink_batch_bill: { Args: { _batch_id: string; _bill: Json; _line: Json; _by: string | null; _by_name: string }; Returns: Json }
      admin_delete_batch: { Args: { _batch_id: string }; Returns: Json }
      flag_batch_bill_changes: { Args: { _rows: Json }; Returns: number }
      begin_batch_split: { Args: { _batch_id: string; _targets: Json; _by: string; _by_name: string; _request: string | null }; Returns: Json }
      begin_bill_receive: { Args: { _branch_id: string; _from_location_id: string; _from_location_name: string; _bill: Json; _lines: Json; _cost_basis: string; _by: string; _by_name: string }; Returns: Json }
      finish_batch_transfer: { Args: { _transfer_id: number; _zoho_transfer_order_id: string; _zoho_status: string; _actor: string | null; _stock: Json | null; _claim: string | null }; Returns: Json }
      note_batch_transfer_attempt: { Args: { _transfer_id: number; _error: string; _zoho_transfer_order_id: string; _zoho_status: string; _claim: string | null; _number_taken: boolean }; Returns: Json }
      cancel_batch_transfer: { Args: { _transfer_id: number; _reason: string; _by: string | null; _stock: Json | null; _claim: string | null }; Returns: Json }
      claim_batch_transfer: { Args: { _transfer_id: number; _claim: string; _seconds: number }; Returns: Json }
      release_batch_transfer: { Args: { _transfer_id: number; _claim: string }; Returns: undefined }
      note_batch_transfer_create: { Args: { _transfer_id: number; _claim: string }; Returns: Json }
      receive_bill_here: { Args: { _branch_id: string; _bill: Json; _lines: Json; _cost_basis: string; _by: string; _by_name: string }; Returns: Json }
      link_zoho_batch: { Args: { _batch_id: string; _zoho_batch_id: string; _zoho_adjustment_id: string }; Returns: undefined }
      admin_update_batch: { Args: { _batch_id: string; _unit_cost: number; _supplier: string; _purchase_ref: string; _notes: string; _mfg_date: string | null; _expiry_date: string | null }; Returns: undefined }
      order_item_batches: { Args: { _order_id: string }; Returns: { order_item_id: string; batch_code: string; qty: number }[] }
      attendance_decide: { Args: { _kind: string; _id: string; _decision: string; _note?: string }; Returns: string }
      save_godown_rules: { Args: { _branch: string; _effective_from: string; _rules: Json; _note?: string }; Returns: string }
      cancel_godown_rules: { Args: { _id: string }; Returns: undefined }
      set_godown_holiday: { Args: { _branch: string; _date: string; _name: string }; Returns: string }
      remove_godown_holiday: { Args: { _id: string }; Returns: undefined }
      request_leave: { Args: { _from: string; _to: string; _type: string; _reason: string }; Returns: string }
      cancel_leave: { Args: { _id: string }; Returns: undefined }
      auth_user_id_for_phone: { Args: { _phone: string }; Returns: string | null }
      partner_leaderboard: {
        Args: { _month?: string }
        Returns: { rank: number; partner_id: string; partner_name: string; godown: string; sales: number; commission: number; earned: number; target: number; achieved_percent: number | null }[]
      }
      partner_commission_lines: {
        Args: { _month: string }
        Returns: { order_item_id: string; order_no: string; placed_at: string; order_status: string; payment_status: string; customer_name: string; pin: string; product_name: string; qty: number; line_total: number; kind: string; rate: number; amount: number; status: string; partner_id: string ; paid_amount: number; due_amount: number }[]
      }
      invoice_partner_signature: { Args: { _order_no: string }; Returns: string | null }
      invoice_customer_number: { Args: { _order_no: string }; Returns: string | null }
      zoho_contact_numbers: { Args: Record<PropertyKey, never>; Returns: { user_id: string; vendor_id: string | null; contact_type: string; contact_number: string }[] }
      partner_invoice_orders: {
        Args: { _from: string; _to: string }
        Returns: { order_no: string; placed_at: string; order_status: string; payment_status: string; customer_name: string; total: number; gst_amount: number; invoice_number: string | null }[]
      }
      partner_invoice_order: { Args: { _order_no: string }; Returns: Json }
      admin_update_payout: { Args: { _id: string; _status: string; _reference?: string | null }; Returns: boolean }
      admin_export_customer_data: { Args: { _customer_id: string }; Returns: Json }
      admin_customer_deletion_preview: { Args: { _customer_id: string }; Returns: Json }
      admin_delete_customer_data: { Args: { _customer_id: string; _confirmation: string; _retry?: boolean }; Returns: Json }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      place_marketplace_order: {
        Args: {
          _order_no: string
          _target_user_id: string
          _customer_name: string
          _customer_email: string
          _customer_phone: string | null
          _customer_gstin: string | null
          _shipping_address: Json
          _shipping_method: string
          _payment_method: string
          _items: Json
        }
        Returns: Json
      }
      place_marketplace_order_with_coupon: {
        Args: {
          _order_no: string
          _target_user_id: string
          _customer_name: string
          _customer_email: string
          _customer_phone: string | null
          _customer_gstin: string | null
          _shipping_address: Json
          _shipping_method: string
          _payment_method: string
          _items: Json
          _coupon?: string | null
        }
        Returns: Json
      }
      request_vendor_payout: { Args: { _amount: number; _method?: string }; Returns: string }
      admin_update_order_item: { Args: { _order_no: string; _order_item_id: string; _qty: number; _capacity: string; _unit_price: number }; Returns: Json }
      vendor_update_order_fulfillment: { Args: { _order_no: string; _status: string }; Returns: boolean }
      vendor_set_product_stock: { Args: { _product_id: string; _stock: number }; Returns: boolean }
      vendor_set_product_active: { Args: { _product_id: string; _active: boolean }; Returns: boolean }
      admin_set_branch_stock: { Args: { _branch_id: string; _product_id: string; _stock: number }; Returns: number }
      admin_set_product_code: { Args: { _product_id: string; _code: string }; Returns: boolean }
      default_branch_id: { Args: Record<string, never>; Returns: string }
      admin_update_vendor_business: { Args: { _vendor_id: string; _gstin: string; _city: string; _address: string }; Returns: boolean }
      admin_update_order_status: { Args: { _order_no: string; _status: string }; Returns: boolean }
      cancel_marketplace_order: { Args: { _order_no: string }; Returns: boolean }
      admin_broadcast_notification: { Args: { _audience: string; _title: string; _message: string }; Returns: number }
      admin_confirm_manual_payment: { Args: { _order_no: string; _amount: number; _utr: string; _method?: string | null }; Returns: boolean }
      admin_receive_inventory_batch: { Args: { _batch_code: string; _product_id: string; _quantity: number; _unit_cost: number; _purchase_date: string | null; _warehouse: string }; Returns: string }
      admin_review_vendor_kyc: { Args: { _id: string; _status: string; _notes?: string | null }; Returns: boolean }
      customer_submit_vendor_application: { Args: { _business_name: string; _owner_name: string; _phone: string; _gstin: string; _city: string; _address: string }; Returns: string }
      admin_review_vendor_application: { Args: { _id: string; _status: string; _notes?: string | null }; Returns: boolean }
    }
    Enums: {
      app_role: "admin" | "vendor" | "customer"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "vendor", "customer"],
    },
  },
} as const
