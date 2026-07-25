"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Container from "@mui/material/Container";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Typography from "@mui/material/Typography";
import CheckCircleOutlineOutlinedIcon from "@mui/icons-material/CheckCircleOutlineOutlined";
import { GITHUB_URL, PLAN_FEATURES } from "@/lib/constants";

export default function Pricing() {
  return (
    <Box
      component="section"
      id="pricing"
      sx={{
        py: { xs: 8, md: 12 },
        bgcolor: "rgba(22, 27, 34, 0.5)",
        borderBlockStart: 1,
        borderColor: "divider",
      }}
    >
      <Container maxWidth="lg">
        <Box sx={{ textAlign: "center", mb: 6 }}>
          <Typography variant="overline" color="primary" sx={{ letterSpacing: "0.12em" }}>
            Pricing
          </Typography>
          <Typography variant="h3" sx={{ mt: 1, mb: 1.5 }}>
            Open source. Bring your own provider.
          </Typography>
          <Typography color="text.secondary" sx={{ maxWidth: 520, mx: "auto" }}>
            Margin is free under the MIT license. Any ChatGPT subscription or OpenRouter usage charges are handled by your selected provider.
          </Typography>
        </Box>

        <Card sx={{ maxWidth: 480, mx: "auto" }}>
          <CardContent sx={{ p: 3 }}>
            <Typography variant="h6" sx={{ mb: 1 }}>
              Open Source
            </Typography>
            <Box sx={{ display: "flex", alignItems: "baseline", gap: 0.5, mb: 1 }}>
              <Typography variant="h3" component="span" sx={{ fontWeight: 800 }}>
                $0
              </Typography>
              <Typography variant="body2" color="text.secondary">
                forever
              </Typography>
            </Box>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              Run the extension yourself and connect your preferred supported AI provider.
            </Typography>

            <List dense disablePadding sx={{ mb: 3 }}>
              {PLAN_FEATURES.map((feature) => (
                <ListItem key={feature} disableGutters sx={{ py: 0.6 }}>
                  <ListItemIcon sx={{ minWidth: 32 }}>
                    <CheckCircleOutlineOutlinedIcon sx={{ fontSize: 18, color: "primary.main" }} />
                  </ListItemIcon>
                  <ListItemText
                    primary={feature}
                    slotProps={{ primary: { variant: "body2", color: "text.secondary" } }}
                  />
                </ListItem>
              ))}
            </List>

            {GITHUB_URL && (
              <Button
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                variant="outlined"
                color="inherit"
                fullWidth
                size="large"
                sx={{ borderColor: "divider" }}
              >
                View on GitHub
              </Button>
            )}
          </CardContent>
        </Card>
      </Container>
    </Box>
  );
}
