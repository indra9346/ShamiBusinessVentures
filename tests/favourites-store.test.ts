import { test } from "node:test";
import assert from "node:assert/strict";
import { createFavouritesStore, type FavouriteRow, type FavouritesDb, type FavouritesStorage } from "../src/lib/favourites-store.ts";

// The favourites kept per person (owner, 11 Nov 2026), checked against the review of 12 Nov 2026: another person
// signing in on the same browser, a removal on one phone not undone by another, changes made before the database
// answered, a change that could not be saved.

const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";

/** The database: rows per person and panel, with a switch to make it fail and a gate to hold its answers. */
function fakeDb() {
  const rows: FavouriteRow[] = [];
  let failing = false;
  let missing = false;
  let hold: Promise<void> | null = null;
  /** Fails just the calls it picks ("add <keys>", "remove <key>", "place <key>=<n>"). */
  let failIf: ((call: string) => boolean) | null = null;
  const calls: string[] = [];
  const db: FavouritesDb = {
    async select(userId, panel) {
      calls.push("select");
      if (hold) await hold;
      if (missing) return { data: null, error: { message: 'relation "public.panel_favourites" does not exist', code: "42P01" } };
      if (failing) return { data: null, error: { message: "network" } };
      const mine = rows.filter((row) => row.user_id === userId && row.panel === panel).sort((a, b) => a.position - b.position);
      return { data: mine.map((row) => ({ ...row })), error: null };
    },
    async add(list) {
      calls.push(`add ${list.map((row) => row.item_key).join(",")}`);
      if (failing || missing || failIf?.(calls.at(-1)!)) return { error: { message: "network" } };
      for (const row of list) {
        const at = rows.findIndex((item) => item.user_id === row.user_id && item.panel === row.panel && item.item_key === row.item_key);
        if (at >= 0) rows[at] = { ...row };
        else rows.push({ ...row });
      }
      return { error: null };
    },
    async remove(userId, panel, key) {
      calls.push(`remove ${key}`);
      if (failing || missing || failIf?.(calls.at(-1)!)) return { error: { message: "network" } };
      for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i]!.user_id === userId && rows[i]!.panel === panel && rows[i]!.item_key === key) rows.splice(i, 1);
      return { error: null };
    },
    async place(userId, panel, key, position) {
      calls.push(`place ${key}=${position}`);
      if (failing || missing || failIf?.(calls.at(-1)!)) return { error: { message: "network" } };
      for (const row of rows) if (row.user_id === userId && row.panel === panel && row.item_key === key) row.position = position;
      return { error: null };
    },
  };
  return {
    db, rows, calls,
    fail: (on: boolean) => { failing = on; },
    failWhen: (pick: ((call: string) => boolean) | null) => { failIf = pick; },
    noTable: (on: boolean) => { missing = on; },
    holdAnswers: () => {
      let release!: () => void;
      hold = new Promise((resolve) => { release = resolve; });
      return () => { hold = null; release(); };
    },
  };
}
function fakeStorage(): FavouritesStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: (key) => map.get(key) ?? null, set: (key, value) => { map.set(key, value); }, remove: (key) => { map.delete(key); } };
}
function device(server: ReturnType<typeof fakeDb>, who: { id: string | null }, storage = fakeStorage()) {
  const store = createFavouritesStore("admin", { db: server.db, storage, currentUser: async () => who.id });
  return { store, storage, keys: () => store.getState().list.map((fav) => fav.key) };
}
const ORDERS = { to: "/admin/orders", label: "Orders", find: "" };
const EMPLOYEE = { to: "/admin/attendance", label: "Add employee", find: "Add employee" };
const PARTNER = { to: "/admin/partners", label: "Add channel partner", find: "Add channel partner" };

