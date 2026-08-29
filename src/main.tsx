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

const AETERNA_BUILD_VERSION = "22ae350-paymentmodal-fix";

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

  document.documentElement.dataset["aeternaBuild"] = AETERNA_BUILD_VERSION;
}

void registerRuntimeServiceWorker();

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

window.dispatchEvent(
  new Event("aeterna:ready"),
);
