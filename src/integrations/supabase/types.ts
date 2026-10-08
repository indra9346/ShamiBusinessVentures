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
      addresses: {
        Row: {
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
        }
        Insert: {
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
        }
        Update: {
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
        Row: { code: string; discount_type: string; discount_value: number; minimum_order: number; maximum_discount: number; starts_on: string; ends_on: string; usage_limit: number; used_count: number; active: boolean; created_by: string | null; created_at: string }
        Insert: { code: string; discount_type: string; discount_value: number; minimum_order?: number; maximum_discount: number; starts_on: string; ends_on: string; usage_limit: number; used_count?: number; active?: boolean; created_by?: string | null; created_at?: string }
        Update: { code?: string; discount_type?: string; discount_value?: number; minimum_order?: number; maximum_discount?: number; starts_on?: string; ends_on?: string; usage_limit?: number; used_count?: number; active?: boolean; created_by?: string | null; created_at?: string }
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
      can_read_order: { Args: { _order: string }; Returns: boolean }
      current_vendor_id: { Args: never; Returns: string }
      admin_set_profile_status: { Args: { _profile_id: string; _status: string }; Returns: boolean }
      admin_set_vendor_commission: { Args: { _vendor_id: string; _rate: number }; Returns: boolean }
      admin_set_review_status: { Args: { _id: string; _status: string }; Returns: boolean }
      admin_delete_review: { Args: { _id: string }; Returns: boolean }
      customer_delete_own_review: { Args: { _id: string }; Returns: boolean }
      vendor_reply_to_review: { Args: { _id: string; _reply: string }; Returns: boolean }
      vendor_report_review: { Args: { _id: string; _reason: string }; Returns: boolean }
      customer_request_return: { Args: { _order_item_id: string; _quantity: number; _reason: string }; Returns: string }
      customer_set_default_address: { Args: { _id: string }; Returns: boolean }
      admin_update_return: { Args: { _id: string; _status: string; _refund_status: string }; Returns: boolean }
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
      request_vendor_payout: { Args: { _amount: number; _method?: string }; Returns: string }
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