test("one person's favourites: added and removed one row at a time, kept in order", async () => {
  const server = fakeDb();
  const who = { id: ADMIN };
  const { store, keys } = device(server, who);
  await store.ensure();
  assert.equal(store.getState().mode, "synced");
  assert.equal(await store.toggle(ORDERS), "added");
  assert.equal(await store.toggle(EMPLOYEE), "added");
  assert.deepEqual(keys(), ["/admin/orders", "/admin/attendance#Add employee"]);
  assert.deepEqual(server.rows.map((row) => [row.item_key, row.position]), [["/admin/orders", 0], ["/admin/attendance#Add employee", 1]]);
  assert.equal(await store.move("/admin/attendance#Add employee", -1), true);
  assert.deepEqual(server.calls.slice(-2).sort(), ["place /admin/attendance#Add employee=0", "place /admin/orders=1"], "only the two that moved");
  assert.equal(await store.toggle(ORDERS), "removed");
  assert.deepEqual(server.rows.map((row) => row.item_key), ["/admin/attendance#Add employee"]);
  assert.ok(!server.calls.some((call) => /^add .*,/.test(call)), "never the whole list at once");
});

test("another person signing in on the same browser gets their own list, never the last person's", async () => {
  const server = fakeDb();
  const who: { id: string | null } = { id: ADMIN };
  const { store, keys } = device(server, who);
  await store.ensure();
  await store.toggle(ORDERS);
  // Signed out (no page reload), then someone else signs in.
  who.id = null;
  await store.ensure();
  assert.deepEqual(keys(), []);
  assert.equal(await store.toggle(PARTNER), "signed-out");
  who.id = OTHER;
  await store.ensure();
  assert.equal(store.getState().userId, OTHER);
  assert.deepEqual(keys(), []);
  assert.equal(await store.toggle(PARTNER), "added");
  assert.deepEqual(server.rows.filter((row) => row.user_id === OTHER).map((row) => row.item_key), ["/admin/partners#Add channel partner"]);
  assert.deepEqual(server.rows.filter((row) => row.user_id === ADMIN).map((row) => row.item_key), ["/admin/orders"], "the first person's untouched");
  // Straight to the other person without signing out in between (no page reload either).
  who.id = ADMIN;
  await store.ensure();
  assert.deepEqual(keys(), ["/admin/orders"]);
});

test("an answer for someone who has since signed out is dropped", async () => {
  const server = fakeDb();
  server.rows.push({ user_id: ADMIN, panel: "admin", item_key: "/admin/orders", label: "Orders", to_path: "/admin/orders", find_text: "", position: 0 });
  const who: { id: string | null } = { id: ADMIN };
  const { store, keys } = device(server, who);
  const release = server.holdAnswers();
  const slow = store.load();
  await new Promise((resolve) => setTimeout(resolve, 5));
  who.id = OTHER;
  const fresh = store.load();
  release();
  await Promise.all([slow, fresh]);
  assert.equal(store.getState().userId, OTHER);
  assert.deepEqual(keys(), [], "not the admin's list");
});

test("a removal on one phone is not undone by another phone's old copy", async () => {
  const server = fakeDb();
  const who = { id: ADMIN };
  const laptop = device(server, who);
  await laptop.store.ensure();
  await laptop.store.toggle(ORDERS);
  await laptop.store.toggle(EMPLOYEE);
  // The phone removes both.
  const phone = device(server, who);
  await phone.store.ensure();
  assert.deepEqual(phone.keys(), ["/admin/orders", "/admin/attendance#Add employee"]);
  await phone.store.toggle(ORDERS);
  await phone.store.toggle(EMPLOYEE);
  assert.equal(server.rows.length, 0);
  // The laptop opens the panel again: its copy still has both. A fresh page, same browser storage.
  const again = device(server, who, laptop.storage);
  await again.store.ensure();
  assert.deepEqual(again.keys(), [], "empty, as on the phone");
  assert.equal(server.rows.length, 0, "nothing put back");
});

test("a change on one phone does not put back what another phone removed", async () => {
  const server = fakeDb();
  const who = { id: ADMIN };
  const laptop = device(server, who);
  await laptop.store.ensure();
  await laptop.store.toggle(ORDERS);
  await laptop.store.toggle(EMPLOYEE);
  const phone = device(server, who);
  await phone.store.ensure();
  await phone.store.toggle(ORDERS); // removed on the phone
  await laptop.store.toggle(PARTNER); // the laptop still shows Orders
  await laptop.store.move("/admin/partners#Add channel partner", -1);
  assert.ok(!server.rows.some((row) => row.item_key === "/admin/orders"), "Orders stays removed");
});

