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
      branches: {
        Row: { id: string; code: string; name: string; address: string; city: string; state: string; state_code: string; pincode: string; phone: string; email: string; map_url: string; instructions: string; gstin: string; zoho_location_id: string; zoho_location_name: string; zoho_pricebook_id: string; zoho_pricebook_name: string; serves_pincodes: string[]; pickup_enabled: boolean; delivery_enabled: boolean; delivery_fee: number; free_delivery_above: number | null; is_default: boolean; active: boolean; sort_order: number; created_at: string; updated_at: string; vendor_id: string | null }
        Insert: { id: string; code: string; name: string; address?: string; city?: string; state?: string; state_code?: string; pincode?: string; phone?: string; email?: string; map_url?: string; instructions?: string; gstin?: string; zoho_location_id?: string; zoho_location_name?: string; zoho_pricebook_id?: string; zoho_pricebook_name?: string; serves_pincodes?: string[]; pickup_enabled?: boolean; delivery_enabled?: boolean; delivery_fee?: number; free_delivery_above?: number | null; is_default?: boolean; active?: boolean; sort_order?: number; created_at?: string; updated_at?: string; vendor_id?: string | null }
        Update: { id?: string; code?: string; name?: string; address?: string; city?: string; state?: string; state_code?: string; pincode?: string; phone?: string; email?: string; map_url?: string; instructions?: string; gstin?: string; zoho_location_id?: string; zoho_location_name?: string; zoho_pricebook_id?: string; zoho_pricebook_name?: string; serves_pincodes?: string[]; pickup_enabled?: boolean; delivery_enabled?: boolean; delivery_fee?: number; free_delivery_above?: number | null; is_default?: boolean; active?: boolean; sort_order?: number; created_at?: string; updated_at?: string; vendor_id?: string | null }
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
        Row: { branch_id: string; product_id: string; stock: number; zoho_pending: boolean; updated_at: string }
        Insert: { branch_id: string; product_id: string; stock?: number; zoho_pending?: boolean; updated_at?: string }
        Update: { branch_id?: string; product_id?: string; stock?: number; zoho_pending?: boolean; updated_at?: string }
        Relationships: []
      }
      zoho_oauth_states: {
        Row: { state_hash: string; user_id: string; organization_id: string; region: string; expires_at: string; created_at: string }
        Insert: { state_hash: string; user_id: string; organization_id: string; region: string; expires_at: string; created_at?: string }
        Update: { state_hash?: string; user_id?: string; organization_id?: string; region?: string; expires_at?: string; created_at?: string }
        Relationships: []
      }
      zoho_contact_links: {
        Row: { user_id: string; contact_type: string; zoho_contact_id: string; updated_at: string; last_polled_at: string | null; last_zoho_modified_at: string | null }
        Insert: { user_id: string; contact_type: string; zoho_contact_id: string; updated_at?: string; last_polled_at?: string | null; last_zoho_modified_at?: string | null }
        Update: { user_id?: string; contact_type?: string; zoho_contact_id?: string; updated_at?: string; last_polled_at?: string | null; last_zoho_modified_at?: string | null }
        Relationships: []
      }
      zoho_item_links: {
        Row: { product_id: string; zoho_item_id: string; updated_at: string; last_polled_at: string | null; last_zoho_modified_at: string | null; app_fingerprint: string | null }
        Insert: { product_id: string; zoho_item_id: string; updated_at?: string; last_polled_at?: string | null; last_zoho_modified_at?: string | null; app_fingerprint?: string | null }
        Update: { product_id?: string; zoho_item_id?: string; updated_at?: string; last_polled_at?: string | null; last_zoho_modified_at?: string | null; app_fingerprint?: string | null }
        Relationships: []
      }
      zoho_catalog_tombstones: {
        Row: { product_id: string; zoho_item_id: string; deleted_at: string }
        Insert: { product_id: string; zoho_item_id: string; deleted_at?: string }
        Update: { product_id?: string; zoho_item_id?: string; deleted_at?: string }
        Relationships: []
      }
      zoho_sync_outbox: {
        Row: { id: string; entity_type: string; entity_id: string; event_type: string; status: string; attempts: number; available_at: string; locked_until: string | null; last_error: string | null; created_at: string; updated_at: string }
        Insert: { id?: string; entity_type: string; entity_id: string; event_type: string; status?: string; attempts?: number; available_at?: string; locked_until?: string | null; last_error?: string | null; created_at?: string; updated_at?: string }
        Update: { id?: string; entity_type?: string; entity_id?: string; event_type?: string; status?: string; attempts?: number; available_at?: string; locked_until?: string | null; last_error?: string | null; created_at?: string; updated_at?: string }
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
      batches: {
        Row: {
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
        Row: { order_id: string; order_no: string; zoho_invoice_id: string | null; invoice_number: string | null; status: string; total: number | null; balance: number | null; auto_attempts: number; admin_approved: boolean; approved_by: string | null; approved_at: string | null; last_event: string; updated_at: string }
        Insert: { order_id: string; order_no: string; zoho_invoice_id?: string | null; invoice_number?: string | null; status?: string; total?: number | null; balance?: number | null; auto_attempts?: number; admin_approved?: boolean; approved_by?: string | null; approved_at?: string | null; last_event?: string; updated_at?: string }
        Update: { order_id?: string; order_no?: string; zoho_invoice_id?: string | null; invoice_number?: string | null; status?: string; total?: number | null; balance?: number | null; auto_attempts?: number; admin_approved?: boolean; approved_by?: string | null; approved_at?: string | null; last_event?: string; updated_at?: string }
        Relationships: []
      }
      channel_partners: {
        Row: { id: string; user_id: string; branch_id: string; name: string; email: string; phone: string; status: string; created_by: string | null; created_at: string; updated_at: string }
        Insert: { user_id: string; branch_id: string; name: string; email: string; id?: string; phone?: string; status?: string; created_by?: string | null; created_at?: string; updated_at?: string }
        Update: { id?: string; user_id?: string; branch_id?: string; name?: string; email?: string; phone?: string; status?: string; created_by?: string | null; created_at?: string; updated_at?: string }
        Relationships: []
      }
      partner_commission_rules: {
        Row: { id: string; branch_id: string; product_id: string | null; kind: string; value: number; updated_by: string | null; updated_at: string }
        Insert: { branch_id: string; kind: string; value: number; id?: string; product_id?: string | null; updated_by?: string | null; updated_at?: string }
        Update: { id?: string; branch_id?: string; product_id?: string | null; kind?: string; value?: number; updated_by?: string | null; updated_at?: string }
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
      order_items: {
        Row: {
          batch_code: string | null
          capacity: string | null
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
          status: string
        }
        Insert: {
          actor_role?: string | null
          created_at?: string
          id?: string
          note?: string | null
          order_id: string
          status: string
        }
        Update: {
          actor_role?: string | null
          created_at?: string
          id?: string
          note?: string | null
          order_id?: string
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
        ]
      }
      orders: {
        Row: {
          zoho_salesorder_id: string | null
          branch_id: string | null
          zoho_last_polled_at: string | null
          zoho_order_status: string | null
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
          parent_order_no: string | null
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
          branch_id?: string | null
          zoho_salesorder_id?: string | null
          zoho_last_polled_at?: string | null
          zoho_order_status?: string | null
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
          parent_order_no?: string | null
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
          branch_id?: string | null
          zoho_salesorder_id?: string | null
          zoho_last_polled_at?: string | null
          zoho_order_status?: string | null
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
          parent_order_no?: string | null
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
        Row: { id: string; order_id: string; order_item_id: string; customer_id: string; product_id: string; vendor_id: string; quantity: number; amount: number; reason: string; status: string; refund_status: string; created_at: string; updated_at: string }
        Insert: { id?: string; order_id: string; order_item_id: string; customer_id: string; product_id: string; vendor_id: string; quantity: number; amount: number; reason: string; status?: string; refund_status?: string; created_at?: string; updated_at?: string }
        Update: { id?: string; order_id?: string; order_item_id?: string; customer_id?: string; product_id?: string; vendor_id?: string; quantity?: number; amount?: number; reason?: string; status?: string; refund_status?: string; created_at?: string; updated_at?: string }
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
      enqueue_zoho_sync: { Args: { _entity_type: string; _entity_id: string }; Returns: undefined }
      claim_zoho_sync_jobs: { Args: { _limit?: number }; Returns: Database["public"]["Tables"]["zoho_sync_outbox"]["Row"][] }
      apply_zoho_contact_update: { Args: { _user_id: string; _contact_type: string; _full_name: string | null; _phone: string | null; _company: string | null; _gstin: string | null; _address?: Json | null }; Returns: undefined }
      retry_zoho_sync_job: { Args: { _id: string }; Returns: undefined }
      apply_zoho_order_fulfillment: { Args: { _order_id: string; _status: string }; Returns: undefined }
      apply_zoho_order_cancellation: { Args: { _order_id: string }; Returns: string }
      branch_product_price: { Args: { _branch_id: string; _product_id: string }; Returns: number | null }
      admin_set_branch_price: { Args: { _branch_id: string; _product_id: string; _price: number | null; _listed?: boolean }; Returns: boolean }
      apply_zoho_branch_prices: { Args: { _branch_id: string; _pricebook_name: string; _prices: Json; _read_at: string }; Returns: number }
      apply_zoho_branch_stock: { Args: { _branch_id: string; _product_id: string; _stock: number; _read_at: string }; Returns: number | null }
      branch_pending_order_qty: { Args: { _branch_id: string }; Returns: { product_id: string; qty: number }[] }
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
      partner_leaderboard: {
        Args: { _month?: string }
        Returns: { rank: number; partner_id: string; partner_name: string; godown: string; sales: number; commission: number; earned: number; target: number; achieved_percent: number | null }[]
      }
      partner_commission_lines: {
        Args: { _month: string }
        Returns: { order_item_id: string; order_no: string; placed_at: string; order_status: string; payment_status: string; customer_name: string; pin: string; product_name: string; qty: number; line_total: number; kind: string; rate: number; amount: number; status: string; partner_id: string }[]
      }
      admin_update_payout: { Args: { _id: string; _status: string; _reference?: string | null }; Returns: boolean }
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
      default_branch_id: { Args: Record<string, never>; Returns: string }
      admin_update_vendor_business: { Args: { _vendor_id: string; _gstin: string; _city: string; _address: string }; Returns: boolean }
      admin_update_order_status: { Args: { _order_no: string; _status: string }; Returns: boolean }
      cancel_marketplace_order: { Args: { _order_no: string }; Returns: boolean }
      admin_broadcast_notification: { Args: { _audience: string; _title: string; _message: string }; Returns: number }
      admin_confirm_manual_payment: { Args: { _order_no: string; _amount: number; _utr: string }; Returns: boolean }
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
