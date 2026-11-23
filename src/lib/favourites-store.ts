// Each person's favourite pages and buttons in one panel (owner, 11 Nov 2026), kept in the database
// (public.panel_favourites) and copied on the device so the menu draws at once. No app imports: the database and the
// device storage are handed in, so the tests run every case without a browser.
//
// The rules that keep it right (reviews of 12 Nov 2026):
// - A change is saved one row at a time (add one, remove one, put rows in their places), never the whole list, so a
//   favourite removed on another phone is not put back by a change here.
// - The saved places always match the order on screen: after an add, a removal or a move, every row whose saved place
//   differs from where it stands is moved there (an update, which cannot bring back a row removed elsewhere).
// - The copy on the device is only a copy. It goes into the database once: the first time this device finds the table
//   (favourites kept before the database update), in the order the person left them.
// - A change made before the database answered, or while it could not be reached, is kept as pending (adds, removals
//   and the order) and saved on the next answer; each step is crossed off once saved, so nothing is replayed later
//   over a newer change.
// - A save that fails undoes only that change on screen.
// - A different person signing in on the same browser gets their own list; an answer for someone who has since signed
//   out is dropped.
import { MAX_FAVOURITES, cleanFavourites, entryKey, moveFavourite, toggleFavourite, type Favourite } from "./panel-search.ts";

type Failure = { message: string; code?: string } | null;
export type FavouriteRow = { user_id: string; panel: string; item_key: string; label: string; to_path: string; find_text: string; position: number };
export type FavouritesDb = {
  select(userId: string, panel: string): Promise<{ data: unknown[] | null; error: Failure }>;
  /** Adds rows; the same row twice is harmless (an upsert on user, panel and key). */
  add(rows: FavouriteRow[]): Promise<{ error: Failure }>;
  remove(userId: string, panel: string, key: string): Promise<{ error: Failure }>;
  /** Changes one row's place; a row that is not there (removed elsewhere) stays not there. */
  place(userId: string, panel: string, key: string, position: number): Promise<{ error: Failure }>;
};
export type FavouritesStorage = { get(key: string): string | null; set(key: string, value: string): void; remove(key: string): void };

/** loading: asking the database; synced: the database answered; local: no answer (no table yet, or no network). */
export type FavouritesState = { list: Favourite[]; userId: string | null; mode: "loading" | "synced" | "local" };
export type ToggleResult = "added" | "removed" | "full" | "signed-out" | "failed";
type Pending = { adds: Favourite[]; removes: string[]; order: string[] | null };

/** How long a panel without an answer waits before asking the database again (a page change asks again after it). */
const RETRY_MS = 60_000;

