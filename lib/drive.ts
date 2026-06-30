// Google Drive access for saving generated PO/invoice PDFs into each vendor's
// folder.
//
// Authenticates with the SAME service account used for Sheets (see sheets.ts),
// scoped to Drive here. Server-only: never import from a client component.

import "server-only";
import { Readable } from "node:stream";
import { google, type drive_v3 } from "googleapis";
import { getServiceAccount } from "./sheets";

const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"];

// Root "by vendor" folder holding one subfolder per vendor. This matches the
// catalog/intake flow so a vendor's submitted invoices and Landon's POs land in
// the same place. Overridable via env in case the folder ever moves.
const DEFAULT_VENDOR_ROOT = "1G6ubE8bKtVdOEzI-4EvtqChMXw_3_nLO";

function vendorRootFolderId(): string {
  const v = process.env.DRIVE_VENDOR_ROOT_FOLDER_ID;
  return v && v.trim() ? v.trim() : DEFAULT_VENDOR_ROOT;
}

let cachedDrive: drive_v3.Drive | null = null;

function getDrive(): drive_v3.Drive {
  if (cachedDrive) return cachedDrive;
  const sa = getServiceAccount();
  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: DRIVE_SCOPES,
  });
  cachedDrive = google.drive({ version: "v3", auth });
  return cachedDrive;
}

// Escapes a value for safe interpolation inside a Drive query string literal.
function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// Builds the vendor folder name: "<contactId> - <vendorName>" (matching the
// catalog flow). Falls back gracefully if one part is missing.
export function vendorFolderName(contactId: string, vendorName: string): string {
  return (
    [contactId.trim(), vendorName.trim()].filter(Boolean).join(" - ") ||
    "Unknown vendor"
  );
}

// Finds the vendor's folder under the by-vendor root, creating it if missing.
// Returns the folder id.
export async function resolveVendorFolderId(
  contactId: string,
  vendorName: string
): Promise<string> {
  const drive = getDrive();
  const root = vendorRootFolderId();
  const folderName = vendorFolderName(contactId, vendorName);

  const q = [
    `name = '${escapeQueryValue(folderName)}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    `'${escapeQueryValue(root)}' in parents`,
    "trashed = false",
  ].join(" and ");

  const existing = await drive.files.list({
    q,
    fields: "files(id, name)",
    pageSize: 1,
    spaces: "drive",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const found = existing.data.files?.[0]?.id;
  if (found) return found;

  const created = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [root],
    },
    fields: "id",
    supportsAllDrives: true,
  });
  if (!created.data.id) {
    throw new Error("Failed to create the vendor's Drive folder");
  }
  return created.data.id;
}

export interface UploadedFile {
  id: string;
  name: string;
  webViewLink: string;
}

// Uploads a PDF buffer into the given folder and returns its id + view link.
export async function uploadPdfToFolder(
  folderId: string,
  fileName: string,
  pdf: Buffer
): Promise<UploadedFile> {
  const drive = getDrive();
  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType: "application/pdf", body: Readable.from(pdf) },
    fields: "id, name, webViewLink",
    supportsAllDrives: true,
  });
  const { id, name, webViewLink } = res.data;
  if (!id) throw new Error("Drive upload did not return a file id");
  return {
    id,
    name: name ?? fileName,
    webViewLink: webViewLink ?? `https://drive.google.com/file/d/${id}/view`,
  };
}

// Convenience: resolve (or create) the vendor folder and upload in one call.
export async function savePdfToVendorFolder(opts: {
  contactId: string;
  vendorName: string;
  fileName: string;
  pdf: Buffer;
}): Promise<UploadedFile> {
  const folderId = await resolveVendorFolderId(opts.contactId, opts.vendorName);
  return uploadPdfToFolder(folderId, opts.fileName, opts.pdf);
}