test("favourites kept on the device before the database update move in once", async () => {
  const server = fakeDb();
  server.noTable(true);
  const who = { id: ADMIN };
  const before = device(server, who);
  await before.store.ensure();
  assert.equal(before.store.getState().mode, "local");
  assert.equal(await before.store.toggle(ORDERS), "added");
  assert.equal(await before.store.toggle(EMPLOYEE), "added");
  assert.equal(await before.store.toggle(EMPLOYEE), "removed");
  assert.equal(server.rows.length, 0, "no table yet");
  // The update is applied; the next page finds the table.
  server.noTable(false);
  const after = device(server, who, before.storage);
  await after.store.ensure();
  assert.equal(after.store.getState().mode, "synced");
  assert.deepEqual(after.keys(), ["/admin/orders"]);
  assert.deepEqual(server.rows.map((row) => row.item_key), ["/admin/orders"]);
  // Removed later on another phone: not moved in again.
  server.rows.length = 0;
  const later = device(server, who, before.storage);
  await later.store.ensure();
  assert.deepEqual(later.keys(), []);
  assert.equal(server.rows.length, 0);
});

test("a star tapped before the database answered is kept, not wiped by the answer", async () => {
  const server = fakeDb();
  server.rows.push({ user_id: ADMIN, panel: "admin", item_key: "/admin/orders", label: "Orders", to_path: "/admin/orders", find_text: "", position: 0 });
  const who = { id: ADMIN };
  const { store, keys } = device(server, who);
  const release = server.holdAnswers();
  const loading = store.ensure();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(store.getState().mode, "loading");
  assert.equal(await store.toggle(EMPLOYEE), "added");
  release();
  await loading;
  assert.deepEqual(keys(), ["/admin/orders", "/admin/attendance#Add employee"]);
  assert.deepEqual(server.rows.map((row) => row.item_key), ["/admin/orders", "/admin/attendance#Add employee"]);
});

test("while the database cannot be reached, changes wait and are saved on the next answer", async () => {
  const server = fakeDb();
  const who = { id: ADMIN };
  const first = device(server, who);
  await first.store.ensure();
  await first.store.toggle(ORDERS);
  server.fail(true);
  const offline = device(server, who, first.storage);
  await offline.store.ensure();
  assert.equal(offline.store.getState().mode, "local");
  assert.deepEqual(offline.keys(), ["/admin/orders"], "the device's copy meanwhile");
  assert.equal(await offline.store.toggle(ORDERS), "removed");
  assert.equal(await offline.store.toggle(PARTNER), "added");
  server.fail(false);
  const online = device(server, who, first.storage);
  await online.store.ensure();
  assert.deepEqual(online.keys(), ["/admin/partners#Add channel partner"]);
  assert.deepEqual(server.rows.map((row) => row.item_key), ["/admin/partners#Add channel partner"]);
  assert.equal(first.storage.get(`gb-favourites-pending:${ADMIN}:admin`), null, "nothing left waiting");
});

test("a change the database refuses is undone on screen and reported", async () => {
  const server = fakeDb();
  const who = { id: ADMIN };
  const { store, keys } = device(server, who);
  await store.ensure();
  await store.toggle(ORDERS);
  server.fail(true);
  assert.equal(await store.toggle(EMPLOYEE), "failed");
  assert.deepEqual(keys(), ["/admin/orders"]);
  assert.equal(await store.toggle(ORDERS), "failed");
  assert.deepEqual(keys(), ["/admin/orders"]);
  await store.toggle(PARTNER);
  server.fail(false);
  await store.toggle(PARTNER);
  assert.equal(await store.move("/admin/partners#Add channel partner", -1), true);
  server.fail(true);
  assert.equal(await store.move("/admin/partners#Add channel partner", 1), false);
  assert.deepEqual(keys(), ["/admin/partners#Add channel partner", "/admin/orders"], "back as it was");
});

