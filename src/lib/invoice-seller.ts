/** The address under "Sold by" on an invoice: the order's godown, or the company's if the godown has none. */
export function sellerAddressLines(godownAddress: string | null | undefined, companyLines: string[]): string[] {
  const lines = (godownAddress ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines : companyLines;
}
