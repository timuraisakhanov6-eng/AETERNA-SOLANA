import { useMemo, useState } from "react";

/**
 * AETERNA - DEV-ONLY boot recovery preview (R9-A65).
 *
 * Visual twin of the recovery surfaces that ship outside the SPA:
 *
 *   1. `public/boot-recovery.js`  - the in-page recovery panel rendered at
 *      the ORIGINAL capsule URL when startup fails twice;
 *   2. `public/emergency.html`    - the standalone Emergency Runtime, which
 *      now carries a "Back to Main Capsule" control.
 *
 * Those surfaces are plain scripts inside static documents and cannot import
 * React, so their markup is mirrored here for design review. This page is
 * mock data only: no capsule, no storage, no fetch, no wallet, no payment.
 *
 * Excluded from production builds by `import.meta.env.DEV` in App.tsx and by
 * the `return null` guard below (defence in depth).
 */

type PreviewState =
  | "normal"
  | "attempt-1"
  | "attempt-2"
  | "recovery"
  | "emergency";

const STATES: ReadonlyArray<{ key: PreviewState; label: string }> = [
  { key: "normal", label: "Normal app" },
  { key: "attempt-1", label: "Attempt 1" },
  { key: "attempt-2", label: "Attempt 2" },
  { key: "recovery", label: "Recovery panel" },
  { key: "emergency", label: "Emergency view" },
];

/** Mirrors the palette used by the standalone recovery panel. */
const shellStyle = {
  minHeight: "100vh",
  background: "#0d0f14",
  color: "#e8e4dc",
  fontFamily: "system-ui, -apple-system, sans-serif",
  padding: "28px 18px 48px",
} as const;

const cardStyle = {
  width: "100%",
  maxWidth: 400,
  margin: "0 auto",
  padding: "30px 24px",
  border: "1px solid rgba(255,200,140,0.16)",
  borderRadius: 20,
  background:
    "linear-gradient(180deg, rgba(255,200,140,0.05), transparent 70%)",
  textAlign: "center",
} as const;

const primaryButtonStyle = {
  display: "block",
  width: "100%",
  minHeight: 46,
  marginTop: 12,
  padding: "13px 18px",
  borderRadius: 12,
  border: "1px solid rgba(251,191,36,0.75)",
  background: "rgba(251,191,36,0.14)",
  color: "#fde68a",
  font: "inherit",
  fontSize: 14,
  cursor: "pointer",
} as const;

const secondaryButtonStyle = {
  ...primaryButtonStyle,
  border: "1px solid rgba(232,228,220,0.16)",
  background: "transparent",
  color: "rgba(232,228,220,0.72)",
} as const;

function Eyebrow({ children }: { children: string }) {
  return (
    <p
      style={{
        margin: "0 0 14px",
        fontSize: 10,
        letterSpacing: "0.24em",
        textTransform: "uppercase",
        color: "rgba(251,191,36,0.7)",
      }}
    >
      {children}
    </p>
  );
}

function RecoveryPanel() {
  return (
    <div style={cardStyle} data-preview-surface="recovery-panel">
      <Eyebrow>AETERNA</Eyebrow>

      <h1
        style={{
          margin: "0 0 12px",
          fontSize: 20,
          fontWeight: 500,
          lineHeight: 1.35,
        }}
      >
        This capsule view could not start
      </h1>

      <p
        style={{
          margin: 0,
          fontSize: 13,
          lineHeight: 1.7,
          color: "rgba(232,228,220,0.55)",
        }}
      >
        The link in your address bar is unchanged and nothing has been opened
        or altered.
      </p>

      <button type="button" style={primaryButtonStyle} disabled>
        Try Main View Again
      </button>

      <button type="button" style={secondaryButtonStyle} disabled>
        Open Emergency View
      </button>

      <p
        style={{
          margin: "18px 0 0",
          fontSize: 11,
          lineHeight: 1.6,
          color: "rgba(232,228,220,0.3)",
        }}
      >
        Emergency View uses the same decryption, trusted-time and opening
        rules.
      </p>
    </div>
  );
}

