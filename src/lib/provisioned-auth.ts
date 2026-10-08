import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

export type ProvisionedRole = "admin" | "vendor";

/** Authenticate an already-provisioned admin/vendor with email and password. */
export async function signInProvisionedAccount(email: string, password: string, role: ProvisionedRole) {
  const cleanEmail = email.trim().toLowerCase();
  let authenticated = false;

  try {
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email: cleanEmail,
      password,
    });

    if (authError || !authData.user) {
      toast.error("Could not sign in", {
        description: authError?.message ?? "Check the email and password, then try again.",
      });
      return null;
    }
    authenticated = true;

    const [roleResult, profileResult] = await Promise.all([
      supabase.from("user_roles").select("role").eq("user_id", authData.user.id).eq("role", role).maybeSingle(),
      supabase.from("profiles").select("full_name, phone, vendor_id, status").eq("id", authData.user.id).maybeSingle(),
    ]);

    if (roleResult.error || !roleResult.data) {
      await supabase.auth.signOut();
      authenticated = false;
      toast.error(`This account is not authorized for ${role} access`);
      return null;
    }

    const profile = profileResult.data;
    if (profileResult.error || !profile || (role === "vendor" && !profile.vendor_id)) {
      await supabase.auth.signOut();
      authenticated = false;
      toast.error("This account’s profile is incomplete", {
        description: role === "vendor"
          ? "Ask an administrator to assign a unique vendor ID before signing in."
          : "Ask an administrator to complete the account profile.",
      });
      return null;
    }

    if (role === "vendor" && ["pending", "suspended", "inactive", "rejected"].includes((profile.status ?? "").trim().toLowerCase())) {
      await supabase.auth.signOut();
      authenticated = false;
      toast.error("This vendor account is not active");
      return null;
    }

    return {
      id: authData.user.id,
      name: profile.full_name.trim() || cleanEmail.split("@")[0] || role,
      email: authData.user.email ?? cleanEmail,
      ...(profile.phone ? { phone: profile.phone } : {}),
    };
  } catch {
    if (authenticated) await supabase.auth.signOut();
    toast.error("Unable to verify this staff account", {
      description: "Check your connection and try again. If the problem continues, contact the administrator.",
    });
    return null;
  }
}
