"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import GitHubIcon from "@mui/icons-material/GitHub";
import ExtensionIcon from "@mui/icons-material/Extension";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import {
  CHROME_STORE_CONFIGURED,
  CHROME_STORE_URL,
  GITHUB_CONFIGURED,
  GITHUB_URL,
} from "@/lib/constants";

export default function Hero() {
  return (
    <Box
      component="section"
      sx={{
        position: "relative",
        overflow: "hidden",
        pt: { xs: 8, md: 12 },
        pb: { xs: 10, md: 14 },
      }}
    >
      <Box
        sx={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse 80% 60% at 50% -10%, rgba(94, 234, 212, 0.14), transparent 60%), radial-gradient(ellipse 50% 40% at 90% 20%, rgba(45, 212, 191, 0.08), transparent 50%)",
          pointerEvents: "none",
        }}
      />

      <Container maxWidth="lg" sx={{ position: "relative" }}>
        <Stack spacing={4} sx={{ alignItems: "center", textAlign: "center" }}>
          <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", justifyContent: "center" }}>
            <Chip
              icon={<GitHubIcon />}
              label={GITHUB_CONFIGURED ? "Open source on GitHub" : "Open-source release ready"}
              size="small"
              component="a"
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              clickable
              sx={{ bgcolor: "rgba(94, 234, 212, 0.1)", border: "1px solid rgba(94, 234, 212, 0.25)" }}
            />
            <Chip
              icon={<AutoAwesomeIcon />}
              label="OpenAI · OpenRouter · Browser tools"
              size="small"
              sx={{ bgcolor: "background.paper", border: 1, borderColor: "divider" }}
            />
          </Stack>

          <Typography
            component="h1"
            variant="h2"
            sx={{
              maxWidth: 820,
              fontSize: { xs: "2.25rem", sm: "3rem", md: "3.75rem" },
            }}
          >
            Build web scrapers with an AI that{" "}
            <Box component="span" sx={{ color: "primary.main" }}>
              sees the page
            </Box>
          </Typography>

          <Typography variant="h6" color="text.secondary" sx={{ maxWidth: 620, fontWeight: 400, lineHeight: 1.6 }}>
            Margin is a Chrome side-panel assistant that inspects live pages, runs browser tools, and ships
            scripts as clean file cards — powered by a linked ChatGPT account or an OpenRouter API key.
          </Typography>

          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <Button
              href={CHROME_STORE_URL}
              variant="contained"
              color="primary"
              size="large"
              startIcon={<ExtensionIcon />}
            >
              {CHROME_STORE_CONFIGURED ? "Add to Chrome" : "View release details"}
            </Button>
            <Button
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              variant="outlined"
              color="inherit"
              size="large"
              startIcon={<GitHubIcon />}
              sx={{ borderColor: "divider" }}
            >
              {GITHUB_CONFIGURED ? "Star on GitHub" : "View open-source details"}
            </Button>
          </Stack>

          <Box
            sx={{
              mt: 2,
              width: "100%",
              maxWidth: 900,
              borderRadius: 3,
              border: 1,
              borderColor: "divider",
              bgcolor: "background.paper",
              p: { xs: 2, md: 3 },
              boxShadow: "0 24px 80px rgba(0,0,0,0.45)",
            }}
          >
            <Stack spacing={1.5} sx={{ fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, monospace', fontSize: 13, textAlign: "left" }}>
              <Box sx={{ color: "text.secondary" }}>{"// Side panel · Agent loop"}</Box>
              <Box>
                <Box component="span" sx={{ color: "primary.main" }}>assistant</Box>
                <Box component="span" sx={{ color: "text.secondary" }}> → write_file(</Box>
                <Box component="span" sx={{ color: "#fbbf24" }}>{'"scraper.js"'}</Box>
                <Box component="span" sx={{ color: "text.secondary" }}>)</Box>
              </Box>
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1.5,
                  p: 1.5,
                  borderRadius: 2,
                  border: 1,
                  borderColor: "divider",
                  bgcolor: "background.default",
                }}
              >
                <ExtensionIcon sx={{ color: "primary.main", fontSize: 20 }} />
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 700 }}>
                    scraper.js
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Created · javascript · 48 lines
                  </Typography>
                </Box>
                <Chip label="Copy" size="small" sx={{ ml: "auto" }} />
              </Box>
              <Box sx={{ color: "text.secondary", fontSize: 12 }}>
                Brief explanation in chat — no wall of code.
              </Box>
            </Stack>
          </Box>
        </Stack>
      </Container>
    </Box>
  );
}
