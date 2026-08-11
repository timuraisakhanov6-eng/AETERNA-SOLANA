import { Routes, Route } from "react-router-dom";

import AppLayout from "@/components/AppLayout";

import Home from "@/pages/Home";
import Protocol from "@/pages/Protocol";
import NotFound from "@/pages/NotFound";

import Create from "@/pages/capsule/Create";
import CapsulePreview from "@/pages/capsule/CapsulePreview";
import CapsulePage from "@/pages/capsule/CapsulePage";
import CapsuleHold from "@/pages/capsule/CapsuleHold";

/**
 * AETERNA Application Routing Layer
 *
 * Responsibilities:
 *
 * ✔ defines Creator Runtime routes
 * ✔ defines Recipient Runtime entry boundary
 * ✔ preserves fragment-secret security model
 * ✔ enforces layout wrapping
 *
 * MUST NOT:
 *
 * ✘ access fragment secret
 * ✘ derive keys
 * ✘ fetch manifest
 * ✘ execute runtime crypto logic
 */

export default function App() {

  return (

    <Routes>

      <Route element={<AppLayout />}>

        {/* Home */}
        <Route
          path="/"
          element={<Home />}
        />

        {/* Protocol documentation */}
        <Route
          path="/protocol"
          element={<Protocol />}
        />

        {/* Creator Runtime entry */}
        <Route
          path="/create"
          element={<Create />}
        />

        {/* Creator Hold Authority Boundary */}
        <Route
          path="/create/hold"
          element={<CapsuleHold />}
        />

        {/* Pre-seal staging runtime */}
        <Route
          path="/capsule/preview"
          element={<CapsulePreview />}
        />

        {/* Recipient Runtime Entry Boundary

           Route format:

           /capsule/:capsuleId#secret=HEX64

           Fragment secret:
           - never logged
           - never sent to server
           - never stored
           - never indexed
           - processed only inside CapsulePage
        */}
        <Route
          path="/capsule/:capsuleId"
          element={<CapsulePage />}
        />

        {/* Fallback */}
        <Route
          path="*"
          element={<NotFound />}
        />

      </Route>

    </Routes>

  );

}