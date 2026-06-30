// In-process PDF document for invoices / purchase orders, rendered with
// @react-pdf/renderer (pure JS — no headless browser). Imported only by the
// server route that renders it to a Buffer; never by a client component.
//
// Totals are rendered EXACTLY as passed in (subtotal / cleaningFee / total are
// never recomputed here) so the document always matches what Landon saved.

import "server-only";
import {
  Document,
  Page,
  View,
  Text,
  StyleSheet,
} from "@react-pdf/renderer";
import { formatUSD } from "./format";

export interface PdfLineItem {
  drug?: string;
  item?: string;
  strength?: string;
  expiry?: string;
  condition?: string;
  quantity?: number | string;
  rate?: number | string;
  amount?: number | string;
  customerNote?: string;
  poNote?: string;
  rejected?: boolean;
  cleaningFee?: number | string;
}

export interface InvoicePdfData {
  documentType?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  vendorName?: string;
  businessName?: string;
  contactId?: string;
  email?: string;
  phone?: string;
  lineItems?: PdfLineItem[];
  subtotal?: number;
  cleaningFee?: number;
  total?: number;
}

// Brand palette.
const BLUE = "#2E75B6";
const DARK = "#1F3A5F";
const VENDOR_BOX = "#EAF1F8";
const ZEBRA = "#F2F6FB";
const BORDER = "#D7E1EC";
const MUTED = "#5B6B7B";

const styles = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 9.5,
    color: "#1A2430",
    paddingTop: 46,
    paddingHorizontal: 50,
    paddingBottom: 56,
  },

  // Header
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  wordmark: { fontFamily: "Helvetica-Bold", fontSize: 26, color: BLUE, letterSpacing: 1 },
  subline: { marginTop: 2, fontSize: 9, color: MUTED },
  headerRight: { alignItems: "flex-end" },
  docTitle: { fontFamily: "Helvetica-Bold", fontSize: 16, color: DARK },
  docMeta: { marginTop: 4, fontSize: 9, color: MUTED, textAlign: "right" },
  docMetaStrong: { fontFamily: "Helvetica-Bold", color: "#1A2430" },

  rule: { marginTop: 12, height: 2, backgroundColor: BLUE },

  // Vendor box
  vendorBox: {
    marginTop: 16,
    backgroundColor: VENDOR_BOX,
    borderRadius: 4,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  vendorLabel: {
    fontSize: 7.5,
    letterSpacing: 1,
    color: BLUE,
    fontFamily: "Helvetica-Bold",
    marginBottom: 3,
  },
  vendorName: { fontFamily: "Helvetica-Bold", fontSize: 12, color: DARK },
  vendorLine: { marginTop: 2, fontSize: 9.5, color: "#2A3848" },

  // Table
  table: { marginTop: 18, borderWidth: 1, borderColor: BORDER, borderRadius: 4 },
  theadRow: { flexDirection: "row", backgroundColor: DARK },
  th: {
    color: "#FFFFFF",
    fontFamily: "Helvetica-Bold",
    fontSize: 8,
    letterSpacing: 0.4,
    paddingVertical: 6,
    paddingHorizontal: 6,
  },
  row: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: BORDER,
    alignItems: "flex-start",
  },
  cell: { paddingVertical: 6, paddingHorizontal: 6 },
  itemName: { fontFamily: "Helvetica-Bold", fontSize: 9.5, color: "#1A2430" },
  poNote: { marginTop: 2, fontSize: 8, fontStyle: "italic", color: MUTED },
  amountStruck: { textDecoration: "line-through", color: MUTED },

  tag: {
    marginTop: 3,
    alignSelf: "flex-end",
    fontSize: 6.5,
    fontFamily: "Helvetica-Bold",
    letterSpacing: 0.5,
    paddingVertical: 1.5,
    paddingHorizontal: 3,
    borderRadius: 2,
  },
  tagRejected: { backgroundColor: "#FCE4E4", color: "#B42318" },
  tagSample: { backgroundColor: "#FCEFD3", color: "#92600A" },

  emptyRow: { padding: 14, textAlign: "center", color: MUTED, fontSize: 9 },

  // Totals
  totalsWrap: { marginTop: 16, flexDirection: "row", justifyContent: "flex-end" },
  totalsBox: { width: "46%" },
  totalsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 3,
  },
  totalsLabel: { fontSize: 9.5, color: MUTED },
  totalsValue: { fontSize: 9.5, color: "#1A2430" },
  feeValue: { fontSize: 9.5, color: "#B42318" },
  grandRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4,
    paddingTop: 6,
    borderTopWidth: 1.5,
    borderTopColor: DARK,
  },
  grandLabel: { fontFamily: "Helvetica-Bold", fontSize: 11, color: DARK },
  grandValue: { fontFamily: "Helvetica-Bold", fontSize: 13, color: DARK },

  // Footer
  footer: {
    position: "absolute",
    bottom: 28,
    left: 50,
    right: 50,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: BORDER,
    paddingTop: 6,
    fontSize: 7.5,
    color: MUTED,
  },

  // Column widths (must sum to 100%).
  cItem: { width: "31%" },
  cStrength: { width: "13%" },
  cExpiry: { width: "13%" },
  cCond: { width: "11%" },
  cQty: { width: "8%", textAlign: "right" },
  cRate: { width: "12%", textAlign: "right" },
  cAmount: { width: "12%", textAlign: "right" },
});

