import type { Metadata } from "next";
import ThemeRegistry from "@/components/ThemeRegistry";
import "./globals.css";

export const metadata: Metadata = {
  title: "Margin — AI browser agent for Chrome",
  description:
    "Open-source Chrome extension with ChatGPT OAuth and OpenRouter support, browser and network tools, MCP integrations, and a local file workspace.",
  openGraph: {
    title: "Margin",
    description: "Drive your browser with an AI that sees the page.",
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
