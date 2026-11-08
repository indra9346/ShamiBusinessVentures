import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { normalisePartnerPhone, partnerEmailProblem, partnerPasswordProblem, partnerPhoneProblem } from "@/lib/partners";

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

/**
 * Changes a partner's phone and login email. The email is the one they sign in with (the real sign-in account changes, at
 * once and without a confirmation mail, since the admin is setting it); their password and any open session stay. The phone
 * is the one printed on the godown's invoices. Each change goes in the partner's log.
 */
export const updateChannelPartnerContact = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ partnerId: z.string().uuid(), email: z.string().trim().toLowerCase().max(200), phone: z.string().trim().max(20) }))
  .handler(async ({ data, context }) => {
    await ensureAdmin(context.supabase, context.userId);
    const emailProblem = partnerEmailProblem(data.email);
    if (emailProblem) throw new Error(emailProblem);
    const phoneProblem = partnerPhoneProblem(data.phone);
    if (phoneProblem) throw new Error(phoneProblem);
    const phone = normalisePartnerPhone(data.phone);
    const db = serviceClient();
    const { data: partner } = await db.from("channel_partners").select("id,user_id,branch_id,email,phone").eq("id", data.partnerId).maybeSingle();
    if (!partner) throw new Error("Partner not found");
    const emailChanged = data.email !== partner.email.toLowerCase();
    const phoneChanged = phone !== partner.phone;
    if (!emailChanged && !phoneChanged) return { emailChanged: false, phoneChanged: false };
    if (emailChanged) {
      const { data: other } = await db.from("channel_partners").select("name").eq("email", data.email).neq("id", partner.id).maybeSingle();
      if (other) throw new Error(`${other.name} already signs in with this email.`);
      const { error } = await db.auth.admin.updateUserById(partner.user_id, { email: data.email, email_confirm: true });
      if (error) {
        throw new Error(/already been registered|already exists|already registered/i.test(error.message)
          ? "This email already has a Grain Bazar account. Use a different email for the partner login."
          : `The login email could not be changed: ${error.message}`);
      }
    }
    await db.auth.admin.updateUserById(partner.user_id, { user_metadata: { phone } });
    const { error: saveError } = await db.from("channel_partners").update({ email: data.email, phone, updated_at: new Date().toISOString() }).eq("id", partner.id);
    if (saveError) {
      // The sign-in account already moved: put it back, so the page and the login never disagree.
      if (emailChanged) await db.auth.admin.updateUserById(partner.user_id, { email: partner.email, email_confirm: true });
      throw new Error("The partner could not be saved; nothing was changed. Try again.");
    }
    const { data: actor } = await db.from("profiles").select("full_name").eq("id", context.userId).maybeSingle();
    await db.from("channel_partner_events").insert({
      partner_id: partner.id, branch_id: partner.branch_id, event: "contact_changed", by_user: context.userId, by_name: actor?.full_name ?? "",
      detail: [emailChanged ? `Email ${partner.email} to ${data.email}` : "", phoneChanged ? `Phone ${partner.phone || "none"} to ${phone || "none"}` : ""].filter(Boolean).join("; "),
    } as never);
    return { emailChanged, phoneChanged };
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
