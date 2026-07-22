import type { Metadata } from "next";
import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import Divider from "@mui/material/Divider";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Footer from "@/components/Footer";
import Header from "@/components/Header";
import { GITHUB_CONFIGURED, GITHUB_URL, SUPPORT_EMAIL } from "@/lib/constants";

export const metadata: Metadata = {
  title: "Privacy Policy — Margin",
  description: "How the Margin Chrome extension handles browser data, account connections, and locally stored settings.",
};

const sections = [
  {
    title: "Information Margin handles",
    paragraphs: [
      "Margin processes information you provide in chat, files you attach or create, extension settings, and the browser context needed to perform actions you request. Browser context may include page text, URLs, screenshots, tab metadata, cookies, form values, and network requests or responses when you enable the relevant tools.",
      "Provider credentials and connection tokens, including OpenAI OAuth access and refresh tokens or an OpenRouter API key, are stored in Chrome extension storage on your device. Margin does not operate a service that collects or stores your chat history, workspace files, or credentials on our servers.",
    ],
  },
  {
    title: "How information is used",
    paragraphs: [
      "Margin uses browser and account information only to provide features you initiate: answering prompts, inspecting or acting on pages, creating workspace files, keeping local chat history, and connecting optional tools.",
      "Network capture can include sensitive values in headers or response bodies. Margin applies built-in redaction when that option is enabled, but automated redaction cannot guarantee that every sensitive value will be detected.",
    ],
  },
  {
    title: "AI providers and optional services",
    paragraphs: [
      "When you use an AI feature, the prompt and necessary browser context are sent to the provider you selected, such as OpenAI or OpenRouter. Those providers process data under their own terms and privacy policies.",
      "When you connect ChatGPT, Margin uses a device-code OAuth flow: you authorize the connection on OpenAI's website, and Margin stores the resulting tokens locally so it can refresh the connection. Margin never receives your OpenAI password. This compatibility flow is not a separately endorsed third-party integration and may change if OpenAI changes its service.",
      "If you enable an external MCP server, web search, or a self-hosted temporary-email backend, Margin sends the information required for that request to the service you configured. Margin does not sell personal information or use extension data for advertising.",
    ],
  },
  {
    title: "Storage and retention",
    paragraphs: [
      "Settings, chats, workspace data, and provider credentials remain in Chrome extension storage until you disconnect the provider, clear the data, reset the extension, or uninstall it. Session-only browser state is cleared by Chrome. Third-party providers may retain request data according to their own policies and your account settings.",
    ],
  },
  {
    title: "Permissions and your choices",
    paragraphs: [
      "Margin requests broad browser permissions so it can inspect pages and run browser tools when directed. You control the active or latched tab, can disable individual tools and network capture, can disconnect providers, and can clear locally stored data from Settings.",
      "Only enable powerful tools on pages and accounts you trust. You can stop extension processing by disabling connected tools and services, disabling Margin in Chrome, or uninstalling it.",
    ],
  },
  {
    title: "Changes and contact",
    paragraphs: [
      "We may update this policy when Margin's features or data practices change. Material updates will be published on this page with a new effective date.",
    ],
  },
];

export default function PrivacyPage() {
  return (
    <>
      <Header />
      <Box component="main" sx={{ py: { xs: 7, md: 10 } }}>
        <Container maxWidth="md">
          <Stack spacing={3}>
            <Box>
              <Typography variant="overline" color="primary" sx={{ letterSpacing: "0.12em" }}>
                Privacy
              </Typography>
              <Typography component="h1" variant="h2" sx={{ mt: 1, mb: 2 }}>
                Margin Privacy Policy
              </Typography>
              <Typography color="text.secondary">Effective July 21, 2026</Typography>
            </Box>

            <Typography variant="h6" color="text.secondary" sx={{ fontWeight: 400, lineHeight: 1.7 }}>
              Margin is designed as a local-first browser extension. This policy explains what information the
              extension handles, where it goes, and the controls available to you.
            </Typography>

            <Divider />

            {sections.map((section) => (
              <Box component="section" key={section.title}>
                <Typography component="h2" variant="h5" sx={{ mb: 1.5, fontWeight: 700 }}>
                  {section.title}
                </Typography>
                <Stack spacing={1.5}>
                  {section.paragraphs.map((paragraph) => (
                    <Typography key={paragraph} color="text.secondary" sx={{ lineHeight: 1.75 }}>
                      {paragraph}
                    </Typography>
                  ))}
                </Stack>
              </Box>
            ))}

            <Box
              sx={{
                border: 1,
                borderColor: "divider",
                bgcolor: "background.paper",
                borderRadius: 2,
                p: { xs: 2.5, md: 3 },
              }}
            >
              <Typography sx={{ fontWeight: 700, mb: 1 }}>Questions?</Typography>
              <Typography color="text.secondary" sx={{ lineHeight: 1.7 }}>
                {SUPPORT_EMAIL ? (
                  <>Email <Link href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</Link>.</>
                ) : GITHUB_CONFIGURED ? (
                  <>Open an issue in the{" "}<Link href={GITHUB_URL} target="_blank" rel="noopener noreferrer">Margin repository</Link>.</>
                ) : (
                  <>The publisher support contact will be listed with the public release.</>
                )}
              </Typography>
            </Box>
          </Stack>
        </Container>
      </Box>
      <Footer />
    </>
  );
}
