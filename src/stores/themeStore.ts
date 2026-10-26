import { create } from "zustand";

export type Theme = "dark" | "light";

const THEME_KEY = "qpg.theme";

function loadTheme(): Theme {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return raw === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

interface ThemeStore {
  theme: Theme;
  setTheme: (t: Theme) => void;
}

const initial = loadTheme();
applyTheme(initial);

export const useThemeStore = create<ThemeStore>((set) => ({
  theme: initial,
  setTheme: (t) => {
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      // Private window / storage disabled — still applies for this session.
    }
    applyTheme(t);
    set({ theme: t });
  },
}));
