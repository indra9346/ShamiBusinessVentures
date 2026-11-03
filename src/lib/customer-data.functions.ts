import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";
import { CUSTOMER_DELETE_WORD } from "@/lib/customer-data";

/*
 * Deleting a customer's information: the database step removes what can go and records who did it
 * (admin_delete_customer_data). The login can only be removed here, with the server's key, once that
 * step has left the orders free of it. Zoho is never called.
 */

function serviceClient() {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) throw new Error("Server configuration is missing the Supabase service settings");
  return createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

type DeleteResult = { request_id: string; summary: Json; already_done: boolean };

/** Safe to call again: if the login could not be removed the first time, this finishes the job. */
export const deleteCustomerData = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({
    customerId: z.string().uuid(),
    confirmation: z.literal(CUSTOMER_DELETE_WORD),
    /** Only finish a delete that already got through the database step. */
    retry: z.boolean().default(false),
  }))
  .handler(async ({ data, context }) => {
    const db = serviceClient();
    // Called as the signed-in admin: the database refuses anyone else, and takes the name for the record from their login.
    const { data: done, error } = await context.supabase.rpc("admin_delete_customer_data", {
      _customer_id: data.customerId,
      _confirmation: data.confirmation,
      _retry: data.retry,
    });
    if (error || !done) throw new Error(error?.message ?? "The information could not be deleted");
    const { request_id: requestId } = done as unknown as DeleteResult;
    const unfinished = (problem: string) => ({ requestId, loginRemoved: false, problem });

    // Seller documents are files. Their rows go with the login, so the files must go first.
    const { data: documents, error: documentsError } = await db.from("vendor_kyc_documents").select("object_path").eq("user_id", data.customerId);
    if (documentsError) return unfinished("Their uploaded seller documents could not be read.");
    if (documents?.length) {
      const { error: filesError } = await db.storage.from("vendor-kyc").remove(documents.map((row) => row.object_path));
      if (filesError) return unfinished("Their uploaded seller documents could not be removed.");
    }

    // The record notes this by itself when the profile goes with the login. A 404 means an earlier try already removed it.
    const { error: loginError } = await db.auth.admin.deleteUser(data.customerId);
    if (loginError && loginError.status !== 404) return unfinished(`Their login could not be removed: ${loginError.message}`);
    return { requestId, loginRemoved: true, problem: null };
  });