function EmergencySurface() {
  return (
    <div style={cardStyle} data-preview-surface="emergency-view">
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 12px",
          marginBottom: 18,
          border: "1px solid rgba(251,191,36,0.25)",
          borderRadius: 999,
          fontSize: 10,
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "#fcd34d",
        }}
      >
        Sealed
      </div>

      <Eyebrow>AETERNA Capsule</Eyebrow>

      <p style={{ margin: "0 0 6px", fontSize: 15, color: "#e8e4dc" }}>
        Mock opening date
      </p>

      <p
        style={{
          margin: "0 0 22px",
          fontSize: 11,
          color: "rgba(232,228,220,0.35)",
        }}
      >
        (preview - no capsule is read)
      </p>

      <button
        type="button"
        style={secondaryButtonStyle}
        data-preview-surface="back-to-capsule"
      >
        Back to Main Capsule
      </button>
    </div>
  );
}

function AttemptCard({ attempt }: { attempt: number }) {
  const exhausted = attempt >= 2;

  return (
    <div style={cardStyle} data-preview-surface={`attempt-${attempt}`}>
      <Eyebrow>Boot supervisor</Eyebrow>

      <h1
        style={{
          margin: "0 0 12px",
          fontSize: 19,
          fontWeight: 500,
          lineHeight: 1.35,
        }}
      >
        {exhausted
          ? "Second recovery attempt"
          : "First recovery attempt"}
      </h1>

      <p
        style={{
          margin: 0,
          fontSize: 13,
          lineHeight: 1.7,
          color: "rgba(232,228,220,0.55)",
        }}
      >
        The application failed to start. Retry {attempt} of 2 is running with a
        short backoff; the address bar still shows the original capsule link.
      </p>

      <dl
        style={{
          margin: "20px 0 0",
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: "8px 14px",
          fontSize: 12,
          textAlign: "left",
          color: "rgba(232,228,220,0.5)",
        }}
      >
        <dt>attempts</dt>
        <dd style={{ margin: 0 }}>{attempt} / 2</dd>
        <dt>phase</dt>
        <dd style={{ margin: 0 }}>recovering</dd>
        <dt>fragment</dt>
        <dd style={{ margin: 0 }}>held by the browser only</dd>
      </dl>
    </div>
  );
}

function NormalCard() {
  return (
    <div style={cardStyle} data-preview-surface="normal">
      <Eyebrow>AETERNA Capsule</Eyebrow>

      <p style={{ margin: "0 0 8px", fontSize: 15 }}>
        Cryptographic opening in progress…
      </p>

      <p
        style={{
          margin: 0,
          fontSize: 12,
          lineHeight: 1.7,
          color: "rgba(232,228,220,0.4)",
        }}
      >
        The supervisor is waiting for `aeterna:mounted`. No panel is shown while
        the application is healthy, however slow the network is.
      </p>
    </div>
  );
}

export default function RecoveryPreview() {
  /*
   * Hooks run unconditionally so the hook order is stable; the DEV guard
   * below is the defence-in-depth check (App.tsx already keeps this page out
   * of every production build graph).
   */
  const [state, setState] = useState<PreviewState>("normal");

  const surface = useMemo(() => {
    switch (state) {
      case "attempt-1":
        return <AttemptCard attempt={1} />;
      case "attempt-2":
        return <AttemptCard attempt={2} />;
      case "recovery":
        return <RecoveryPanel />;
      case "emergency":
        return <EmergencySurface />;
      default:
        return <NormalCard />;
    }
  }, [state]);

  if (!import.meta.env.DEV) {
    return null;
  }

  return (
    <div style={shellStyle}>
      <div style={{ maxWidth: 400, margin: "0 auto 24px" }}>
        <p
          style={{
            margin: "0 0 12px",
            fontSize: 10,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: "rgba(232,228,220,0.35)",
          }}
        >
          Dev preview - mock data only
        </p>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {STATES.map((entry) => {
            const active = entry.key === state;

            return (
              <button
                key={entry.key}
                type="button"
                onClick={() => setState(entry.key)}
                aria-pressed={active}
                style={{
                  padding: "7px 11px",
                  borderRadius: 999,
                  fontSize: 11,
                  cursor: "pointer",
                  border: active
                    ? "1px solid rgba(251,191,36,0.8)"
                    : "1px solid rgba(232,228,220,0.14)",
                  background: active
                    ? "rgba(251,191,36,0.14)"
                    : "transparent",
                  color: active ? "#fde68a" : "rgba(232,228,220,0.6)",
                }}
              >
                {entry.label}
              </button>
            );
          })}
        </div>
      </div>

      {surface}
    </div>
  );
}