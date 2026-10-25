import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
  title: "ClosetAI — Your personal fitting room",
  description: "See how a look feels before you put it on.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-demo-offline={process.env.DEMO_OFFLINE === "1" ? "true" : "false"}>
      <body>{children}</body>
    </html>
  );
}
