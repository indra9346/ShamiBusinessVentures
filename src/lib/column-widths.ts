/*
 * Excel/Zoho-style column widths for panel tables: drag a header's right edge to resize a column,
 * double-click it to fit the column back to its content. Widths are kept per table on this device.
 * Kept free of app imports so the node tests can load it.
 */

export const MIN_COLUMN_WIDTH = 48;
export const MAX_COLUMN_WIDTH = 1200;
const STORAGE_PREFIX = "gb-col-widths:";

export const clampColumnWidth = (width: number) =>
  Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Number.isFinite(width) ? width : MIN_COLUMN_WIDTH)));

/** The new width while dragging: the width at drag start plus how far the pointer moved. */
export const draggedWidth = (startWidth: number, startX: number, currentX: number) =>
  clampColumnWidth(startWidth + (currentX - startX));

/**
 * Saved widths for a table, or null when none are saved or they no longer fit it (its column
 * count changed). A 0 keeps that column at its natural width.
 */
export function parseSavedWidths(raw: string | null | undefined, columnCount: number): number[] | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length !== columnCount) return null;
    if (!value.every((width) => typeof width === "number" && Number.isFinite(width) && width >= 0)) return null;
    return value.map((width: number) => (width === 0 ? 0 : clampColumnWidth(width)));
  } catch {
    return null;
  }
}

export const columnWidthsKey = (tableId: string) => STORAGE_PREFIX + tableId;

/** Total table width once columns have fixed widths, so widening one never squeezes the others. */
export const tableWidthFor = (widths: number[]) => widths.reduce((sum, width) => sum + width, 0);
