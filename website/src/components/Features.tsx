"use client";

import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Container from "@mui/material/Container";
import Grid from "@mui/material/Grid";
import Typography from "@mui/material/Typography";
import ChatBubbleOutlineOutlinedIcon from "@mui/icons-material/ChatBubbleOutlineOutlined";
import BuildIcon from "@mui/icons-material/Build";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import HubIcon from "@mui/icons-material/Hub";
import ExtensionIcon from "@mui/icons-material/Extension";
import NetworkCheckIcon from "@mui/icons-material/NetworkCheck";
import { FEATURES } from "@/lib/constants";

const ICONS: Record<string, React.ReactNode> = {
  Chat: <ChatBubbleOutlineOutlinedIcon />,
  Build: <BuildIcon />,
  Folder: <FolderOpenIcon />,
  Hub: <HubIcon />,
  Extension: <ExtensionIcon />,
  Network: <NetworkCheckIcon />,
};

export default function Features() {
  return (
    <Box component="section" id="features" sx={{ py: { xs: 8, md: 12 } }}>
      <Container maxWidth="lg">
        <Typography variant="overline" color="primary" sx={{ letterSpacing: "0.12em" }}>
          Features
        </Typography>
        <Typography variant="h3" sx={{ mt: 1, mb: 1, maxWidth: 520 }}>
          Everything the agent needs on the page
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 5, maxWidth: 560 }}>
          A focused Chrome extension — not another bloated platform. Real browser access, real files, real models.
        </Typography>

        <Grid container spacing={2.5}>
          {FEATURES.map((feature) => (
            <Grid key={feature.title} size={{ xs: 12, sm: 6, md: 4 }}>
              <Card
                sx={{
                  height: "100%",
                  transition: "border-color 0.2s, transform 0.2s",
                  "&:hover": {
                    borderColor: "primary.main",
                    transform: "translateY(-2px)",
                  },
                }}
              >
                <CardContent sx={{ p: 3 }}>
                  <Box
                    sx={{
                      width: 40,
                      height: 40,
                      borderRadius: 2,
                      display: "grid",
                      placeItems: "center",
                      mb: 2,
                      bgcolor: "rgba(94, 234, 212, 0.1)",
                      color: "primary.main",
                    }}
                  >
                    {ICONS[feature.icon]}
                  </Box>
                  <Typography variant="h6" sx={{ mb: 1 }}>
                    {feature.title}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.65 }}>
                    {feature.description}
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>
      </Container>
    </Box>
  );
}
