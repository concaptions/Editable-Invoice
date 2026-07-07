"use client";

import { Spinner } from "@/components/Spinner";
import type { PayoutDetails } from "@/lib/types";

const PAYMENT_METHODS = ["ACH", "Wire", "Both"] as const;

// Editable payout / payment card. Method gates which fieldset shows (a blank or
// unknown method shows both, so nothing is ever hidden). Saving goes through the
// caller's own handler (the external payout service) — independent of any sheet
// save. Shared by the PO editor's payment section and the standalone
// /customer-payouts page, so both render an identical card.
export function PaymentSection({
  payout,
  onChange,
  onSave,
  saving,
  dirty,
  title = "Payout / payment details",
  subtitle = "How this vendor gets paid — prefilled from their record. Fill in anything missing; this prints on the PO.",
  saveLabel = "Save payout",
}: {
  payout: PayoutDetails;
  onChange: (patch: Partial<PayoutDetails>) => void;
  onSave: () => void;
  saving: boolean;
  dirty: boolean;
  title?: string;
  subtitle?: string;
  saveLabel?: string;
}) {
  const m = (payout.method || "").toLowerCase();
  const showAch = !m || m.includes("ach") || m.includes("both");
  const showWire = !m || m.includes("wire") || m.includes("both");

  // Keep a non-standard stored method selectable so it's never silently lost.
  const methodOptions: string[] = [...PAYMENT_METHODS];
  if (
    payout.method &&
    !PAYMENT_METHODS.some((x) => x.toLowerCase() === payout.method.toLowerCase())
  ) {
    methodOptions.push(payout.method);
  }

  return (
    <section className="mt-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
          <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <span className="text-xs font-medium text-amber-600">
              Unsaved payout
            </span>
          )}
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="flex items-center justify-center gap-2 rounded-md border border-brand-300 bg-white px-4 py-2 text-sm font-semibold text-brand-700 transition hover:bg-brand-50 disabled:opacity-50"
          >
            {saving && <Spinner className="h-4 w-4 text-brand-500" />}
            {saving ? "Saving…" : saveLabel}
          </button>
        </div>
      </div>

      {/* Method */}
      <div className="mt-4 max-w-xs">
        <label className="block text-xs font-medium uppercase tracking-wide text-slate-400">
          Payment method
        </label>
        <select
          value={payout.method}
          onChange={(e) => onChange({ method: e.target.value })}
          className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
        >
          <option value="">— Select —</option>
          {methodOptions.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </div>

      {/* ACH */}
      {showAch && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/60 p-4">
          <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">
            ACH
          </h3>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <PayoutField
              label="Account holder"
              value={payout.achAccountHolder}
              onChange={(v) => onChange({ achAccountHolder: v })}
            />
            <PayoutField
              label="Routing number"
              value={payout.achRoutingNumber}
              onChange={(v) => onChange({ achRoutingNumber: v })}
            />
            <PayoutField
              label="Account number"
              value={payout.achAccountNumber}
              onChange={(v) => onChange({ achAccountNumber: v })}
            />
            <PayoutField
              label="Account type"
              placeholder="Checking / Savings"
              value={payout.achAccountType}
              onChange={(v) => onChange({ achAccountType: v })}
            />
          </div>
        </div>
      )}

      {/* Wire */}
      {showWire && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/60 p-4">
          <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">
            Wire
          </h3>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <PayoutField
              label="Bank name"
              value={payout.wireBankName}
              onChange={(v) => onChange({ wireBankName: v })}
            />
            <PayoutField
              label="Routing / SWIFT"
              value={payout.wireRoutingSwift}
              onChange={(v) => onChange({ wireRoutingSwift: v })}
            />
            <PayoutField
              label="Account number"
              value={payout.wireAccountNumber}
              onChange={(v) => onChange({ wireAccountNumber: v })}
            />
            <PayoutField
              label="Beneficiary"
              value={payout.wireBeneficiary}
              onChange={(v) => onChange({ wireBeneficiary: v })}
            />
          </div>
        </div>
      )}

      {/* Bank address (shared) */}
      <div className="mt-4">
        <label className="block text-xs font-medium uppercase tracking-wide text-slate-400">
          Bank address
        </label>
        <textarea
          value={payout.bankAddress}
          onChange={(e) => onChange({ bankAddress: e.target.value })}
          rows={2}
          autoComplete="off"
          spellCheck={false}
          placeholder="Street, city, state, ZIP"
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
        />
      </div>
    </section>
  );
}

function PayoutField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-200"
      />
    </div>
  );
}
