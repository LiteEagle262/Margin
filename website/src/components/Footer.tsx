"use client";

import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import Divider from "@mui/material/Divider";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import GitHubIcon from "@mui/icons-material/GitHub";
import { CHROME_STORE_URL, GITHUB_URL, NAV_LINKS } from "@/lib/constants";

export default function Footer() {
  return (
    <Box component="footer" sx={{ py: 6, borderTop: 1, borderColor: "divider" }}>
      <Container maxWidth="lg">
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={3}
          sx={{ justifyContent: "space-between", alignItems: { xs: "flex-start", md: "center" } }}
        >
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 800, letterSpacing: "-0.03em" }}>
              ScrapeFlow
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              AI-powered scraping in your browser side panel.
            </Typography>
          </Box>

          <Stack direction="row" spacing={3} sx={{ flexWrap: "wrap" }}>
            {NAV_LINKS.map((link) => (
              <Link key={link.href} href={link.href} color="text.secondary" underline="hover" variant="body2">
                {link.label}
              </Link>
            ))}
            <Link href={GITHUB_URL} target="_blank" rel="noopener noreferrer" color="text.secondary" underline="hover" variant="body2">
              GitHub
            </Link>
            <Link href={CHROME_STORE_URL} color="text.secondary" underline="hover" variant="body2">
              Chrome Web Store
            </Link>
          </Stack>
        </Stack>

        <Divider sx={{ my: 3 }} />

        <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ justifyContent: "space-between" }}>
          <Typography variant="caption" color="text.secondary">
            © {new Date().getFullYear()} ScrapeFlow. Open source under MIT.
          </Typography>
          <Link
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            color="text.secondary"
            underline="hover"
            variant="caption"
            sx={{ display: "inline-flex", alignItems: "center", gap: 0.5 }}
          >
            <GitHubIcon sx={{ fontSize: 14 }} />
            github.com/scrapeflow/scrapeflow
          </Link>
        </Stack>
      </Container>
    </Box>
  );
}
