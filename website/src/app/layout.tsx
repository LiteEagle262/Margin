import type { Metadata } from "next";
import ThemeRegistry from "@/components/ThemeRegistry";
import "./globals.css";

export const metadata: Metadata = {
  title: "Margin — AI web scraping in your browser",
  description:
    "Open-source Chrome extension with ChatGPT OAuth and OpenRouter support, browser automation tools, MCP integrations, and a local file workspace.",
  openGraph: {
    title: "Margin",
    description: "Build web scrapers with an AI that sees the page.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeRegistry>{children}</ThemeRegistry>
      </body>
    </html>
  );
}
