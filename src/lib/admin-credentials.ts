// Checks for the administrator's own password and login email changes (19 Nov 2026). No app imports, so the tests load
// it directly.

/** Why a new password can't be used, or "". */
export function passwordChangeProblem(input: { current: string; next: string; again: string; email: string }) {
  if (!input.current) return "Enter your current password";
  if (input.next.length < 8) return "The new password needs at least 8 characters";
  if (!/[A-Za-z]/.test(input.next) || !/\d/.test(input.next)) return "Use at least one letter and one number in the new password";
  if (input.next !== input.again) return "The two new passwords are not the same";
  if (input.next === input.current) return "The new password is the same as the current one";
  const local = input.email.split("@")[0]?.toLowerCase() ?? "";
  if (local.length >= 4 && input.next.toLowerCase().includes(local)) return "Don't use your email name in the password";
  if (/^(password|admin|grainbazar|shami)\d*$/i.test(input.next)) return "That password is too easy to guess";
  return "";
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Why the login email can't change to this, or "". */
export function emailChangeProblem(input: { current: string; next: string; password: string }) {
  const next = input.next.trim().toLowerCase();
  if (!EMAIL.test(next)) return "Enter the new email address";
  if (next === input.current.trim().toLowerCase()) return "That is already the login email";
  if (!input.password) return "Enter your current password";
  return "";
}
