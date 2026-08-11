// src/hooks/useTheme.ts

import { useState, useEffect } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "aeterna-theme";


/* ================= APPLY THEME ================= */

function applyTheme(theme: Theme) {

  if (typeof document === "undefined") {
    return;
  }

  const root =
    document.documentElement;

  root.setAttribute(
    "data-theme",
    theme
  );

  if (theme === "dark") {

    root.classList.add("dark");

  } else {

    root.classList.remove("dark");

  }

}


/* ================= INITIAL THEME ================= */

function getInitialTheme(): Theme {

  if (typeof window === "undefined") {

    return "dark";

  }

  const stored =
    localStorage.getItem(
      STORAGE_KEY
    );

  if (
    stored === "light" ||
    stored === "dark"
  ) {

    return stored;

  }

  /* fallback to system preference */

  if (
    window.matchMedia(
      "(prefers-color-scheme: dark)"
    ).matches
  ) {

    return "dark";

  }

  return "light";

}


/* ================= HOOK ================= */

export function useTheme() {

  const [
    theme,
    setTheme
  ] =
    useState<Theme>(
      getInitialTheme
    );


  /* apply immediately on mount */

  useEffect(() => {

    applyTheme(theme);

    localStorage.setItem(
      STORAGE_KEY,
      theme
    );

  }, [theme]);


  const toggleTheme = () => {

    setTheme(prev =>

      prev === "dark"
        ? "light"
        : "dark"

    );

  };


  return {

    theme,

    toggleTheme

  };

}