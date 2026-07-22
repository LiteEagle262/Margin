"use client";

import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Box from "@mui/material/Box";
import Container from "@mui/material/Container";
import IconButton from "@mui/material/IconButton";
import MenuIcon from "@mui/icons-material/Menu";
import GitHubIcon from "@mui/icons-material/GitHub";
import Drawer from "@mui/material/Drawer";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import { useState } from "react";
import {
  CHROME_STORE_CONFIGURED,
  CHROME_STORE_URL,
  GITHUB_CONFIGURED,
  GITHUB_URL,
  NAV_LINKS,
} from "@/lib/constants";

export default function Header() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <AppBar position="sticky" elevation={0} sx={{ borderBottom: 1, borderColor: "divider" }}>
        <Container maxWidth="lg">
          <Toolbar disableGutters sx={{ gap: 2, py: 0.5 }}>
            <Typography
              variant="h6"
              component="a"
              href="#"
              sx={{
                fontWeight: 800,
                letterSpacing: "-0.04em",
                color: "text.primary",
                textDecoration: "none",
                mr: 2,
              }}
            >
              Margin
            </Typography>

            <Box sx={{ display: { xs: "none", md: "flex" }, gap: 0.5, flex: 1 }}>
              {NAV_LINKS.map((link) => (
                <Button key={link.href} href={link.href} color="inherit" size="small">
                  {link.label}
                </Button>
              ))}
            </Box>

            <Box sx={{ display: { xs: "none", sm: "flex" }, gap: 1, alignItems: "center" }}>
              {GITHUB_CONFIGURED && (
                <Button
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  color="inherit"
                  size="small"
                  startIcon={<GitHubIcon fontSize="small" />}
                >
                  GitHub
                </Button>
              )}
              <Button href={CHROME_STORE_URL} variant="contained" color="primary" size="small">
                {CHROME_STORE_CONFIGURED ? "Add to Chrome" : "Release details"}
              </Button>
            </Box>

            <IconButton
              sx={{ display: { md: "none" }, ml: "auto" }}
              color="inherit"
              aria-label="menu"
              onClick={() => setOpen(true)}
            >
              <MenuIcon />
            </IconButton>
          </Toolbar>
        </Container>
      </AppBar>

      <Drawer anchor="right" open={open} onClose={() => setOpen(false)}>
        <Box sx={{ width: 260, pt: 2 }} role="presentation">
          <List>
            {NAV_LINKS.map((link) => (
              <ListItemButton key={link.href} component="a" href={link.href} onClick={() => setOpen(false)}>
                <ListItemText primary={link.label} />
              </ListItemButton>
            ))}
            {GITHUB_CONFIGURED && (
              <ListItemButton component="a" href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
                <ListItemText primary="GitHub" />
              </ListItemButton>
            )}
            <ListItemButton component="a" href={CHROME_STORE_URL}>
              <ListItemText primary={CHROME_STORE_CONFIGURED ? "Add to Chrome" : "Release details"} />
            </ListItemButton>
          </List>
        </Box>
      </Drawer>
    </>
  );
}
