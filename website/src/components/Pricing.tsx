"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Container from "@mui/material/Container";
import Grid from "@mui/material/Grid";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Typography from "@mui/material/Typography";
import CheckCircleOutlineOutlinedIcon from "@mui/icons-material/CheckCircleOutlineOutlined";
import { PLANS } from "@/lib/constants";

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

        <Grid container spacing={3} sx={{ alignItems: "stretch", justifyContent: "center" }}>
          {PLANS.map((plan) => (
            <Grid key={plan.id} size={{ xs: 12, md: 6 }}>
              <Card
                sx={{
                  height: "100%",
                  display: "flex",
                  flexDirection: "column",
                  position: "relative",
                  borderColor: plan.highlighted ? "primary.main" : "divider",
                  boxShadow: plan.highlighted ? "0 0 0 1px rgba(94, 234, 212, 0.35)" : "none",
                }}
              >
                {plan.highlighted && (
                  <Chip
                    label="Most popular"
                    color="primary"
                    size="small"
                    sx={{ position: "absolute", top: 16, right: 16 }}
                  />
                )}
                <CardContent sx={{ p: 3, flex: 1, display: "flex", flexDirection: "column" }}>
                  <Typography variant="h6" sx={{ mb: 1 }}>
                    {plan.name}
                  </Typography>
                  <Box sx={{ display: "flex", alignItems: "baseline", gap: 0.5, mb: 1 }}>
                    <Typography variant="h3" component="span" sx={{ fontWeight: 800 }}>
                      {plan.price}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {plan.period}
                    </Typography>
                  </Box>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 3, minHeight: 48 }}>
                    {plan.description}
                  </Typography>

                  <List dense disablePadding sx={{ mb: 3, flex: 1 }}>
                    {plan.features.map((feature) => (
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

                  <Button
                    href={plan.ctaHref}
                    target={plan.ctaHref.startsWith("http") ? "_blank" : undefined}
                    rel={plan.ctaHref.startsWith("http") ? "noopener noreferrer" : undefined}
                    variant={plan.highlighted ? "contained" : "outlined"}
                    color={plan.highlighted ? "primary" : "inherit"}
                    fullWidth
                    size="large"
                    sx={plan.highlighted ? undefined : { borderColor: "divider" }}
                  >
                    {plan.cta}
                  </Button>
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>
      </Container>
    </Box>
  );
}
