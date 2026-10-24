import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClosetAI — Your personal fitting room",
  description: "See how a look feels before you put it on.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
