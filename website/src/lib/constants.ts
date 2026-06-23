export const GITHUB_URL = "https://github.com/scrapeflow/scrapeflow";
export const CHROME_STORE_URL = "#";
export const DOCS_URL = "https://github.com/scrapeflow/scrapeflow#readme";

export const NAV_LINKS = [
  { label: "Features", href: "#features" },
  { label: "How it works", href: "#how-it-works" },
  { label: "Open source", href: "#open-source" },
  { label: "Pricing", href: "#pricing" },
] as const;

export const FEATURES = [
  {
    title: "Side panel AI chat",
    description:
      "OpenRouter-powered assistant lives in Chrome's side panel — always one click away while you browse.",
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
    title: "Any OpenRouter model",
    description:
      "Search 300+ models from the settings picker. Bring your own API key — you control cost and provider.",
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
    title: "Install & add your key",
    description: "Load ScrapeFlow from GitHub or the Chrome Web Store. Paste your OpenRouter API key in settings.",
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
    description: "Self-host the extension. Perfect for builders who bring their own OpenRouter key.",
    highlighted: false,
    cta: "View on GitHub",
    ctaHref: GITHUB_URL,
    features: [
      "Full extension source (MIT)",
      "Browser automation tools",
      "OpenRouter model search",
      "File workspace & chat history",
      "MCP server connections",
      "Community support via GitHub",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    price: "$12",
    period: "/ month",
    description: "Managed experience with cloud sync and priority features for solo power users.",
    highlighted: true,
    cta: "Start Pro trial",
    ctaHref: "#pricing",
    features: [
      "Everything in Open Source",
      "Cloud-synced chats & files",
      "Priority model routing",
      "Advanced MCP presets",
      "Unlimited chat sessions",
      "Email support",
    ],
  },
  {
    id: "team",
    name: "Team",
    price: "$39",
    period: "/ seat / mo",
    description: "Shared workspaces and governance for scraping teams and agencies.",
    highlighted: false,
    cta: "Contact sales",
    ctaHref: "mailto:hello@scrapeflow.dev",
    features: [
      "Everything in Pro",
      "Shared team workspaces",
      "Centralized API key vault",
      "Role-based access",
      "Usage analytics dashboard",
      "SLA & dedicated support",
    ],
  },
] as const;
