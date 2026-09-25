"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/hint";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return <Hint label="Toggle light and dark theme"><Button variant="ghost" size="icon" aria-label="Toggle light and dark theme" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
    <Sun className="hidden dark:block" aria-hidden="true" />
    <Moon className="block dark:hidden" aria-hidden="true" />
  </Button></Hint>;
}
