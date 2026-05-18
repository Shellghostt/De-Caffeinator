import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Blob Unpacker | Web Pipeline",
  description: "A production-grade JavaScript reverse engineering and asset analysis pipeline for security auditing.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
