// Color-codes a free-text status string by keyword.

function classesFor(status: string): string {
  const s = status.toLowerCase();
  if (s.includes("approved") || s.includes("full match")) {
    return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  }
  if (s.includes("partial")) {
    return "bg-amber-50 text-amber-700 ring-amber-200";
  }
  if (s.includes("no match") || s.includes("reject") || s.includes("fail")) {
    return "bg-rose-50 text-rose-700 ring-rose-200";
  }
  if (s.includes("pending") || s.includes("review")) {
    return "bg-blue-50 text-blue-700 ring-blue-200";
  }
  return "bg-slate-100 text-slate-600 ring-slate-200";
}

export function StatusBadge({ status }: { status: string }) {
  const label = status?.trim() || "—";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${classesFor(
        label
      )}`}
    >
      {label}
    </span>
  );
}