test("40 at most; blocked storage does not break anything", async () => {
  const server = fakeDb();
  const who = { id: ADMIN };
  const broken: FavouritesStorage = { get: () => { throw new Error("blocked"); }, set: () => { throw new Error("blocked"); }, remove: () => { throw new Error("blocked"); } };
  const store = createFavouritesStore("admin", { db: server.db, storage: broken, currentUser: async () => who.id });
  await store.ensure();
  for (let i = 0; i < 40; i += 1) assert.equal(await store.toggle({ to: `/admin/p${i}`, label: `P${i}`, find: "" }), "added");
  assert.equal(await store.toggle({ to: "/admin/p40", label: "P40", find: "" }), "full");
  assert.equal(server.rows.length, 40);
});

test("the menu, the star and the search asking at once read the database once", async () => {
  const server = fakeDb();
  const { store } = device(server, { id: ADMIN });
  await Promise.all([store.ensure(), store.ensure(), store.ensure()]);
  assert.equal(server.calls.filter((call) => call === "select").length, 1);
  await store.ensure();
  assert.equal(server.calls.filter((call) => call === "select").length, 1, "same person: no new read");
});

// ---- second review, 12 Nov 2026

const STOCK = { to: "/admin/stock-counts", label: "Stock Counts", find: "" };
const PAYMENTS = { to: "/admin/payments", label: "Payments & Matching", find: "" };
const fav = (label: string) => ({ to: `/admin/${label.toLowerCase()}`, label, find: "" });

test("the saved order matches the screen after removals, adds and moves (another phone sees the same)", async () => {
  const server = fakeDb();
  const who = { id: ADMIN };
  const { store, keys } = device(server, who);
  await store.ensure();
  await store.toggle(ORDERS);
  await store.toggle(STOCK);
  await store.toggle(PAYMENTS);
  await store.toggle(ORDERS);
  await store.toggle(STOCK);
  await store.toggle(EMPLOYEE);
  assert.deepEqual(keys(), ["/admin/payments", "/admin/attendance#Add employee"]);
  const other = device(server, who);
  await other.store.ensure();
  assert.deepEqual(other.keys(), keys(), "another phone shows the same order");
  assert.deepEqual(server.rows.map((row) => [row.item_key, row.position]).sort(), [["/admin/attendance#Add employee", 1], ["/admin/payments", 0]]);

  // A..E, remove A and B, move E up: C, E, D everywhere.
  const fresh = fakeDb();
  const five = device(fresh, who);
  await five.store.ensure();
  for (const name of ["A", "B", "C", "D", "E"]) await five.store.toggle(fav(name));
  await five.store.toggle(fav("A"));
  await five.store.toggle(fav("B"));
  await five.store.move("/admin/e", -1);
  assert.deepEqual(five.keys(), ["/admin/c", "/admin/e", "/admin/d"]);
  const again = device(fresh, who);
  await again.store.ensure();
  assert.deepEqual(again.keys(), ["/admin/c", "/admin/e", "/admin/d"]);
});

test("a database that already has gaps in its places is put right on the next read", async () => {
  const server = fakeDb();
  for (const [key, position] of [["/admin/x", 5], ["/admin/y", 9], ["/admin/z", 9]] as const) {
    server.rows.push({ user_id: ADMIN, panel: "admin", item_key: key, label: key, to_path: key, find_text: "", position });
  }
  const { store, keys } = device(server, { id: ADMIN });
  await store.ensure();
  assert.deepEqual(keys(), ["/admin/x", "/admin/y", "/admin/z"]);
  assert.deepEqual(server.rows.map((row) => row.position), [0, 1, 2]);
});

test("a move made before the database answered (also before the database update) is kept", async () => {
  const server = fakeDb();
  server.noTable(true);
  const who = { id: ADMIN };
  const before = device(server, who);
  await before.store.ensure();
  await before.store.toggle(ORDERS);
  await before.store.toggle(PAYMENTS);
  assert.equal(await before.store.move("/admin/payments", -1), true);
  assert.deepEqual(before.keys(), ["/admin/payments", "/admin/orders"]);
  server.noTable(false);
  const after = device(server, who, before.storage);
  await after.store.ensure();
  assert.deepEqual(after.keys(), ["/admin/payments", "/admin/orders"]);
  const elsewhere = device(server, who);
  await elsewhere.store.ensure();
  assert.deepEqual(elsewhere.keys(), ["/admin/payments", "/admin/orders"], "in the database in that order");
});