function money(value: number | string | undefined): string {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  return formatUSD(Number.isFinite(n) ? n : 0);
}

function displayNum(value: number | string | undefined): string {
  if (value == null || value === "") return "—";
  const n = typeof value === "number" ? value : parseFloat(String(value));
  if (!Number.isFinite(n)) return String(value);
  // Trim trailing zeros for quantities (e.g. "2" not "2.00") but keep decimals.
  return Number.isInteger(n) ? String(n) : String(n);
}

export function InvoicePdf({ data }: { data: InvoicePdfData }) {
  const isPO = (data.documentType ?? "").trim().toUpperCase() === "PO";
  const title = isPO ? "PURCHASE ORDER" : "INTERNAL INVOICE";
  const grandLabel = isPO ? "Returned Total" : "Invoice Total";
  const cleaningFee = typeof data.cleaningFee === "number" ? data.cleaningFee : 0;
  const showFee = isPO && cleaningFee > 0;

  const items = Array.isArray(data.lineItems) ? data.lineItems : [];
  const contactLine = [data.email, data.phone].filter((x) => x && String(x).trim()).join("  ·  ");

  return (
    <Document
      title={`${title} ${data.invoiceNumber ?? ""}`.trim()}
      author="Las Vegas Diabetic Test Strips LLC"
    >
      <Page size="LETTER" style={styles.page}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.wordmark}>LVDTS</Text>
            <Text style={styles.subline}>Las Vegas Diabetic Test Strips</Text>
          </View>
          <View style={styles.headerRight}>
            <Text style={styles.docTitle}>{title}</Text>
            {data.invoiceNumber ? (
              <Text style={styles.docMeta}>
                <Text style={styles.docMetaStrong}>No. </Text>
                {data.invoiceNumber}
              </Text>
            ) : null}
            {data.invoiceDate ? (
              <Text style={styles.docMeta}>
                <Text style={styles.docMetaStrong}>Date </Text>
                {data.invoiceDate}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={styles.rule} />

        {/* Vendor */}
        <View style={styles.vendorBox}>
          <Text style={styles.vendorLabel}>VENDOR</Text>
          <Text style={styles.vendorName}>{data.vendorName || "Unknown vendor"}</Text>
          {data.businessName && String(data.businessName).trim() ? (
            <Text style={styles.vendorLine}>{data.businessName}</Text>
          ) : null}
          {data.contactId && String(data.contactId).trim() ? (
            <Text style={styles.vendorLine}>Vendor ID: {data.contactId}</Text>
          ) : null}
          {contactLine ? <Text style={styles.vendorLine}>{contactLine}</Text> : null}
        </View>

        {/* Line items */}
        <View style={styles.table}>
          <View style={styles.theadRow}>
            <Text style={[styles.th, styles.cItem]}>DRUG / ITEM</Text>
            <Text style={[styles.th, styles.cStrength]}>STRENGTH</Text>
            <Text style={[styles.th, styles.cExpiry]}>EXPIRY</Text>
            <Text style={[styles.th, styles.cCond]}>COND.</Text>
            <Text style={[styles.th, styles.cQty]}>QTY</Text>
            <Text style={[styles.th, styles.cRate]}>RATE</Text>
            <Text style={[styles.th, styles.cAmount]}>AMOUNT</Text>
          </View>

          {items.length === 0 ? (
            <Text style={styles.emptyRow}>No line items.</Text>
          ) : (
            items.map((it, i) => {
              const name = (it.drug || it.item || "—").trim() || "—";
              const note = (it.poNote ?? "").trim();
              const isSample = note.toLowerCase() === "sample";
              const zebra = i % 2 === 1 ? { backgroundColor: ZEBRA } : null;
              return (
                <View key={i} style={[styles.row, ...(zebra ? [zebra] : [])]} wrap={false}>
                  <View style={[styles.cell, styles.cItem]}>
                    <Text style={styles.itemName}>{name}</Text>
                    {note ? <Text style={styles.poNote}>{note}</Text> : null}
                  </View>
                  <Text style={[styles.cell, styles.cStrength]}>
                    {it.strength || "—"}
                  </Text>
                  <Text style={[styles.cell, styles.cExpiry]}>
                    {it.expiry || "—"}
                  </Text>
                  <Text style={[styles.cell, styles.cCond]}>
                    {it.condition || "—"}
                  </Text>
                  <Text style={[styles.cell, styles.cQty]}>
                    {displayNum(it.quantity)}
                  </Text>
                  <Text style={[styles.cell, styles.cRate]}>{money(it.rate)}</Text>
                  <View style={[styles.cell, styles.cAmount]}>
                    <Text style={it.rejected ? styles.amountStruck : undefined}>
                      {money(it.amount)}
                    </Text>
                    {it.rejected ? (
                      <Text style={[styles.tag, styles.tagRejected]}>REJECTED</Text>
                    ) : null}
                    {isSample ? (
                      <Text style={[styles.tag, styles.tagSample]}>SAMPLE</Text>
                    ) : null}
                  </View>
                </View>
              );
            })
          )}
        </View>

        {/* Totals */}
        <View style={styles.totalsWrap}>
          <View style={styles.totalsBox}>
            <View style={styles.totalsRow}>
              <Text style={styles.totalsLabel}>Subtotal</Text>
              <Text style={styles.totalsValue}>{money(data.subtotal)}</Text>
            </View>
            {showFee ? (
              <View style={styles.totalsRow}>
                <Text style={styles.totalsLabel}>Cleaning Fee</Text>
                <Text style={styles.feeValue}>{"−"}{money(cleaningFee)}</Text>
              </View>
            ) : null}
            <View style={styles.grandRow}>
              <Text style={styles.grandLabel}>{grandLabel}</Text>
              <Text style={styles.grandValue}>{money(data.total)}</Text>
            </View>
          </View>
        </View>

        {/* Footer */}
        <View style={styles.footer} fixed>
          <Text>Las Vegas Diabetic Test Strips LLC</Text>
          <Text
            render={({ pageNumber, totalPages }) =>
              `Page ${pageNumber} of ${totalPages}`
            }
          />
        </View>
      </Page>
    </Document>
  );
}
