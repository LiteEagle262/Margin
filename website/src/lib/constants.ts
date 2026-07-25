export const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "";

export const GITHUB_URL = process.env.NEXT_PUBLIC_GITHUB_URL || "";
export const CHROME_STORE_URL = process.env.NEXT_PUBLIC_CHROME_STORE_URL || "";
export const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL || "";
export const PRIVACY_URL = "/privacy";

export const NAV_LINKS = [
  { label: "Features", href: "/#features" },
  { label: "How it works", href: "/#how-it-works" },
  { label: "Open source", href: "/#open-source" },
  { label: "Pricing", href: "/#pricing" },
] as const;

export const FEATURES = [
  {
    title: "Side panel AI agent",
    description:
      "An OpenAI- or OpenRouter-powered agent lives in Chrome's side panel — one click away while you browse.",
    icon: "Chat",
  },
  {
    title: "Browser tools, batched",
    description:
      "Snapshots, get_dom, screenshots, clicks, form fills, scrolling, typing and run_js — or browser_batch to run a whole sequence in one call.",
    icon: "Build",
  },
  {
    title: "Network capture",
    description:
      "Record the requests a page makes, search the log, and pull full headers and bodies for any single call.",
    icon: "Network",
  },
  {
    title: "File workspace & history",
    description:
      "Scripts and notes ship as compact file cards via write_file — kept per chat alongside vision uploads and tool traces.",
    icon: "Folder",
  },
  {
    title: "Your preferred AI provider",
    description:
      "Connect an eligible ChatGPT account with device-code OAuth, or bring an OpenRouter API key. You choose the provider and model.",
    icon: "Hub",
  },
  {
    title: "MCP in both directions",
    description:
      "Connect HTTP MCP servers to extend the agent, and expose Margin's browser tools to Claude Code, Codex or Cursor over the local MCP bridge.",
    icon: "Extension",
  },
] as const;

export const STEPS = [
  {
    step: "01",
    title: "Install & connect",
    description: "Load Margin from source or the Chrome Web Store. Link your ChatGPT account or add an OpenRouter key.",
  },
  {
    step: "02",
    title: "Open on any site",
    description: "Click the extension icon to open the side panel. Pick a model and describe what you want done.",
  },
  {
    step: "03",
    title: "Let the agent work",
    description: "It reads the page, runs browser and network tools, searches the web, and saves files to your workspace.",
  },
] as const;

export const PLAN_FEATURES = [
  "Full extension source (MIT)",
  "Browser, network and file tools",
  "ChatGPT OAuth and OpenRouter support",
  "Optional Tavily web search",
  "MCP server and MCP bridge connections",
  "Contribution-ready repository",
] as const;