test("a failed save undoes only that change", async () => {
  const server = fakeDb();
  const who = { id: ADMIN };
  const { store, keys } = device(server, who);
  await store.ensure();
  // Both fail, made one after the other without waiting: neither stays.
  server.fail(true);
  const [first, second] = await Promise.all([store.toggle(ORDERS), store.toggle(PAYMENTS)]);
  assert.deepEqual([first, second], ["failed", "failed"]);
  assert.deepEqual(keys(), [], "nothing shown that was not saved");
  server.fail(false);
  // The first fails, the second is saved: the second stays.
  server.failWhen((call) => call === "add /admin/orders");
  const [one, two] = await Promise.all([store.toggle(ORDERS), store.toggle(PAYMENTS)]);
  assert.deepEqual([one, two], ["failed", "added"]);
  assert.deepEqual(keys(), ["/admin/payments"]);
  assert.deepEqual(server.rows.map((row) => row.item_key), ["/admin/payments"]);
  server.failWhen(null);
  // A failed removal comes back in its place.
  await store.toggle(ORDERS);
  await store.toggle(STOCK);
  server.failWhen((call) => call === "remove /admin/orders");
  assert.equal(await store.toggle(ORDERS), "failed");
  assert.deepEqual(keys(), ["/admin/payments", "/admin/orders", "/admin/stock-counts"]);
});

test("what was saved after a partly failed answer is not replayed over a newer change", async () => {
  const server = fakeDb();
  const who = { id: ADMIN };
  const first = device(server, who);
  await first.store.ensure();
  await first.store.toggle(ORDERS);
  // Offline: remove Orders, star Payments.
  server.fail(true);
  const offline = device(server, who, first.storage);
  await offline.store.ensure();
  await offline.store.toggle(ORDERS);
  await offline.store.toggle(PAYMENTS);
  // Back online, but adding Payments fails this time; the removal of Orders is saved.
  server.fail(false);
  server.failWhen((call) => call.startsWith("add "));
  const back = device(server, who, first.storage);
  await back.store.ensure();
  assert.deepEqual(server.rows.map((row) => row.item_key), [], "Orders removed, Payments not yet");
  server.failWhen(null);
  // The person stars Orders again, saved at once.
  assert.equal(await back.store.toggle(ORDERS), "added");
  // The next page: Orders must stay, and Payments (still waiting) is saved now.
  const later = device(server, who, first.storage);
  await later.store.ensure();
  assert.deepEqual(later.keys().sort(), ["/admin/orders", "/admin/payments"]);
  assert.deepEqual(server.rows.map((row) => row.item_key).sort(), ["/admin/orders", "/admin/payments"]);
});

test("a star taken off while its pending save was going in is off in the database too", async () => {
  const server = fakeDb();
  const who = { id: ADMIN };
  const { store, keys } = device(server, who);
  const release = server.holdAnswers();
  const loading = store.ensure();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.toggle(PAYMENTS); // pending add
  release();
  // Taken off again right as the answer is being saved.
  const off = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    return store.toggle(PAYMENTS);
  })();
  await Promise.all([loading, off]);
  await store.ensure();
  assert.deepEqual(keys(), []);
  assert.deepEqual(server.rows.map((row) => row.item_key), []);
});

test("without an answer, a page asks the database again after a minute", async () => {
  const server = fakeDb();
  let clock = 1_000;
  server.fail(true);
  const store = createFavouritesStore("admin", { db: server.db, storage: fakeStorage(), currentUser: async () => ADMIN, now: () => clock });
  await store.ensure();
  assert.equal(store.getState().mode, "local");
  server.fail(false);
  await store.ensure();
  assert.equal(store.getState().mode, "local", "not straight away");
  clock += 61_000;
  await store.ensure();
  assert.equal(store.getState().mode, "synced");
});
