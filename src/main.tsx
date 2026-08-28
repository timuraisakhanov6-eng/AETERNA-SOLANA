import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import App from "./App";
import { CapsuleProvider } from "@/context/CapsuleContext";
import { CreatorIdentityProvider, CreatorCreditProvider } from "@/context/CreatorRuntimeContext";
import { LandingPaymentGateProvider } from "@/context/LandingPaymentGateContext";
import { AETERNAWalletProvider } from "@/context/AETERNAWalletContext";

import {
  registerRuntimeServiceWorker,
} from "@/lib/runtime/registerRuntimeServiceWorker";

import "./index.css";

/**
 * AETERNA Runtime Bootstrap
 *
 * Responsibilities:
 *
 * ✔ initialize theme mode
 * ✔ mount React tree
 * ✔ activate CapsuleProvider context
 * ✔ activate routing layer
 * ✔ bootstrap Browser Runtime
 * ✔ signal watchdog readiness
 *
 * MUST NOT:
 *
 * ✘ access fragment secret
 * ✘ derive crypto keys
 * ✘ fetch manifest
 * ✘ know Browser Runtime implementation
 */

/* =============================
   THEME INITIALIZATION
   ============================= */

/**
 * Uses Tailwind darkMode: "class"
 * Default = dark
 */

if (typeof window !== "undefined") {

  const storedTheme =
    localStorage.getItem("aeterna-theme");

  if (storedTheme === "light") {

    document.documentElement
      .classList.remove("dark");

  } else {

    document.documentElement
      .classList.add("dark");

  }

}

/* =============================
   BROWSER RUNTIME BOOTSTRAP
   ============================= */

/**
 * Starts Browser Runtime.
 *
 * Registration failures are handled inside the
 * Browser Runtime adapter and MUST NOT prevent
 * the application from starting.
 */

void registerRuntimeServiceWorker();

/* =============================
   REACT ROOT MOUNT
   ============================= */

const rootElement =
  document.getElementById("root");

if (!rootElement) {

  throw new Error(
    "[AETERNA] root element not found",
  );

}

createRoot(rootElement).render(
  <BrowserRouter>
    <AETERNAWalletProvider>
      <CapsuleProvider>
        <CreatorIdentityProvider>
          <CreatorCreditProvider>
            <LandingPaymentGateProvider>
              <App />
            </LandingPaymentGateProvider>
          </CreatorCreditProvider>
        </CreatorIdentityProvider>
      </CapsuleProvider>
    </AETERNAWalletProvider>
  </BrowserRouter>
);

/* =============================
   WATCHDOG READY SIGNAL
   ============================= */

/**
 * Cancels emergency.html fallback timer.
 *
 * Spec §25:
 * Emergency Watchdog Bootstrap Contract
 */

window.dispatchEvent(
  new Event("aeterna:ready"),
);
