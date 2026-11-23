import { useState } from "react";
import { toast } from "sonner";
import { KeyRound, Mail } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Panel } from "@/components/panel/widgets";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { emailChangeProblem, passwordChangeProblem } from "@/lib/admin-credentials";

/*
 * The administrator's own login (client, 19 Nov 2026: "update the admin credentials, and if he forgot or wants to change
 * his admin password he should be able to"): change the password here with the current one (other browsers are signed
 * out after it), or change the login email (Supabase emails a confirmation link first). A forgotten password is reset
 * from the admin login page by email. Nobody else ever sees or types the password.
 */
export function AdminCredentials({ email }: { email: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [busy, setBusy] = useState<"" | "password" | "email">("");
  const [problem, setProblem] = useState<{ password: string; email: string }>({ password: "", email: "" });

  /** The current password, checked by signing in again as the same person. */
  const checkCurrent = async (password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error("The current password is not right");
  };

  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    const why = passwordChangeProblem({ current, next, again, email });
    if (why) { setProblem((p) => ({ ...p, password: why })); return; }
    setBusy("password"); setProblem((p) => ({ ...p, password: "" }));
    try {
      if (STATIC_DATA_MODE) { toast.success("Preview: nothing is saved"); return; }
      await checkCurrent(current);
      const { error } = await supabase.auth.updateUser({ password: next });
      if (error) throw new Error(error.message);
      // Anyone still signed in elsewhere with the old password is signed out.
      await supabase.auth.signOut({ scope: "others" }).catch(() => undefined);
      setCurrent(""); setNext(""); setAgain("");
      toast.success("Password changed", { description: "Use the new password from now on. Other browsers signed in to this account were signed out." });
    } catch (cause) {
      setProblem((p) => ({ ...p, password: cause instanceof Error ? cause.message : "Could not change the password" }));
    } finally {
      setBusy("");
    }
  };

  const changeEmail = async (event: React.FormEvent) => {
    event.preventDefault();
    const why = emailChangeProblem({ current: email, next: newEmail, password: emailPassword });
    if (why) { setProblem((p) => ({ ...p, email: why })); return; }
    setBusy("email"); setProblem((p) => ({ ...p, email: "" }));
    try {
      if (STATIC_DATA_MODE) { toast.success("Preview: nothing is saved"); return; }
      await checkCurrent(emailPassword);
      const { error } = await supabase.auth.updateUser({ email: newEmail.trim().toLowerCase() }, { emailRedirectTo: `${window.location.origin}/admin/profile` });
      if (error) throw new Error(error.message);
      setEmailPassword("");
      toast.success("Check your email", { description: `A confirmation link was sent to ${newEmail.trim().toLowerCase()}. The login email changes once it is opened (and the link sent to ${email}, if asked).`, duration: 15000 });
    } catch (cause) {
      setProblem((p) => ({ ...p, email: cause instanceof Error ? cause.message : "Could not change the login email" }));
    } finally {
      setBusy("");
    }
  };

  return (
    <Panel title="Login and password">
      <div className="grid gap-6 md:grid-cols-2">
        <form onSubmit={(e) => void changePassword(e)} className="grid content-start gap-2 text-sm" autoComplete="on">
          <p className="flex items-center gap-2 font-semibold text-navy"><KeyRound className="h-4 w-4 text-gold" />Change password</p>
          <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
          <label className="grid gap-1 text-xs font-semibold text-slate">Current password
            <PasswordInput autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-slate">New password (at least 8, with a letter and a number)
            <PasswordInput autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-slate">New password again
            <PasswordInput autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
          </label>
          {problem.password && <p className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{problem.password}</p>}
          <Button type="submit" disabled={busy !== ""} className="justify-self-start bg-navy text-white hover:bg-navy/90">{busy === "password" ? "Changing…" : "Change password"}</Button>
        </form>
        <form onSubmit={(e) => void changeEmail(e)} className="grid content-start gap-2 text-sm">
          <p className="flex items-center gap-2 font-semibold text-navy"><Mail className="h-4 w-4 text-gold" />Change login email</p>
          <p className="text-xs text-slate">{`Now: ${email}`}</p>
          <label className="grid gap-1 text-xs font-semibold text-slate">New login email
            <Input type="email" autoComplete="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
          </label>
          <label className="grid gap-1 text-xs font-semibold text-slate">Current password
            <PasswordInput autoComplete="current-password" value={emailPassword} onChange={(e) => setEmailPassword(e.target.value)} />
          </label>
          {problem.email && <p className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">{problem.email}</p>}
          <Button type="submit" disabled={busy !== ""} variant="outline" className="justify-self-start">{busy === "email" ? "Sending…" : "Send confirmation link"}</Button>
        </form>
      </div>
      <p className="mt-4 text-xs text-slate">Forgot the password? On the admin login page press "Forgot password? Reset it by email": a link to set a new one goes to the login email.</p>
    </Panel>
  );
}
