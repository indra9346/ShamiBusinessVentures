import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import {
  RICE_WORKBOOK, activeCodeOptions, activePartsOfSet, buildCode, codeDetailsProblem, codePartProblem, codeSetProblem, codesOfPair, defaultCodeName,
  demoCreateCode, demoCreatePart, demoCreateSet, demoSetCodeRetired, demoSetPartRetired, demoUpdateCode, demoUpdatePart, duplicateProducts, duplicatesToConfirm, emptyCodeMaster,
  findMasterCode, isCodeLetter, isCodePrefix, letterLocked, newCodePreview, nextSerial, normalizeCodeInput, normalizeLetter, packKey, packLabel, productsWithCode,
  productsWithoutCode, riceWorkbookMaster, serialText, setForCategory, type CodeMaster,
} from "../src/lib/product-code-rules.ts";

/* ---------- the client's workbook, read from the file itself ---------- */

type Cell = { value: string; formula?: string };

/** Every cell of every sheet of an xlsx, by sheet name then cell name, with no library. */
function readWorkbook(path: URL): Record<string, Record<string, Cell>> {
  const buf = readFileSync(path);
  const parts: Record<string, string> = {};
  let end = buf.length - 22;
  while (buf.readUInt32LE(end) !== 0x06054b50) end -= 1;
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i += 1) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLength);
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const data = buf.subarray(start, start + size);
    parts[name] = method === 8 ? inflateRawSync(data).toString("utf8") : data.toString("utf8");
    p += 46 + nameLength + extraLength + commentLength;
  }
  const decode = (text: string) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const shared = [...parts["xl/sharedStrings.xml"]!.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((si) =>
    decode([...si[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
  const names = [...parts["xl/workbook.xml"]!.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]!);
  const sheets: Record<string, Record<string, Cell>> = {};
  names.forEach((name, index) => {
    const cells: Record<string, Cell> = {};
    for (const c of parts[`xl/worksheets/sheet${index + 1}.xml`]!.matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const body = c[3] ?? "";
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      const formula = /<f[^>]*>([\s\S]*?)<\/f>/.exec(body)?.[1];
      if (raw === undefined && !formula) continue;
      const value = /t="s"/.test(c[2]!) ? shared[Number(raw)]! : decode(raw ?? "");
      cells[c[1]!] = { value, ...(formula ? { formula: decode(formula) } : {}) };
    }
    sheets[name] = cells;
  });
  return sheets;
}

const workbook = readWorkbook(new URL("./fixtures/Rice_Product_Codes.xlsx", import.meta.url));
const cell = (sheet: string, name: string) => workbook[sheet]?.[name]?.value;
const master = riceWorkbookMaster();
const migration = readFileSync(new URL("../supabase/migrations/20261102190000_product_code_master.sql", import.meta.url), "utf8").replace(/\r\n/g, "\n");

const legendMethods = [5, 6, 7, 8, 9].map((row) => ({ letter: cell("Legend", `B${row}`), name: cell("Legend", `A${row}`) }));
const legendVarieties = [5, 6, 7, 8, 9, 10].map((row) => ({ letter: cell("Legend", `E${row}`), name: cell("Legend", `D${row}`) }));

test("the workbook has exactly the 3 sheets this test reads", () => {
  assert.deepEqual(Object.keys(workbook), ["Code Matrix", "Code List", "Legend"]);
  assert.equal(cell("Legend", "A4"), "Method (1st letter)");
  assert.equal(cell("Legend", "D4"), "Variety (2nd letter)");
  // Nothing past these rows: a new method or variety in the file must fail this test.
  assert.equal(cell("Legend", "B10"), undefined);
  assert.equal(cell("Legend", "E11"), undefined);
  assert.equal(cell("Legend", "G5"), "01");
  assert.equal(cell("Legend", "G6"), undefined);
});

test("Legend sheet: methods and varieties match the seed, letters and order", () => {
  assert.deepEqual(legendMethods, RICE_WORKBOOK.methods.map((part) => ({ ...part })));
  assert.deepEqual(legendVarieties, RICE_WORKBOOK.varieties.map((part) => ({ ...part })));
  assert.equal(RICE_WORKBOOK.category, "Rice");
});

test("Code List sheet: all 30 rows match the seed, in order", () => {
  assert.equal(cell("Code List", "B1"), "Product Code");
  assert.equal(cell("Code List", "E1"), "Description");
  assert.equal(cell("Code List", "A32"), undefined, "no 31st row");
  assert.equal(master.codes.length, 30);
  master.codes.forEach((code, index) => {
    const row = index + 2;
    const method = master.methods.find((part) => part.id === code.methodId)!;
    const variety = master.varieties.find((part) => part.id === code.varietyId)!;
    assert.equal(cell("Code List", `A${row}`), String(index + 1));
    assert.equal(cell("Code List", `B${row}`), code.code);
    assert.equal(cell("Code List", `C${row}`), method.name);
    assert.equal(cell("Code List", `D${row}`), variety.name);
    // The workbook's Description column is the code's name.
    assert.equal(cell("Code List", `E${row}`), code.name);
    assert.equal(code.subcategory, method.name);
    assert.equal(code.serial, 1);
    assert.equal(code.description, "");
    assert.deepEqual(code.images, []);
    assert.equal(code.retiredAt, null);
  });
  assert.equal(new Set(master.codes.map((code) => code.code)).size, 30);
  assert.equal(master.codes[0]!.code, "RS01");
  assert.equal(master.codes[29]!.code, "NM01");
});

test("Code Matrix sheet: every cell matches the seed", () => {
  const columns = ["B", "C", "D", "E", "F"];
  assert.deepEqual(columns.map((column) => cell("Code Matrix", `${column}3`)), RICE_WORKBOOK.methods.map((method) => method.name));
  assert.equal(cell("Code Matrix", "G3"), undefined);
  assert.equal(cell("Code Matrix", "A10"), undefined);
  RICE_WORKBOOK.varieties.forEach((variety, v) => {
    const row = v + 4;
    assert.equal(cell("Code Matrix", `A${row}`), variety.name);
    RICE_WORKBOOK.methods.forEach((method, m) => {
      const value = cell("Code Matrix", `${columns[m]}${row}`);
      assert.equal(value, `${method.letter}${variety.letter}01`);
      assert.ok(master.codes.some((code) => code.code === value), `${value} is in the seed`);
    });
  });
});

test("the workbook's formulas build each code from the Legend's letters", () => {
  // A cached value could be stale: the formula says RS01 is B5 & E5 & G5, and so on down the list.
  master.codes.forEach((code, index) => {
    const m = Math.floor(index / 6);
    const v = index % 6;
    assert.equal(workbook["Code List"]![`B${index + 2}`]!.formula, `Legend!$B$${m + 5}&Legend!$E$${v + 5}&Legend!$G$5`, code.code);
  });
});

test("the migration seeds exactly the workbook, only rice, and links no product", () => {
  const values = (table: string) => {
    const block = new RegExp(`INSERT INTO public\\.${table} \\(set_id, letter, name, sort_order\\) VALUES\\n([\\s\\S]*?);`).exec(migration)?.[1];
    assert.ok(block, `${table} seed found`);
    return [...block.matchAll(/\(rice, '([A-Z])', '([^']+)', (\d+)\)/g)].map((row) => ({ letter: row[1], name: row[2], sort: Number(row[3]) }));
  };
  const expected = (list: { letter?: string | undefined; name?: string | undefined }[]) => list.map((part, index) => ({ letter: part.letter, name: part.name, sort: index + 1 }));
  assert.deepEqual(values("product_code_methods"), expected(legendMethods));
  assert.deepEqual(values("product_code_varieties"), expected(legendVarieties));
  const sets = [...migration.matchAll(/INSERT INTO public\.product_code_sets \(category\) VALUES \('([^']+)'\)/g)].map((row) => row[1]);
  assert.deepEqual(sets, ["Rice"]);
  // Applying the migration changes no product. The one update is the function an admin calls later.
  const whenApplied = migration.replace(/CREATE OR REPLACE FUNCTION public\.admin_set_product_code[\s\S]*?END \$\$;/, "");
  assert.notEqual(whenApplied, migration);
  assert.doesNotMatch(whenApplied, /UPDATE public\.catalog_products|INSERT INTO public\.catalog_products|DELETE FROM public\.catalog_products/);
  for (const other of ["Sugar", "Oil"]) assert.doesNotMatch(migration, new RegExp(`\\('${other}'\\)`));
});

/* ---------- reading what is typed ---------- */

test("what an admin types reads as a code", () => {
  assert.equal(normalizeCodeInput(" rs 01 "), "RS01");
  assert.equal(normalizeCodeInput("r-s-01"), "RS01");
  assert.equal(normalizeCodeInput(""), "");
  assert.equal(normalizeLetter(" s "), "S");
  assert.ok(isCodeLetter("S"));
  assert.ok(!isCodeLetter("SS"));
  assert.ok(!isCodeLetter("1"));
  assert.ok(!isCodeLetter(""));
  assert.ok(isCodePrefix(""));
  assert.ok(isCodePrefix("URS"));
  assert.ok(!isCodePrefix("URSA"));
  assert.ok(!isCodePrefix("U1"));
  assert.equal(serialText(1), "01");
  assert.equal(serialText(12), "12");
  assert.equal(buildCode("", "R", "S", 1), "RS01");
  assert.equal(buildCode("U", "R", "S", 2), "URS02");
  assert.equal(defaultCodeName("Raw Rice", "Sona Rice", 1), "Raw Rice - Sona Rice");
  assert.equal(defaultCodeName("Raw Rice", "Sona Rice", 2), "Raw Rice - Sona Rice 02");
  assert.equal(findMasterCode(master, "rs01")?.name, "Raw Rice - Sona Rice");
  assert.equal(findMasterCode(master, "RS99"), undefined);
  assert.equal(findMasterCode(master, "  "), undefined);
  assert.equal(setForCategory(master, " rice ")?.category, "Rice");
  assert.equal(setForCategory(master, "Sugar"), undefined);
});

/* ---------- letters ---------- */

const RICE = "set-rice";
const retiredAt = "2026-11-02T10:00:00.000Z";

test("Sona S and Steam S are different positions and both valid", () => {
  assert.equal(master.methods.find((part) => part.letter === "S")?.name, "Steam Rice");
  assert.equal(master.varieties.find((part) => part.letter === "S")?.name, "Sona Rice");
  // A letter free in one list is fine even if the other list uses it.
  assert.equal(codePartProblem(master, "method", RICE, { letter: "K", name: "Parboiled" }), null);
  assert.equal(codePartProblem(master, "variety", RICE, { letter: "R", name: "Ratna" }), null);
});

test("a letter is unique in its own list, and a retired one stays reserved", () => {
  assert.match(codePartProblem(master, "method", RICE, { letter: "s", name: "Sun Dried" })!, /Letter S is already used by Steam Rice/);
  assert.match(codePartProblem(master, "variety", RICE, { letter: "S", name: "Samba" })!, /Letter S is already used by Sona Rice/);
  assert.match(codePartProblem(master, "method", RICE, { letter: "12", name: "X" })!, /one letter/);
  assert.match(codePartProblem(master, "method", RICE, { letter: "K", name: "  " })!, /Enter the method name/);
  assert.match(codePartProblem(master, "method", RICE, { letter: "K", name: " raw  rice " })!, /already exists/);
  const retired = demoSetPartRetired(master, "variety", "variety-K", true, retiredAt);
  assert.match(codePartProblem(retired, "variety", RICE, { letter: "K", name: "Kaveri New" })!, /belonged to Kaveri Rice \(retired\).*reserved/);
});

test("a letter locks once a code uses it, and can be fixed before", () => {
  assert.ok(letterLocked(master, "method", "method-R"));
  assert.match(codePartProblem(master, "method", RICE, { letter: "A", name: "Raw Rice" }, "method-R")!, /Letter R is locked/);
  // The name can still be corrected, and keeping the letter is no change.
  assert.equal(codePartProblem(master, "method", RICE, { letter: "R", name: "Raw" }, "method-R"), null);
  const added = demoCreatePart(master, "variety", RICE, { letter: "a", name: " Jeera   Samba " });
  const part = added.varieties.at(-1)!;
  assert.deepEqual([part.letter, part.name, part.sortOrder], ["A", "Jeera Samba", 7]);
  assert.ok(!letterLocked(added, "variety", part.id));
  assert.equal(codePartProblem(added, "variety", RICE, { letter: "B", name: "Jeera Samba" }, part.id), null);
  const fixed = demoUpdatePart(added, "variety", part.id, { letter: "B", name: "Jeera Samba" });
  assert.equal(fixed.varieties.at(-1)!.letter, "B");
  assert.throws(() => demoUpdatePart(master, "method", "method-R", { letter: "A", name: "Raw Rice" }), /locked/);
});

test("changing a letter: retire it, then a new one can take the same name under another letter", () => {
  const retired = demoSetPartRetired(master, "method", "method-R", true, retiredAt);
  assert.equal(codePartProblem(retired, "method", RICE, { letter: "W", name: "Raw Rice" }), null);
  const replaced = demoCreatePart(retired, "method", RICE, { letter: "W", name: "Raw Rice" });
  assert.equal(activePartsOfSet(replaced, "method", RICE).find((part) => part.letter === "W")!.name, "Raw Rice");
  // Both can't be live under one name, and the old letter stays reserved.
  assert.throws(() => demoSetPartRetired(replaced, "method", "method-R", false, retiredAt), /already called Raw Rice/);
  assert.match(codePartProblem(replaced, "method", RICE, { letter: "R", name: "Rolled" })!, /belonged to Raw Rice \(retired\)/);
});

test("a retired method or variety keeps its name until restored", () => {
  const retired = demoSetPartRetired(master, "method", "method-R", true, retiredAt);
  assert.match(codePartProblem(retired, "method", RICE, { letter: "R", name: "Sun Dried" }, "method-R")!, /retired. Restore it before changing its name/);
  assert.match(codePartProblem(retired, "method", RICE, { letter: "Y", name: "Raw Rice" }, "method-R")!, /stays reserved/);
  assert.equal(codePartProblem(retired, "method", RICE, { letter: "R", name: "Raw Rice" }, "method-R"), null);
});

/* ---------- new codes ---------- */

test("the next serial moves forward and counts retired codes", () => {
  assert.equal(nextSerial(master, "method-R", "variety-S"), 2);
  const made = demoCreateCode(master, "method-R", "variety-S");
  assert.deepEqual([made.code.code, made.code.serial, made.code.name, made.code.subcategory], ["RS02", 2, "Raw Rice - Sona Rice 02", "Raw Rice"]);
  assert.equal(nextSerial(made.master, "method-R", "variety-S"), 3);
  const retired = demoSetCodeRetired(made.master, made.code.id, true, retiredAt);
  assert.equal(nextSerial(retired, "method-R", "variety-S"), 3, "RS02 is never used again");
  const next = demoCreateCode(retired, "method-R", "variety-S");
  assert.equal(next.code.code, "RS03");
  assert.deepEqual(codesOfPair(next.master, "method-R", "variety-S").map((code) => code.code), ["RS01", "RS02", "RS03"]);
});

test("a new code's preview refuses a retired part and shows the code", () => {
  assert.deepEqual(newCodePreview(master, "method-R", "variety-S"), { code: "RS02", serial: 2, name: "Raw Rice - Sona Rice 02", subcategory: "Raw Rice" });
  const retired = demoSetPartRetired(master, "method", "method-R", true, retiredAt);
  assert.match((newCodePreview(retired, "method-R", "variety-S") as { error: string }).error, /retired/);
  assert.match((newCodePreview(master, "nope", "variety-S") as { error: string }).error, /same category/);
  assert.throws(() => demoCreateCode(retired, "method-R", "variety-S"), /retired/);
});

const withSugar = (prefix: string) => {
  let next = demoCreateSet(master, { category: "Sugar", prefix, firstLabel: "Grade", secondLabel: "Mill" });
  const id = setForCategory(next, "Sugar")!.id;
  next = demoCreatePart(next, "method", id, { letter: "R", name: "Refined" });
  next = demoCreatePart(next, "variety", id, { letter: "S", name: "S-30" });
  return { next, id, method: next.methods.at(-1)!.id, variety: next.varieties.at(-1)!.id };
};

test("codes are unique across categories; a prefix keeps sets apart", () => {
  const plain = withSugar("");
  const clash = newCodePreview(plain.next, plain.method, plain.variety) as { error: string };
  assert.match(clash.error, /RS01 is already used in Rice.*prefix/);
  assert.throws(() => demoCreateCode(plain.next, plain.method, plain.variety), /already used in Rice/);
  const prefixed = withSugar("U");
  const made = demoCreateCode(prefixed.next, prefixed.method, prefixed.variety);
  assert.equal(made.code.code, "URS01");
  assert.equal(findMasterCode(made.master, "urs01")?.setId, prefixed.id);
  assert.equal(activeCodeOptions(made.master, "Sugar").length, 1);
  assert.equal(activeCodeOptions(made.master, "Rice").length, 30);
  assert.equal(activeCodeOptions(made.master).length, 31);
});

test("a set needs its own category and prefix; the prefix locks once it has codes", () => {
  assert.match(codeSetProblem(master, { category: " rice ", prefix: "", firstLabel: "Method", secondLabel: "Variety" })!, /already has a code set/);
  assert.match(codeSetProblem(master, { category: "", prefix: "", firstLabel: "Method", secondLabel: "Variety" })!, /Choose a category/);
  assert.match(codeSetProblem(master, { category: "Sugar", prefix: "U1", firstLabel: "Method", secondLabel: "Variety" })!, /up to 3 letters/);
  assert.match(codeSetProblem(master, { category: "Sugar", prefix: "", firstLabel: " ", secondLabel: "Variety" })!, /Name both/);
  assert.equal(codeSetProblem(master, { category: "Sugar", prefix: "u", firstLabel: "Grade", secondLabel: "Mill" }), null);
  assert.match(codeSetProblem(master, { category: "Rice", prefix: "X", firstLabel: "Method", secondLabel: "Variety" }, RICE)!, /prefix can no longer change/);
  const sugar = withSugar("U");
  assert.match(codeSetProblem(sugar.next, { category: "Oil", prefix: "U", firstLabel: "Type", secondLabel: "Brand" })!, /Prefix U is already used by Sugar/);
  assert.equal(codeSetProblem(sugar.next, { category: "Sugar", prefix: "V", firstLabel: "Grade", secondLabel: "Mill" }, sugar.id), null, "no codes yet");
});

/* ---------- active list ---------- */

test("active options keep the workbook's order and leave out retired codes", () => {
  const options = activeCodeOptions(master, "Rice");
  assert.equal(options.length, 30);
  assert.deepEqual(options.slice(0, 7).map((option) => option.code), ["RS01", "RK01", "RN01", "RH01", "RJ01", "RM01", "SS01"]);
  assert.deepEqual(options[0], {
    code: "RS01", name: "Raw Rice - Sona Rice", description: "", category: "Rice", subcategory: "Raw Rice",
    methodName: "Raw Rice", methodLetter: "R", varietyName: "Sona Rice", varietyLetter: "S", serial: 1, images: [],
  });
  assert.equal(activeCodeOptions(master, "Sugar").length, 0);
  assert.equal(activeCodeOptions(emptyCodeMaster()).length, 0);
  const made = demoCreateCode(master, "method-R", "variety-S");
  assert.deepEqual(activeCodeOptions(made.master, "Rice").slice(0, 3).map((option) => option.code), ["RS01", "RS02", "RK01"]);
  const retired = demoSetCodeRetired(master, "code-RK01", true, retiredAt);
  assert.ok(!activeCodeOptions(retired, "Rice").some((option) => option.code === "RK01"));
  assert.equal(activeCodeOptions(retired, "Rice").length, 29);
});

/* ---------- retiring and restoring, as the database does ---------- */

const statusOf = (list: CodeMaster, code: string) => (list.codes.find((row) => row.code === code)!.retiredAt ? "retired" : "active");

test("retiring a method retires its codes; restoring brings back only those", () => {
  // RK01 was retired on its own earlier, so bringing the method back must not revive it.
  const earlier = demoSetCodeRetired(master, "code-RK01", true, "2026-11-01T10:00:00.000Z");
  const gone = demoSetPartRetired(earlier, "method", "method-R", true, retiredAt);
  assert.equal(activePartsOfSet(gone, "method", RICE).length, 4);
  for (const code of ["RS01", "RK01", "RM01"]) assert.equal(statusOf(gone, code), "retired");
  assert.equal(statusOf(gone, "SS01"), "active");
  assert.equal(gone.codes.find((row) => row.code === "RK01")!.retiredAt, "2026-11-01T10:00:00.000Z");
  const back = demoSetPartRetired(gone, "method", "method-R", false, retiredAt);
  assert.equal(statusOf(back, "RS01"), "active");
  assert.equal(statusOf(back, "RM01"), "active");
  assert.equal(statusOf(back, "RK01"), "retired");
});

test("a code stays retired while its other part is retired", () => {
  const method = demoSetPartRetired(master, "method", "method-R", true, "2026-11-02T10:00:00.000Z");
  const both = demoSetPartRetired(method, "variety", "variety-S", true, "2026-11-02T11:00:00.000Z");
  assert.equal(both.codes.find((row) => row.code === "RS01")!.retiredAt, "2026-11-02T10:00:00.000Z");
  assert.equal(statusOf(both, "SS01"), "retired");
  // Restoring the variety: SS01 comes back, RS01 waits for its method.
  const variety = demoSetPartRetired(both, "variety", "variety-S", false, "x");
  assert.equal(statusOf(variety, "SS01"), "active");
  assert.equal(statusOf(variety, "RS01"), "retired");
  assert.throws(() => demoSetCodeRetired(variety, "code-RS01", false, "x"), /Restore the method and variety of RS01 first/);
});

test("a retired code's details stay fixed until it is restored", () => {
  const details = { name: "Sona Raw Premium", description: "Long grain", subcategory: "Raw Rice", images: ["https://x/a.jpg"] };
  const updated = demoUpdateCode(master, "code-RS01", details);
  assert.deepEqual(updated.codes.find((row) => row.code === "RS01")!.images, details.images);
  assert.equal(updated.codes.find((row) => row.code === "RS01")!.code, "RS01");
  const retired = demoSetCodeRetired(updated, "code-RS01", true, retiredAt);
  assert.throws(() => demoUpdateCode(retired, "code-RS01", { ...details, name: "Other" }), /retired. Restore it/);
  const restored = demoSetCodeRetired(retired, "code-RS01", false, retiredAt);
  assert.equal(demoUpdateCode(restored, "code-RS01", { ...details, name: "Other" }).codes.find((row) => row.code === "RS01")!.name, "Other");
  assert.match(codeDetailsProblem(undefined, { ...details, name: " " })!, /product name/);
  assert.match(codeDetailsProblem(undefined, { ...details, subcategory: " " })!, /subcategory/);
  assert.match(codeDetailsProblem(undefined, { ...details, images: Array(9).fill("x") })!, /up to 8/);
  assert.equal(codeDetailsProblem(undefined, details), null);
});

test("restoring in either order brings a code back once both parts are live", () => {
  const live = (m: CodeMaster, code: string) => !m.codes.find((row) => row.code === code)!.retiredAt;
  const both = demoSetPartRetired(demoSetPartRetired(master, "method", "method-R", true, "2026-11-02T10:00:00.000Z"), "variety", "variety-S", true, "2026-11-02T11:00:00.000Z");
  const methodBack = demoSetPartRetired(both, "method", "method-R", false, "x");
  assert.equal(live(methodBack, "RS01"), false);
  assert.equal(live(methodBack, "RK01"), true);
  assert.equal(live(demoSetPartRetired(methodBack, "variety", "variety-S", false, "x"), "RS01"), true);
  const varietyBack = demoSetPartRetired(both, "variety", "variety-S", false, "x");
  assert.equal(live(varietyBack, "RS01"), false);
  assert.equal(live(demoSetPartRetired(varietyBack, "method", "method-R", false, "x"), "RS01"), true);
});

test("retiring what is already retired changes nothing, so a restore still works", () => {
  const once = demoSetPartRetired(master, "method", "method-R", true, "2026-11-02T10:00:00.000Z");
  const twice = demoSetPartRetired(once, "method", "method-R", true, "2026-11-02T12:00:00.000Z");
  assert.equal(twice, once);
  assert.equal(demoSetCodeRetired(twice, "code-RS01", true, "2026-11-02T13:00:00.000Z"), twice);
  assert.equal(demoSetPartRetired(twice, "method", "method-R", false, "x").codes.filter((row) => row.retiredAt).length, 0);
});

/* ---------- products ---------- */

test("pack sizes compare however they were written", () => {
  const rate25 = packKey({ weight: "1 unit", ratePricing: { packQty: 25, packUnit: "kg" } });
  for (const weight of ["25 kg", "25kg", "25kg bag", " 25 KG BAG ", "25 kgs"]) assert.equal(packKey({ weight }), rate25, weight);
  assert.equal(packKey({ ratePricing: { packQty: 0.25, packUnit: "QTL" } }), rate25);
  assert.notEqual(packKey({ weight: "50 kg" }), rate25);
  assert.equal(packKey({ weight: "500 g" }), packKey({ ratePricing: { packQty: 0.5, packUnit: "kg" } }));
  assert.equal(packKey({ weight: "12 x 1 L (12 Litres)" }), packKey({ weight: "12 L" }));
  assert.equal(packKey({ weight: "4 x 5 L (20 Litres)" }), packKey({ weight: "20 Litres" }));
  assert.notEqual(packKey({ weight: "15 L" }), packKey({ weight: "15 kg" }));
  assert.equal(packKey({ weight: "1 unit" }), packKey({ weight: " 1  UNIT " }));
  assert.notEqual(packKey({ weight: "1 unit" }), packKey({ weight: "2 unit" }));
  // A pack with no size in it never matches a real pack.
  assert.equal(packKey({}), "text:");
});

const shelf = [
  { id: "A", name: "Sona 25", category: "Rice", status: "approved", active: true, weight: "25 kg", productCode: "RS01" },
  { id: "B", name: "Sona 50", category: "Rice", status: "approved", active: true, weight: "50 kg bag", productCode: "RS01" },
  { id: "C", name: "Sona 25 old", category: "Rice", status: "approved", active: false, weight: "25 kg", productCode: "RS01" },
  { id: "D", name: "Sona 25 rejected", category: "Rice", status: "rejected", active: true, weight: "25 kg", productCode: "RS01" },
  { id: "E", name: "Kaveri 25", category: "Rice", status: "approved", active: true, weight: "25 kg", productCode: "RK01" },
  { id: "F", name: "Plain 25", category: "Rice", status: "pending", active: true, weight: "25 kg" },
  { id: "G", name: "Sugar 50", category: "Sugar", status: "approved", active: true, weight: "50 kg" },
];

test("a duplicate is a live product with the same code and pack size", () => {
  const ids = (list: { id: string }[]) => list.map((product) => product.id);
  assert.deepEqual(ids(duplicateProducts(shelf, "RS01", { weight: "25kg" })), ["A"], "inactive, rejected and other packs don't count");
  assert.deepEqual(ids(duplicateProducts(shelf, "RS01", { ratePricing: { packQty: 50, packUnit: "kg" } })), ["B"]);
  assert.deepEqual(ids(duplicateProducts(shelf, "RS01", { weight: "25 kg" }, "A")), [], "a product is not its own duplicate");
  assert.deepEqual(ids(duplicateProducts(shelf, "RS01", { weight: "10 kg" })), []);
  assert.deepEqual(ids(duplicateProducts(shelf, "", { weight: "25 kg" })), []);
  // One code across 25 kg and 50 kg is allowed: no warning between A and B.
  assert.deepEqual(ids(duplicateProducts(shelf, "RS01", { weight: "50 kg" }, "B")), []);
  assert.deepEqual(ids(productsWithCode(shelf, "RS01")), ["A", "B", "C", "D"]);
});

test("products without a code, by category", () => {
  const ids = (list: { id: string }[]) => list.map((product) => product.id);
  assert.deepEqual(ids(productsWithoutCode(shelf)), ["F", "G"]);
  assert.deepEqual(ids(productsWithoutCode(shelf, "rice")), ["F"]);
  assert.deepEqual(ids(productsWithoutCode(shelf, "Oil")), []);
});

/* ---------- Zoho ---------- */

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("nothing in the Zoho sync can see a product's code", () => {
  const sync = source("src/lib/zoho-commerce.functions.ts");
  // These names are what the fingerprint and item push are built from; if they move, re-check this.
  for (const name of ["catalogSharedValues", "catalogItemDetails", "catalogEditableValues", "catalogFingerprint"]) assert.match(sync, new RegExp(`function ${name}\\(`), name);
  assert.doesNotMatch(sync, /productCode/);
  assert.doesNotMatch(source("src/lib/zoho-sync-core.ts"), /productCode/);
  // A SKU stays the only thing Zoho matches on, and the rules module never builds one.
  assert.doesNotMatch(source("src/lib/product-code-rules.ts"), /\bsku\s*:/);
});

test("a Zoho item update merges into the product, so the code field survives", () => {
  const apply = source("supabase/migrations/20261022120000_zoho_item_hsn_mrp_two_way.sql");
  assert.match(apply, /payload = payload \|\| jsonb_strip_nulls/);
});

test("the duplicate to confirm is the one this save brings about", () => {
  const live = [
    { id: "A", name: "A", category: "Rice", status: "approved", active: true, weight: "25 kg", productCode: "RS01" },
    { id: "B", name: "B", category: "Rice", status: "approved", active: true, weight: "50 kg", productCode: "RS01" },
  ];
  const original = { code: "RS01", pack: { weight: "25 kg" } };
  // Nothing about the code or pack changed: an old duplicate holds nothing up.
  assert.deepEqual(duplicatesToConfirm([...live, { ...live[0]!, id: "C" }], "RS01", { weight: "25 kg" }, "A", original).map((p) => p.id), []);
  // Only the pack changed, into one already sold.
  assert.deepEqual(duplicatesToConfirm(live, "RS01", { weight: "50 kg" }, "A", original).map((p) => p.id), ["B"]);
  // A new product has nothing to compare with.
  assert.deepEqual(duplicatesToConfirm(live, "RS01", { weight: "25 kg" }).map((p) => p.id), ["A"]);
  assert.equal(packLabel({ weight: "25 kg bag" }), "25 kg bag");
  assert.equal(packLabel({ weight: "1 unit", ratePricing: { packQty: 50, packUnit: "kg" } }), "50 kg");
});

test("a whole-product save takes the code from the database, not the page's copy", () => {
  const store = source("src/lib/store.tsx");
  assert.match(store, /if \(row\) live\.productCode = typeof payload\["productCode"\] === "string"/);
  const updated = store.slice(store.indexOf("const updated = { ...existing, ...live, ...patch"));
  assert.ok(updated.length > 0);
});

test("setting a code goes through its own function, never a whole-product save", () => {
  for (const file of ["src/routes/admin.products.tsx", "src/routes/admin.products.$id.tsx"]) {
    const page = source(file);
    assert.match(page, /setProductCode\(/, file);
    assert.doesNotMatch(page, /productCode: (editForm|codeDraft)\.productCode/, file);
  }
  assert.match(source("src/lib/store.tsx"), /supabase\.rpc\("admin_set_product_code"/);
});
