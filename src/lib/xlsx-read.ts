/*
 * Reads the first sheet of an Excel .xlsx file in the browser, as rows of text, for the bank statement upload. An .xlsx is
 * a zip of XML files: the zip's directory is read here, each needed file is inflated with the browser's own
 * DecompressionStream, and the XML is read with DOMParser. No library is needed. An old .xls (not a zip) is refused with
 * a message saying to save it as .xlsx or CSV.
 */

const textDecoder = new TextDecoder();

type ZipEntry = { name: string; method: number; size: number; offset: number };

function zipEntries(view: DataView): ZipEntry[] {
  let end = -1;
  for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 66_000); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error("This is not an .xlsx file. Open it in Excel and save it as .xlsx or CSV, or download the statement as CSV.");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) break;
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = textDecoder.decode(new Uint8Array(view.buffer, view.byteOffset + at + 46, nameLength));
    entries.push({ name, method, size, offset });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function entryText(view: DataView, entry: ZipEntry) {
  const local = entry.offset;
  const nameLength = view.getUint16(local + 26, true);
  const extraLength = view.getUint16(local + 28, true);
  const start = local + 30 + nameLength + extraLength;
  const bytes = new Uint8Array(view.buffer, view.byteOffset + start, entry.size);
  if (entry.method === 0) return textDecoder.decode(bytes);
  if (entry.method !== 8) throw new Error("This .xlsx uses a packing the browser cannot read. Save it as CSV.");
  // A copy into its own ArrayBuffer: Blob wants an ArrayBuffer view, not a view of a possibly shared buffer.
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return await new Response(stream).text();
}

const columnIndex = (ref: string) => {
  const letters = ref.replace(/\d+$/, "");
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

export async function readXlsxRows(buffer: ArrayBuffer): Promise<string[][]> {
  const view = new DataView(buffer);
  const entries = zipEntries(view);
  const parser = new DOMParser();
  const shared: string[] = [];
  const sharedEntry = entries.find((e) => e.name === "xl/sharedStrings.xml");
  if (sharedEntry) {
    const doc = parser.parseFromString(await entryText(view, sharedEntry), "application/xml");
    for (const si of Array.from(doc.getElementsByTagName("si"))) {
      shared.push(Array.from(si.getElementsByTagName("t")).map((t) => t.textContent ?? "").join(""));
    }
  }
  const sheet = entries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))[0];
  if (!sheet) throw new Error("The .xlsx file has no sheet in it.");
  const doc = parser.parseFromString(await entryText(view, sheet), "application/xml");
  const rows: string[][] = [];
  for (const rowEl of Array.from(doc.getElementsByTagName("row"))) {
    const row: string[] = [];
    for (const c of Array.from(rowEl.getElementsByTagName("c"))) {
      const ref = c.getAttribute("r") ?? "";
      const type = c.getAttribute("t");
      const v = c.getElementsByTagName("v")[0]?.textContent ?? "";
      const value = type === "s" ? shared[Number(v)] ?? ""
        : type === "inlineStr" ? Array.from(c.getElementsByTagName("t")).map((t) => t.textContent ?? "").join("")
        : v;
      const index = ref ? columnIndex(ref) : row.length;
      while (row.length < index) row.push("");
      row[index] = value.trim();
    }
    if (row.some((cell) => cell !== "")) rows.push(row);
  }
  return rows;
}
