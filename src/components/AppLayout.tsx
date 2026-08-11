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

      <header className="fixed top-4 right-4 z-50">

        <ThemeToggle />

      </header>


      {/* PAGE CONTENT */}

      <main className="relative z-10 min-h-screen">

        <Outlet />

      </main>

    </div>

  );

}