import { Routes, Route } from "react-router-dom";

import { lazy, Suspense } from "react";

import AppLayout from "@/components/AppLayout";

import Home from "@/pages/Home";
import Protocol from "@/pages/Protocol";
import NotFound from "@/pages/NotFound";

import Create from "@/pages/capsule/Create";
import CapsulePreview from "@/pages/capsule/CapsulePreview";
import CapsulePage from "@/pages/capsule/CapsulePage";
import CapsuleHold from "@/pages/capsule/CapsuleHold";

/**
 * DEV-ONLY diagnostic runner.
 *
 * Guarded by `import.meta.env.DEV` AND a dynamic import, so the module
 * (and its Irys transport dependency edge) is tree-shaken out of the
 * production build entirely: in a production build the ternary resolves
 * to the `null` branch and the `import()` is never emitted.
 */
const IrysProbeDev = import.meta.env.DEV
  ? lazy(() => import("@/pages/dev/IrysProbeDev"))
  : null;

/**
 * DEV-ONLY visual preview (R9-A51).
 *
 * Creator Presence inside the real calendar modal and below the real
 * recipient capsule card, with mock data only. Guarded by
 * `import.meta.env.DEV` AND a dynamic import, exactly like the Irys probe
 * above: in a production build the ternary resolves to `null`, the
 * `import()` is never emitted, and the route below is never registered, so
 * `/dev/calendar-presence-preview` falls through to NotFound.
 */
const CalendarPresencePreview = import.meta.env.DEV
  ? lazy(() => import("@/pages/dev/CalendarPresencePreview"))
  : null;

/*
 * DEV-ONLY recovery preview (R9-A65).
 *
 * Shows the boot supervisor states (attempt 1, attempt 2, recovery panel)
 * and the Emergency Runtime return control with mock data only. Guarded by
 * `import.meta.env.DEV` AND a dynamic import, so a production build neither
 * emits the chunk nor registers the route: `/dev/recovery-preview` falls
 * through to NotFound.
 */
const RecoveryPreview = import.meta.env.DEV
  ? lazy(() => import("@/pages/dev/RecoveryPreview"))
  : null;

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

        {/* DEV-ONLY: Real Irys probe runner. Absent from production build. */}
        {IrysProbeDev && (
          <Route
            path="/__dev/irys-probe"
            element={
              <Suspense fallback={<div>Loading dev probe…</div>}>
                <IrysProbeDev />
              </Suspense>
            }
          />
        )}

        {/* DEV-ONLY: Creator Presence visual preview. Absent from production. */}
        {CalendarPresencePreview && (
          <Route
            path="/dev/calendar-presence-preview"
            element={
              <Suspense fallback={<div>Loading preview…</div>}>
                <CalendarPresencePreview />
              </Suspense>
            }
          />
        )}

        {/* DEV-ONLY: boot recovery preview. Absent from production. */}
        {RecoveryPreview && (
          <Route
            path="/dev/recovery-preview"
            element={
              <Suspense fallback={<div>Loading preview...</div>}>
                <RecoveryPreview />
              </Suspense>
            }
          />
        )}

        {/* Fallback */}
        <Route
          path="*"
          element={<NotFound />}
        />

      </Route>

    </Routes>

  );

}