import { useEffect, useRef, type ComponentPropsWithoutRef, type RefObject } from "react";
import { columnWidthsKey, draggedWidth, parseSavedWidths, tableWidthFor } from "@/lib/column-widths";

const HANDLE_CLASS = "gb-col-resizer";

const headerCells = (table: HTMLTableElement) =>
  Array.from(table.tHead?.rows[0]?.cells ?? []) as HTMLTableCellElement[];

function readWidths(tableId: string, count: number) {
  try {
    return parseSavedWidths(localStorage.getItem(columnWidthsKey(tableId)), count);
  } catch {
    return null;
  }
}

function saveWidths(tableId: string, widths: number[]) {
  try {
    localStorage.setItem(columnWidthsKey(tableId), JSON.stringify(widths));
  } catch {
    /* storage blocked: widths last until the page reloads */
  }
}

/** Gives each column a fixed width (table grows sideways instead of squeezing the others). */
function applyWidths(table: HTMLTableElement, cells: HTMLTableCellElement[], widths: number[]) {
  cells.forEach((cell, index) => { cell.style.width = `${widths[index]}px`; });
  table.style.tableLayout = "fixed";
  table.style.width = `${tableWidthFor(widths)}px`;
  table.style.minWidth = "0";
  table.dataset["colResized"] = "true";
}

/** The width each column would take with no wrapping (used to fit a column on double-click). */
function naturalWidths(table: HTMLTableElement, cells: HTMLTableCellElement[]) {
  const saved = { layout: table.style.tableLayout, width: table.style.width, minWidth: table.style.minWidth, cells: cells.map((cell) => cell.style.width) };
  table.style.tableLayout = "auto";
  table.style.width = "max-content";
  table.style.minWidth = "0";
  cells.forEach((cell) => { cell.style.width = ""; });
  delete table.dataset["colResized"];
  const widths = cells.map((cell) => Math.ceil(cell.getBoundingClientRect().width));
  table.style.tableLayout = saved.layout;
  table.style.width = saved.width;
  table.style.minWidth = saved.minWidth;
  cells.forEach((cell, index) => { cell.style.width = saved.cells[index] ?? ""; });
  if (saved.layout === "fixed") table.dataset["colResized"] = "true";
  return widths;
}

/**
 * Excel/Zoho-style column resizing for a <table>: drag the right edge of a header to resize that
 * column, double-click the edge to fit the column to its content. Widths are remembered per
 * tableId on this device.
 */
export function useColumnResize(tableRef: RefObject<HTMLTableElement | null>, tableId: string) {
  const appliedFor = useRef("");
  useEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    const cells = headerCells(table);
    if (cells.length === 0) return;
    // Restore saved widths once per table shape (and again if its columns change).
    const shape = `${tableId}:${cells.length}`;
    if (appliedFor.current !== shape) {
      appliedFor.current = shape;
      const saved = readWidths(tableId, cells.length);
      if (saved && saved.every((width) => width > 0)) applyWidths(table, cells, saved);
    }
    cells.forEach((cell) => {
      if (cell.querySelector(`:scope > .${HANDLE_CLASS}`)) return;
      if (getComputedStyle(cell).position === "static") cell.style.position = "relative";
      const handle = document.createElement("span");
      handle.className = HANDLE_CLASS;
      handle.setAttribute("role", "separator");
      handle.setAttribute("aria-orientation", "vertical");
      handle.title = "Drag to resize the column · double-click to fit";
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const current = headerCells(table);
        const widths = current.map((item) => Math.round(item.getBoundingClientRect().width));
        applyWidths(table, current, widths);
        const column = current.indexOf(cell);
        const startX = event.clientX;
        const startWidth = widths[column] ?? cell.offsetWidth;
        handle.setPointerCapture(event.pointerId);
        handle.dataset["dragging"] = "true";
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        const move = (moveEvent: PointerEvent) => {
          widths[column] = draggedWidth(startWidth, startX, moveEvent.clientX);
          applyWidths(table, current, widths);
        };
        const end = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", end);
          handle.removeEventListener("pointercancel", end);
          delete handle.dataset["dragging"];
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
          saveWidths(tableId, widths);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", end);
      });
      handle.addEventListener("click", (event) => event.stopPropagation());
      handle.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const current = headerCells(table);
        const column = current.indexOf(cell);
        const widths = current.map((item) => Math.round(item.getBoundingClientRect().width));
        widths[column] = draggedWidth(naturalWidths(table, current)[column] ?? widths[column]!, 0, 0);
        applyWidths(table, current, widths);
        saveWidths(tableId, widths);
      });
      cell.appendChild(handle);
    });
  });
}

/** A <table> whose columns can be resized like Excel/Zoho (see useColumnResize). */
export function ResizableTable({ tableId, ...props }: ComponentPropsWithoutRef<"table"> & { tableId: string }) {
  const ref = useRef<HTMLTableElement>(null);
  useColumnResize(ref, tableId);
  return <table ref={ref} {...props} />;
}
