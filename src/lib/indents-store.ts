import { supabase } from "@/integrations/supabase/client";
import { STATIC_DATA_MODE } from "@/lib/demo-mode";
import { indentLinesPayload, type Indent, type IndentLineDraft, type IndentStatus, type IndentUnit } from "@/lib/indents";

/*
 * Stock requirements (public.stock_indents, lines and history). An admin reads every request; a channel partner reads
 * their godown's (row rules). Changes go only through the database functions, which check who may do what:
 * partner_raise_stock_indent, partner_cancel_stock_indent and admin_set_stock_indent_status. The demo keeps them in
 * this browser.
 */

const DEMO_KEY = "gb-demo-stock-indents";
const readDemo = (): Indent[] => {
  try { return JSON.parse(localStorage.getItem(DEMO_KEY) ?? "[]") as Indent[]; } catch { return []; }
};
const writeDemo = (rows: Indent[]) => {
  try { localStorage.setItem(DEMO_KEY, JSON.stringify(rows)); } catch { /* private window: the demo just forgets */ }
};

/** Every request the signed-in person may see, newest first, with lines and history. */
export async function loadIndents(): Promise<Indent[]> {
  if (STATIC_DATA_MODE) return readDemo();
  const { data: heads, error } = await supabase.from("stock_indents").select("*").order("created_at", { ascending: false }).limit(1000);
  if (error) throw new Error(error.message);
  const rows = heads ?? [];
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const branchIds = [...new Set(rows.map((row) => row.branch_id))];
  const [lines, events, branches] = await Promise.all([
    supabase.from("stock_indent_lines").select("*").in("indent_id", ids).order("line_no"),
    supabase.from("stock_indent_events").select("*").in("indent_id", ids).order("id"),
    supabase.from("branches").select("id,name").in("id", branchIds),
  ]);
  if (lines.error) throw new Error(lines.error.message);
  const godown = new Map((branches.data ?? []).map((branch) => [branch.id, branch.name]));
  return rows.map((row) => ({
    id: row.id,
    indentNo: row.indent_no,
    branchId: row.branch_id,
    godown: godown.get(row.branch_id) ?? row.branch_id,
    partnerName: row.partner_name,
    neededBy: row.needed_by,
    notes: row.notes,
    status: row.status as IndentStatus,
    statusNote: row.status_note,
    statusChangedAt: row.status_changed_at,
    statusChangedByName: row.status_changed_by_name,
    createdAt: row.created_at,
    lines: (lines.data ?? []).filter((line) => line.indent_id === row.id).map((line) => ({
      lineNo: line.line_no, productId: line.product_id, productName: line.product_name, quantity: Number(line.quantity),
      unit: line.unit as IndentUnit, grade: line.grade, remarks: line.remarks,
    })),
    events: (events.data ?? []).filter((event) => event.indent_id === row.id).map((event) => ({
      event: event.event, note: event.note, byName: event.by_name, byRole: event.by_role, at: event.at,
    })),
  }));
}

/** The partner sends a request; returns its number. */
export async function raiseIndent(lines: IndentLineDraft[], notes: string, neededBy: string, demo?: { branchId: string; godown: string; partnerName: string }) {
  const payload = indentLinesPayload(lines);
  if (STATIC_DATA_MODE) {
    const rows = readDemo();
    const now = new Date().toISOString();
    const indentNo = `IND-DEMO-${String(rows.length + 1).padStart(4, "0")}`;
    writeDemo([{
      id: crypto.randomUUID(), indentNo, branchId: demo?.branchId ?? "BR-CLK", godown: demo?.godown ?? "Godown", partnerName: demo?.partnerName ?? "Partner",
      neededBy: neededBy || null, notes: notes.trim(), status: "new", statusNote: "", statusChangedAt: null, statusChangedByName: "", createdAt: now,
      lines: payload.map((line, index) => ({ lineNo: index + 1, productId: line.product_id, productName: line.product_name, quantity: line.quantity, unit: line.unit, grade: line.grade, remarks: line.remarks })),
      events: [{ event: "raised", note: "", byName: demo?.partnerName ?? "Partner", byRole: "partner", at: now }],
    }, ...rows]);
    return indentNo;
  }
  const { data, error } = await supabase.rpc("partner_raise_stock_indent", { _lines: payload, _notes: notes.trim(), _needed_by: neededBy || null });
  if (error) throw new Error(error.message);
  return String(data);
}

const demoChange = (indentNo: string, status: IndentStatus, note: string, byName: string, byRole: "partner" | "admin") => {
  const now = new Date().toISOString();
  writeDemo(readDemo().map((row) => (row.indentNo === indentNo
    ? { ...row, status, statusNote: note, statusChangedAt: now, statusChangedByName: byName, events: [...row.events, { event: status, note, byName, byRole, at: now }] }
    : row)));
};

/** The partner cancels their request while it is New. */
export async function cancelIndent(indentNo: string, reason: string) {
  if (STATIC_DATA_MODE) { demoChange(indentNo, "cancelled", reason.trim(), "Partner", "partner"); return; }
  const { error } = await supabase.rpc("partner_cancel_stock_indent", { _indent_no: indentNo, _reason: reason.trim() });
  if (error) throw new Error(error.message);
}

/** Head office sets the status, with a note the partner sees. */
export async function setIndentStatus(indentNo: string, status: IndentStatus, note: string) {
  if (STATIC_DATA_MODE) { demoChange(indentNo, status, note.trim(), "Head office", "admin"); return; }
  const { error } = await supabase.rpc("admin_set_stock_indent_status", { _indent_no: indentNo, _status: status, _note: note.trim() });
  if (error) throw new Error(error.message);
}

/** Product names a partner can pick from (they may also type one that is not on the website). */
export async function loadIndentProducts(): Promise<{ id: string; name: string }[]> {
  if (STATIC_DATA_MODE) return [];
  const { data } = await supabase.from("catalog_products").select("id,payload,active").eq("active", true).limit(500);
  const seen = new Set<string>();
  return (data ?? [])
    .map((row) => ({ id: row.id, name: String((row.payload as Record<string, unknown> | null)?.["name"] ?? "").trim() }))
    .filter((row) => row.name && !row.id.startsWith("zoho:") && !seen.has(row.name.toLowerCase()) && seen.add(row.name.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
}
