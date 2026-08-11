import { useTheme } from "@/hooks/useTheme";
import { Sun, Moon } from "lucide-react";

export default function ThemeToggle() {

  const {
    theme,
    toggleTheme,
  } = useTheme();


  const isDark =
    theme === "dark";


  return (

    <button

      type="button"

      onClick={toggleTheme}

      aria-label={`Switch to ${isDark ? "light" : "dark"} theme`}

      aria-pressed={isDark}

      title={`Switch to ${isDark ? "light" : "dark"} theme`}

      className="
        p-2
        rounded-full

        text-muted-foreground
        bg-transparent
        border border-transparent

        hover:text-foreground
        hover:bg-muted/40

        focus-visible:outline-none
        focus-visible:ring-2
        focus-visible:ring-muted-foreground/30

        transition-colors
        motion-reduce:transition-none
      "

    >

      {isDark ? (

        <Sun
          size={18}
          className="opacity-80"
          aria-hidden="true"
        />

      ) : (

        <Moon
          size={18}
          className="opacity-80"
          aria-hidden="true"
        />

      )}

    </button>

  );

}