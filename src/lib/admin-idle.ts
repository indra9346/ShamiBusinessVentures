/*
 * The admin panel's idle clock: when this admin last did something, per user, kept in the browser.
 * PanelLayout signs the admin out once it is older than the idle timeout.
 */
export const adminActivityKey = (userId: string) => `shami-admin-last-activity:${userId}`;

/**
 * A new sign-in starts a new clock. The time left from an earlier session (a logout, or a closed
 * tab) is hours or days old, so it would sign the admin straight out again and they would have to
 * log in twice.
 */
export function startAdminIdleClock(userId: string) {
  try {
    localStorage.setItem(adminActivityKey(userId), String(Date.now()));
  } catch {
    /* storage blocked: PanelLayout then has no clock to expire */
  }
}

export function clearAdminIdleClock(userId: string) {
  try {
    localStorage.removeItem(adminActivityKey(userId));
  } catch {
    /* storage blocked */
  }
}
