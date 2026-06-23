"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Container from "@mui/material/Container";
import Grid from "@mui/material/Grid";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import GitHubIcon from "@mui/icons-material/GitHub";
import CodeIcon from "@mui/icons-material/Code";
import GroupsIcon from "@mui/icons-material/Groups";
import VerifiedIcon from "@mui/icons-material/Verified";
import { DOCS_URL, GITHUB_URL } from "@/lib/constants";

const OSS_POINTS = [
  {
    icon: <CodeIcon />,
    title: "MIT licensed",
    text: "Fork it, self-host it, or contribute back. The full extension lives in the repo.",
  },
  {
    icon: <GroupsIcon />,
    title: "Community driven",
    text: "Issues, PRs, and discussions on GitHub. No black-box scraping magic.",
  },
  {
    icon: <VerifiedIcon />,
    title: "Bring your own key",
    text: "OpenRouter API key stays in your browser. You pick models and control spend.",
  },
];

export default function OpenSource() {
  return (
    <Box component="section" id="open-source" sx={{ py: { xs: 8, md: 12 } }}>
      <Container maxWidth="lg">
        <Grid container spacing={6} sx={{ alignItems: "center" }}>
          <Grid size={{ xs: 12, md: 6 }}>
            <Typography variant="overline" color="primary" sx={{ letterSpacing: "0.12em" }}>
              Open source
            </Typography>
            <Typography variant="h3" sx={{ mt: 1, mb: 2 }}>
              Built in the open. Audited by the community.
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 3, lineHeight: 1.7 }}>
              ScrapeFlow is fully open source on GitHub. Inspect how browser tools run, how files are stored locally,
              and how OpenRouter calls are made — then customize it for your workflow.
            </Typography>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
              <Button
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                variant="contained"
                color="primary"
                size="large"
                startIcon={<GitHubIcon />}
              >
                View repository
              </Button>
              <Button href={DOCS_URL} target="_blank" rel="noopener noreferrer" variant="outlined" color="inherit" size="large" sx={{ borderColor: "divider" }}>
                Read docs
              </Button>
            </Stack>
          </Grid>

          <Grid size={{ xs: 12, md: 6 }}>
            <Stack spacing={2}>
              {OSS_POINTS.map((point) => (
                <Box
                  key={point.title}
                  sx={{
                    display: "flex",
                    gap: 2,
                    p: 2.5,
                    borderRadius: 2,
                    border: 1,
                    borderColor: "divider",
                    bgcolor: "background.paper",
                  }}
                >
                  <Box sx={{ color: "primary.main", mt: 0.25 }}>{point.icon}</Box>
                  <Box>
                    <Typography sx={{ fontWeight: 700, mb: 1 }}>
                      {point.title}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.65 }}>
                      {point.text}
                    </Typography>
                  </Box>
                </Box>
              ))}
            </Stack>
          </Grid>
        </Grid>
      </Container>
    </Box>
  );
}
