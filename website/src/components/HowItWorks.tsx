"use client";

import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import Grid from "@mui/material/Grid";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { STEPS } from "@/lib/constants";

export default function HowItWorks() {
  return (
    <Box
      component="section"
      id="how-it-works"
      sx={{
        py: { xs: 8, md: 12 },
        bgcolor: "rgba(22, 27, 34, 0.5)",
        borderBlock: 1,
        borderColor: "divider",
      }}
    >
      <Container maxWidth="lg">
        <Typography variant="overline" color="primary" sx={{ letterSpacing: "0.12em" }}>
          How it works
        </Typography>
        <Typography variant="h3" sx={{ mt: 1, mb: 5, maxWidth: 480 }}>
          From install to working scraper in minutes
        </Typography>

        <Grid container spacing={4}>
          {STEPS.map((item) => (
            <Grid key={item.step} size={{ xs: 12, md: 4 }}>
              <Stack spacing={2}>
                <Typography
                  variant="h2"
                  sx={{
                    fontSize: "3rem",
                    fontWeight: 800,
                    color: "rgba(94, 234, 212, 0.2)",
                    lineHeight: 1,
                  }}
                >
                  {item.step}
                </Typography>
                <Typography variant="h6">{item.title}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.7 }}>
                  {item.description}
                </Typography>
              </Stack>
            </Grid>
          ))}
        </Grid>
      </Container>
    </Box>
  );
}