export function createFavouritesStore(panel: string, deps: {
  db: FavouritesDb; storage: FavouritesStorage; currentUser: () => Promise<string | null>; now?: () => number;
}) {
  const { db, storage } = deps;
  const now = deps.now ?? (() => Date.now());
  let state: FavouritesState = { list: [], userId: null, mode: "loading" };
  let checked = false;
  let lastTry = 0;
  let generation = 0;
  /** Where each favourite is saved in the database (rows this device knows are there). */
  let saved = new Map<string, number>();
  const listeners = new Set<() => void>();
  const publish = (next: FavouritesState) => {
    state = next;
    listeners.forEach((listener) => listener());
  };

  const listKey = (userId: string) => `gb-favourites:${userId}:${panel}`;
  const syncedKey = (userId: string) => `gb-favourites-synced:${userId}:${panel}`;
  const pendingKey = (userId: string) => `gb-favourites-pending:${userId}:${panel}`;
  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback; // storage blocked: the database still holds them
    }
  };
  const readList = (userId: string) => safe(() => cleanFavourites(JSON.parse(storage.get(listKey(userId)) ?? "[]")), []);
  const writeList = (userId: string, list: Favourite[]) =>
    safe(() => storage.set(listKey(userId), JSON.stringify(list.map(({ to, label, find }) => ({ to, label, find })))), undefined);
  const readPending = (userId: string): Pending => safe(() => {
    const raw = JSON.parse(storage.get(pendingKey(userId)) ?? "{}") as { adds?: unknown; removes?: unknown; order?: unknown };
    const keys = (value: unknown) => (Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : []);
    return { adds: cleanFavourites(raw.adds), removes: keys(raw.removes), order: Array.isArray(raw.order) ? keys(raw.order) : null };
  }, { adds: [], removes: [], order: null });
  const writePending = (userId: string, pending: Pending) => safe(() => {
    if (!pending.adds.length && !pending.removes.length && !pending.order) storage.remove(pendingKey(userId));
    else {
      storage.set(pendingKey(userId), JSON.stringify({
        adds: pending.adds.map(({ to, label, find }) => ({ to, label, find })), removes: pending.removes, order: pending.order,
      }));
    }
  }, undefined);
  const changePending = (userId: string, change: (pending: Pending) => void) => {
    const pending = readPending(userId);
    change(pending);
    writePending(userId, pending);
  };
  const notePending = (userId: string, step: { add?: Favourite; remove?: string }) => changePending(userId, (pending) => {
    if (step.add) {
      const key = step.add.key;
      pending.removes = pending.removes.filter((item) => item !== key);
      if (!pending.adds.some((fav) => fav.key === key)) pending.adds.push(step.add);
    }
    if (step.remove) {
      const key = step.remove;
      pending.adds = pending.adds.filter((fav) => fav.key !== key);
      if (!pending.removes.includes(key)) pending.removes.push(key);
    }
  });
  /** A step that is now saved: crossed off, so it is never replayed over a newer change. */
  const forget = (userId: string, key: string) => changePending(userId, (pending) => {
    pending.adds = pending.adds.filter((fav) => fav.key !== key);
    pending.removes = pending.removes.filter((item) => item !== key);
  });
  const rowOf = (userId: string, fav: Favourite, position: number): FavouriteRow =>
    ({ user_id: userId, panel, item_key: fav.key, label: fav.label, to_path: fav.to, find_text: fav.find, position });
  const mine = (userId: string) => state.userId === userId;

  /** Puts every saved row whose place differs from where it stands in that place. True when all were saved. */
  async function placeAll(userId: string, list: Favourite[]): Promise<boolean> {
    const moves = list.flatMap((fav, index) => (saved.has(fav.key) && saved.get(fav.key) !== index ? [{ key: fav.key, index }] : []));
    if (!moves.length) return true;
    const results = await Promise.all(moves.map((step) => db.place(userId, panel, step.key, step.index)));
    let ok = true;
    moves.forEach((step, i) => {
      if (results[i]!.error) ok = false;
      else saved.set(step.key, step.index);
    });
    return ok;
  }

  /** The order the person chose, where one is waiting: those keys first in that order, the rest after as they were. */
  const inOrder = (list: Favourite[], order: string[] | null) => {
    if (!order?.length) return list;
    const at = new Map(order.map((key, index) => [key, index]));
    return list.map((fav, index) => ({ fav, rank: at.get(fav.key) ?? order.length + index })).sort((a, b) => a.rank - b.rank).map((item) => item.fav);
  };

  // The menu, the star and the search all ask at once on a new page: one read serves them.
  let running: Promise<void> | null = null;
  function load(): Promise<void> {
    const read = readOnce().finally(() => {
      if (running === read) running = null;
    });
    running = read;
    return read;
  }

  /** Reads the signed-in person's favourites: the device's copy at once, then the database's answer. */
  async function readOnce(): Promise<void> {
    const ticket = ++generation;
    checked = true;
    lastTry = now();
    const userId = await deps.currentUser();
    if (ticket !== generation) return;
    if (!userId) {
      saved = new Map();
      publish({ list: [], userId: null, mode: "local" });
      return;
    }
    if (userId !== state.userId) {
      saved = new Map();
      publish({ list: readList(userId), userId, mode: "loading" });
    } else if (state.mode !== "synced") publish({ ...state, mode: "loading" });
    const { data, error } = await db.select(userId, panel);
    // Another load began, or the person changed, while the database answered: this answer is old.
    if (ticket !== generation || !mine(userId)) return;
    if (error) {
      publish({ ...state, mode: "local" });
      return;
    }
    const rows = Array.isArray(data) ? data : [];
    let list = cleanFavourites(rows);
    saved = new Map(rows.flatMap((row) => {
      const record = row as Record<string, unknown>;
      return typeof record["item_key"] === "string" ? [[record["item_key"], Number(record["position"]) || 0] as [string, number]] : [];
    }));
    if (safe(() => storage.get(syncedKey(userId)), null) !== "1") {
      // The first time this device finds the table: what it kept before the database update moves in, once, after
      // what is there already, in the device's order (a move made before then is in the pending order).
      const local = readList(userId);
      changePending(userId, (pending) => {
        for (const fav of local) {
          if (!list.some((item) => item.key === fav.key) && !pending.adds.some((item) => item.key === fav.key)) pending.adds.push(fav);
        }
      });
      safe(() => storage.set(syncedKey(userId), "1"), undefined);
    }
    // What was done here meanwhile goes on top of the answer.
    const pending = readPending(userId);
    const removes = new Set(pending.removes);
    list = list.filter((fav) => !removes.has(fav.key));
    for (const fav of pending.adds) if (!list.some((item) => item.key === fav.key) && list.length < MAX_FAVOURITES) list.push(fav);
    list = inOrder(list, pending.order);
    publish({ list, userId, mode: "synced" });
    writeList(userId, list);

    // Save it, crossing off each step once it is saved.
    for (const key of pending.removes) {
      if (!(await db.remove(userId, panel, key)).error) {
        saved.delete(key);
        forget(userId, key);
      }
    }
    if (!mine(userId)) return;
    // The additions, from the list as it is now (a star tapped meanwhile counts).
    let current = state.list;
    const adds = pending.adds.filter((fav) => current.some((item) => item.key === fav.key) && !saved.has(fav.key));
    if (adds.length) {
      const result = await db.add(adds.map((fav) => rowOf(userId, fav, current.findIndex((item) => item.key === fav.key))));
      if (!result.error) {
        adds.forEach((fav) => {
          saved.set(fav.key, current.findIndex((item) => item.key === fav.key));
          forget(userId, fav.key);
        });
        // Taken off again while this was being saved: off in the database too.
        if (!mine(userId)) return;
        for (const fav of adds) {
          if (!state.list.some((item) => item.key === fav.key) && !(await db.remove(userId, panel, fav.key)).error) saved.delete(fav.key);
        }
      }
    }
    if (!mine(userId)) return;
    current = state.list;
    if (await placeAll(userId, current)) changePending(userId, (left) => { left.order = null; });
    else changePending(userId, (left) => { left.order = current.map((fav) => fav.key); });
  }

  /** Loads when nothing was loaded yet, when another person is signed in now, or (once a minute) when there was no answer. */
  async function ensure(): Promise<void> {
    if (running) await running.catch(() => undefined);
    if (!checked) return load();
    const userId = await deps.currentUser();
    if (userId !== state.userId) return load();
    if (state.mode === "local" && now() - lastTry >= RETRY_MS) return load();
  }

  async function toggle(item: Omit<Favourite, "key">): Promise<ToggleResult> {
    const userId = state.userId;
    if (!userId) return "signed-out";
    const key = entryKey(item.to, item.find);
    const existing = state.list.find((fav) => fav.key === key) ?? null;
    if (!existing && state.list.length >= MAX_FAVOURITES) return "full";
    const was = state.list.findIndex((fav) => fav.key === key);
    const next = toggleFavourite(state.list, item);
    const added = next.find((fav) => fav.key === key) ?? null;
    publish({ ...state, list: next });
    writeList(userId, next);
    if (state.mode !== "synced") {
      // No answer from the database yet: kept here and saved on the next answer.
      notePending(userId, existing ? { remove: key } : { add: added! });
      return existing ? "removed" : "added";
    }
    if (existing) {
      const { error } = await db.remove(userId, panel, key);
      if (!mine(userId)) return error ? "failed" : "removed";
      if (error) {
        // Undo only this: back in its place, unless it came back meanwhile.
        if (!state.list.some((fav) => fav.key === key)) {
          const list = [...state.list];
          list.splice(Math.min(was, list.length), 0, existing);
          publish({ ...state, list });
          writeList(userId, list);
        }
        return "failed";
      }
      saved.delete(key);
      forget(userId, key);
      // The ones after it move up a place.
      if (!(await placeAll(userId, state.list)) && mine(userId)) changePending(userId, (pending) => { pending.order = state.list.map((fav) => fav.key); });
      return "removed";
    }
    const index = next.findIndex((fav) => fav.key === key);
    const { error } = await db.add([rowOf(userId, added!, index)]);
    if (!mine(userId)) return error ? "failed" : "added";
    if (error) {
      const list = state.list.filter((fav) => fav.key !== key);
      publish({ ...state, list });
      writeList(userId, list);
      return "failed";
    }
    saved.set(key, index);
    forget(userId, key);
    // Taken off again while it was being saved: off in the database too.
    if (!state.list.some((fav) => fav.key === key)) {
      if (!(await db.remove(userId, panel, key)).error) saved.delete(key);
      return "added";
    }
    await placeAll(userId, state.list);
    return "added";
  }

  async function move(key: string, step: -1 | 1): Promise<boolean> {
    const userId = state.userId;
    if (!userId) return false;
    const next = moveFavourite(state.list, key, step);
    if (next === state.list) return true;
    const other = next[next.findIndex((fav) => fav.key === key) - step]!.key;
    publish({ ...state, list: next });
    writeList(userId, next);
    if (state.mode !== "synced") {
      // No answer yet: the order waits and is saved with the next answer.
      changePending(userId, (pending) => { pending.order = next.map((fav) => fav.key); });
      return true;
    }
    if (await placeAll(userId, next)) {
      changePending(userId, (pending) => { pending.order = null; });
      return true;
    }
    if (!mine(userId)) return false;
    // Undo only this move, if the two are still side by side as it left them.
    const list = [...state.list];
    const at = list.findIndex((fav) => fav.key === key);
    if (at >= 0 && list[at - step]?.key === other) {
      [list[at], list[at - step]] = [list[at - step]!, list[at]!];
      publish({ ...state, list });
      writeList(userId, list);
    }
    // One of the two may have been saved: the order on screen waits to be saved with the next answer.
    changePending(userId, (pending) => { pending.order = state.list.map((fav) => fav.key); });
    return false;
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    load,
    ensure,
    toggle,
    move,
  };
}
export type FavouritesStore = ReturnType<typeof createFavouritesStore>;
