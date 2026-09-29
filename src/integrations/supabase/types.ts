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
          status: string
          unit: string
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
          status?: string
          unit?: string
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
          status?: string
          unit?: string
          updated_at?: string
          vendor?: string | null
          vendor_id?: string | null
          warehouse?: string | null
        }
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
      profiles: {
        Row: {
          avatar_url: string | null
          company: string | null
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
          company?: string | null
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
          company?: string | null
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
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
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
