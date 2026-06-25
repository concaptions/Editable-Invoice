// Small numeric/formatting helpers shared by client and server.

// Rounds to 2 decimal places (the rule for line-item `amount` and totals).
export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// Parses a possibly-empty user input string into a safe number (0 on failure).
export function toNum(value: string | number | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string") return 0;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

export function formatUSD(value: number): string {
  return usdFormatter.format(Number.isFinite(value) ? value : 0);
}
