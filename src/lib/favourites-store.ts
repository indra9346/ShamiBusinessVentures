// Each person's favourite pages and buttons in one panel (owner, 11 Nov 2026), kept in the database
// (public.panel_favourites) and copied on the device so the menu draws at once. No app imports: the database and the
// device storage are handed in, so the tests run every case without a browser.
//
// The rules that keep it right:
// - A change is saved one row at a time (add one, remove one, move two), never the whole list, so a favourite removed
//   on another phone is not put back by a change here.
// - The copy on the device is only a copy. It goes into the database once: the first time this device finds the table
//   (favourites kept before the database update). After that an empty database means the person removed them.
// - A change made before the database answered, or while it could not be reached, is kept as pending and saved on the
//   next answer; the answer does not wipe it.
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
type Pending = { adds: Favourite[]; removes: string[] };

export function createFavouritesStore(panel: string, deps: { db: FavouritesDb; storage: FavouritesStorage; currentUser: () => Promise<string | null> }) {
  const { db, storage } = deps;
  let state: FavouritesState = { list: [], userId: null, mode: "loading" };
  let checked = false;
  let generation = 0;
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
    const raw = JSON.parse(storage.get(pendingKey(userId)) ?? "{}") as { adds?: unknown; removes?: unknown };
    return { adds: cleanFavourites(raw.adds), removes: Array.isArray(raw.removes) ? raw.removes.filter((key): key is string => typeof key === "string") : [] };
  }, { adds: [], removes: [] });
  const writePending = (userId: string, pending: Pending) => safe(() => {
    if (!pending.adds.length && !pending.removes.length) storage.remove(pendingKey(userId));
    else storage.set(pendingKey(userId), JSON.stringify({ adds: pending.adds.map(({ to, label, find }) => ({ to, label, find })), removes: pending.removes }));
  }, undefined);
  const notePending = (userId: string, change: { add?: Favourite; remove?: string }) => {
    const pending = readPending(userId);
    if (change.add) {
      const key = change.add.key;
      pending.removes = pending.removes.filter((item) => item !== key);
      if (!pending.adds.some((fav) => fav.key === key)) pending.adds.push(change.add);
    }
    if (change.remove) {
      const key = change.remove;
      pending.adds = pending.adds.filter((fav) => fav.key !== key);
      if (!pending.removes.includes(key)) pending.removes.push(key);
    }
    writePending(userId, pending);
  };
  const rowOf = (userId: string, fav: Favourite, position: number): FavouriteRow =>
    ({ user_id: userId, panel, item_key: fav.key, label: fav.label, to_path: fav.to, find_text: fav.find, position });

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
    const mine = ++generation;
    checked = true;
    const userId = await deps.currentUser();
    if (mine !== generation) return;
    if (!userId) {
      publish({ list: [], userId: null, mode: "local" });
      return;
    }
    if (userId !== state.userId) publish({ list: readList(userId), userId, mode: "loading" });
    else if (state.mode !== "synced") publish({ ...state, mode: "loading" });
    const { data, error } = await db.select(userId, panel);
    // Another load began, or the person changed, while the database answered: this answer is old.
    if (mine !== generation || state.userId !== userId) return;
    if (error) {
      publish({ ...state, mode: "local" });
      return;
    }
    let list = cleanFavourites(data);
    const pending = readPending(userId);
    if (safe(() => storage.get(syncedKey(userId)), null) !== "1") {
      // The first time this device finds the table: what it kept before the database update moves in, once.
      for (const fav of readList(userId)) {
        if (!list.some((item) => item.key === fav.key) && !pending.adds.some((item) => item.key === fav.key)) pending.adds.push(fav);
      }
    }
    // What was done here meanwhile goes on top of the answer.
    const removes = new Set(pending.removes);
    list = list.filter((fav) => !removes.has(fav.key));
    for (const fav of pending.adds) if (!list.some((item) => item.key === fav.key) && list.length < MAX_FAVOURITES) list.push(fav);
    publish({ list, userId, mode: "synced" });
    writeList(userId, list);
    // Save it: each removal, then the additions at their places.
    let ok = true;
    for (const key of pending.removes) ok = !(await db.remove(userId, panel, key)).error && ok;
    const adds = list.flatMap((fav, position) => (pending.adds.some((item) => item.key === fav.key) ? [rowOf(userId, fav, position)] : []));
    if (adds.length) ok = !(await db.add(adds)).error && ok;
    if (ok) {
      writePending(userId, { adds: [], removes: [] });
      safe(() => storage.set(syncedKey(userId), "1"), undefined);
    } else {
      writePending(userId, { adds: pending.adds.filter((fav) => list.some((item) => item.key === fav.key)), removes: pending.removes });
    }
  }

  /** Loads when nothing was loaded yet, or when the person signed in now is not the one whose list this is. */
  async function ensure(): Promise<void> {
    if (running) await running.catch(() => undefined);
    if (!checked) return load();
    const userId = await deps.currentUser();
    if (userId !== state.userId) return load();
  }

  async function toggle(item: Omit<Favourite, "key">): Promise<ToggleResult> {
    const userId = state.userId;
    if (!userId) return "signed-out";
    const key = entryKey(item.to, item.find);
    const existing = state.list.find((fav) => fav.key === key) ?? null;
    if (!existing && state.list.length >= MAX_FAVOURITES) return "full";
    const before = state;
    const next = toggleFavourite(state.list, item);
    const added = next.find((fav) => fav.key === key) ?? null;
    publish({ ...state, list: next });
    writeList(userId, next);
    if (state.mode !== "synced") {
      // No answer from the database yet: kept here and saved on the next answer.
      notePending(userId, existing ? { remove: key } : { add: added! });
      return existing ? "removed" : "added";
    }
    const { error } = existing ? await db.remove(userId, panel, key) : await db.add([rowOf(userId, added!, next.length - 1)]);
    if (error) {
      if (state.userId === userId) {
        publish(before);
        writeList(userId, before.list);
      }
      return "failed";
    }
    return existing ? "removed" : "added";
  }

  async function move(key: string, step: -1 | 1): Promise<boolean> {
    const userId = state.userId;
    if (!userId) return false;
    const before = state;
    const next = moveFavourite(state.list, key, step);
    if (next === state.list) return true;
    publish({ ...state, list: next });
    writeList(userId, next);
    if (state.mode !== "synced") return true;
    // Only the two that changed places.
    const at = next.findIndex((fav) => fav.key === key);
    const other = next[at - step]!;
    const results = await Promise.all([db.place(userId, panel, key, at), db.place(userId, panel, other.key, at - step)]);
    if (results.some((result) => result.error)) {
      if (state.userId === userId) {
        publish(before);
        writeList(userId, before.list);
      }
      return false;
    }
    return true;
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
