"use client";

import { createTheme } from "@mui/material/styles";

export const marginTheme = createTheme({
  palette: {
    mode: "dark",
    primary: {
      main: "#5eead4",
      light: "#99f6e4",
      dark: "#2dd4bf",
      contrastText: "#0b1214",
    },
    secondary: {
      main: "#94a3b8",
    },
    background: {
      default: "#0e1116",
      paper: "#161b22",
    },
    text: {
      primary: "#eef2f6",
      secondary: "#94a3b8",
    },
    divider: "rgba(148, 163, 184, 0.14)",
    success: { main: "#4ade80" },
  },
  typography: {
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    h1: {
      fontWeight: 700,
      letterSpacing: "-0.03em",
      lineHeight: 1.05,
    },
    h2: {
      fontWeight: 700,
      letterSpacing: "-0.02em",
    },
    h3: {
      fontWeight: 650,
      letterSpacing: "-0.01em",
    },
    button: {
      textTransform: "none",
      fontWeight: 650,
    },
  },
  shape: {
    borderRadius: 10,
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          paddingInline: 20,
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
          border: "1px solid rgba(148, 163, 184, 0.12)",
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
          backgroundColor: "rgba(14, 17, 22, 0.82)",
          backdropFilter: "blur(12px)",
        },
      },
    },
  },
});
