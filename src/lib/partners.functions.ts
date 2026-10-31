import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { partnerPasswordProblem } from "@/lib/partners";

/*
 * Channel partner (godown distributor) accounts. Only administrators create them: the admin enters
 * the partner's name, email, phone and a password, shares those with the partner, and the partner
 * signs in at /partner/login. A partner account is not a customer or a vendor account.
 */

function serviceClient() {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!url || !key) throw new Error("Server configuration is missing the Supabase service settings");
  return createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function ensureAdmin(supabase: SupabaseClient<Database>, userId: string) {
  const { data, error } = await supabase.rpc("has_role", { _user_id: userId, _role: "admin" });
  if (error || !data) throw new Error("Administrator access is required");
}

const passwordSchema = z.string().superRefine((value, ctx) => {
  const problem = partnerPasswordProblem(value);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

/** Creates the godown's channel partner login (one active partner per godown). */
export const createChannelPartner = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({
    branchId: z.string().trim().min(1),
    name: z.string().trim().min(2).max(80),
    email: z.string().trim().toLowerCase().email().max(200),
    phone: z.string().trim().max(20).default(""),
    password: passwordSchema,
  }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = serviceClient();
    const { data: branch } = await db.from("branches").select("id,name").eq("id", data.branchId).maybeSingle();
    if (!branch) throw new Error("Godown not found");
    const { data: existing } = await db.from("channel_partners").select("name").eq("branch_id", data.branchId).eq("status", "active").maybeSingle();
    if (existing) throw new Error(`${branch.name} already has an active channel partner (${existing.name}). Suspend them first.`);

    const { data: created, error } = await db.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { full_name: data.name, phone: data.phone, account_type: "channel_partner" },
    });
    if (error || !created.user) {
      throw new Error(/already been registered|already exists/i.test(error?.message ?? "")
        ? "This email already has a Grain Bazar account. Use a different email for the partner login."
        : `The login could not be created: ${error?.message ?? "unknown error"}`);
    }
    const userId = created.user.id;
    // New accounts start as customers; a partner login is only a partner login.
    await db.from("user_roles").delete().eq("user_id", userId).eq("role", "customer");
    const { data: partner, error: insertError } = await db.from("channel_partners").insert({
      user_id: userId, branch_id: data.branchId, name: data.name, email: data.email, phone: data.phone, created_by: context.userId,
    }).select("id").single();
    if (insertError || !partner) {
      await db.auth.admin.deleteUser(userId);
      throw new Error("The partner could not be saved; nothing was created. Try again.");
    }
    return { partnerId: partner.id, email: data.email, godown: branch.name };
  });

/** Sets a new password for a partner (the admin shares it with them). */
export const resetChannelPartnerPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ partnerId: z.string().uuid(), password: passwordSchema }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = serviceClient();
    const { data: partner } = await db.from("channel_partners").select("user_id").eq("id", data.partnerId).maybeSingle();
    if (!partner) throw new Error("Partner not found");
    const { error } = await db.auth.admin.updateUserById(partner.user_id, { password: data.password });
    if (error) throw new Error(`The password could not be changed: ${error.message}`);
    return { ok: true };
  });

/** Suspends (the panel stops opening for them at once) or reactivates a partner. */
export const setChannelPartnerStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ partnerId: z.string().uuid(), status: z.enum(["active", "suspended"]) }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const db = serviceClient();
    const { data: partner } = await db.from("channel_partners").select("user_id,branch_id").eq("id", data.partnerId).maybeSingle();
    if (!partner) throw new Error("Partner not found");
    if (data.status === "active") {
      const { data: other } = await db.from("channel_partners").select("name").eq("branch_id", partner.branch_id)
        .eq("status", "active").neq("id", data.partnerId).maybeSingle();
      if (other) throw new Error(`This godown already has an active partner (${other.name}). Suspend them first.`);
    }
    // status_changed_by: the partner history log records which admin made the change.
    const now = new Date().toISOString();
    const { error } = await db.from("channel_partners")
      .update({ status: data.status, updated_at: now, status_changed_by: context.userId, status_changed_at: now }).eq("id", data.partnerId);
    if (error) throw new Error("The partner status could not be changed");
    return { ok: true };
  });
