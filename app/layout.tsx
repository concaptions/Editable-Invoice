import type { Metadata } from "next";
import "./globals.css";
import { ToastProvider } from "./providers";
import { Header } from "@/components/Header";

export const metadata: Metadata = {
  title: "LVDTS PO Editor",
  description: "Private purchase-order review & approval tool for LVDTS LLC",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-100 text-slate-900">
        <ToastProvider>
          <Header />
          {children}
        </ToastProvider>
      </body>
    </html>
  );
}
