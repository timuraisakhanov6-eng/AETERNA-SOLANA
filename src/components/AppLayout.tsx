// src/components/AppLayout.tsx

import { Outlet } from "react-router-dom";
import ThemeToggle from "@/components/ThemeToggle";
export default function AppLayout() {

  return (

    <div className="relative min-h-screen bg-background text-foreground">

      {/* BACKGROUND */}

      <div className="absolute inset-0 z-0 pointer-events-none">


      </div>


      {/* GLOBAL HEADER */}

      {/*
        R9-A88.9 — `viewport-fit=cover` is global, so this header is positioned
        against the physical screen edge. Without the insets the control lands
        inside the iOS status bar (portrait) and inside the sensor housing in
        landscape. 1rem is preserved beyond each inset.
      */}
      <header className="fixed right-[calc(env(safe-area-inset-right)+1rem)] top-[calc(env(safe-area-inset-top)+1rem)] z-50">

        <ThemeToggle />

      </header>


      {/* PAGE CONTENT */}

      <main className="relative z-10 min-h-screen">

        <Outlet />

      </main>

    </div>

  );

}