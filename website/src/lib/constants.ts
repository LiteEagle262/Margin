export const GITHUB_CONFIGURED = Boolean(process.env.NEXT_PUBLIC_GITHUB_URL);
export const CHROME_STORE_CONFIGURED = Boolean(process.env.NEXT_PUBLIC_CHROME_STORE_URL);
export const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "";

export const GITHUB_URL = process.env.NEXT_PUBLIC_GITHUB_URL || "/#open-source";
export const CHROME_STORE_URL = process.env.NEXT_PUBLIC_CHROME_STORE_URL || "/#open-source";
export const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL || GITHUB_URL;
export const PRIVACY_URL = "/privacy";

export const NAV_LINKS = [
  { label: "Features", href: "/#features" },
  { label: "How it works", href: "/#how-it-works" },
  { label: "Open source", href: "/#open-source" },
  { label: "Pricing", href: "/#pricing" },
] as const;

export const FEATURES = [
  {
    title: "Side panel AI chat",
    description:
      "An OpenAI- or OpenRouter-powered assistant lives in Chrome's side panel — one click away while you browse.",
    icon: "Chat",
  },
  {
    title: "Browser automation tools",
    description:
      "get_dom, screenshots, clicks, scroll, typing, and run_js — the model inspects and acts on the live page.",
    icon: "Build",
  },
  {
    title: "File workspace",
    description:
      "Scripts ship as compact file cards via write_file — click to view, copy, or iterate without chat clutter.",
    icon: "Folder",
  },
  {
    title: "Your preferred AI provider",
    description:
      "Connect an eligible ChatGPT account with device-code OAuth, or bring an OpenRouter API key. You choose the provider and model.",
    icon: "Hub",
  },
  {
    title: "MCP server support",
    description:
      "Plug in HTTP MCP servers to extend the agent with custom tools beyond built-in browser actions.",
    icon: "Extension",
  },
  {
    title: "Chat history",
    description:
      "Multiple sessions with vision uploads, tool traces, and persistent workspace files per chat.",
    icon: "History",
  },
] as const;

export const STEPS = [
  {
    step: "01",
    title: "Install & connect",
    description: "Load Margin from GitHub or the Chrome Web Store. Link your ChatGPT account or add an OpenRouter key.",
  },
  {
    step: "02",
    title: "Open on any site",
    description: "Click the extension icon to open the side panel. Pick a model and describe what you want to scrape.",
  },
  {
    step: "03",
    title: "Let the agent work",
    description: "The AI inspects the DOM, captures screenshots, and writes scripts to your workspace as file cards.",
  },
] as const;

export const PLANS = [
  {
    id: "free",
    name: "Open Source",
    price: "$0",
    period: "forever",
    description: "Self-host the extension and connect your preferred supported AI provider.",
    highlighted: false,
    cta: GITHUB_CONFIGURED ? "View on GitHub" : "Open-source release pending",
    ctaHref: GITHUB_URL,
    features: [
      "Full extension source (MIT)",
      "Browser automation tools",
      "ChatGPT OAuth and OpenRouter support",
      "File workspace & chat history",
      "MCP server connections",
      "Contribution-ready repository",
    ],
  },
] as const;
