/**
 * ==================================================================
 * AETERNA — BROWSER-SIDE REAL IRYS PROBE (DEV-ONLY RUNNER)
 * ==================================================================
 *
 * *** PREPARED, NOT RUN. NO SIGNATURE IS REQUESTED ON LOAD. ***
 *
 * This page exists ONLY as an operator-run diagnostic. It has a single
 * explicit "RUN" entry point and performs NOTHING until that button is
 * pressed and its confirmation dialog is accepted.
 *
 * ── WHAT IT DOES ──
 *   • prechecks (see PRECHECKS) BEFORE any signature or upload
 *   • Mode A: C=1, 2 sequential uploads × 8 KiB
 *   • Mode B: C=2, 2 concurrent uploads × 8 KiB
 *   Total maximum payload: 4 × 8192 = 32768 bytes.
 *   Each upload: wallet.signMessage (data-item signing) → Irys upload.
 *
 * ── WHAT IT NEVER DOES ──
 *   ✗ fund()            ✗ sendTransaction / signAndSendTransaction
 *   ✗ service payment   ✗ storage payment        ✗ new quote
 *   ✗ new capsule       ✗ publication claim      ✗ seal
 *   ✗ Creator Credit    ✗ lifecycle              ✗ any /api/* call
 *   It imports ONLY `uploadCreatorData` (the bare data-item transport).
 *   It deliberately does NOT import `creatorIrysStorage`, whose
 *   `uploadChunk` appends a `claimPublication` call after the upload.
 *   It also does NOT import `uploadCreatorPaid`, which can call `fund()`.
 *
 * Production build: EXCLUDED. The route is registered behind
 * `import.meta.env.DEV` via a lazy import in App.routes, so the bundle
 * never contains this module.
 * ==================================================================
 */

import { useCallback, useMemo, useRef, useState } from "react";

import {
  uploadCreatorData,
  type CreatorIrysWallet,
} from "@/lib/storage/creatorIrys";

/* ─────────────────────────── CONSTANTS ─────────────────────────── */

const PAYLOAD_BYTES = 8 * 1024; // 8 KiB per upload
const MODE_A_UPLOADS = 2; // C=1
const MODE_B_UPLOADS = 2; // C=2
const MAX_TOTAL_PAYLOAD_BYTES = 32 * 1024; // 32 KiB hard cap

/** Balance endpoint is READ-ONLY (GET). Never a mutation. */
const BALANCE_URL = "https://uploader.irys.xyz/account/balance/usdc-solana";

/* ─────────────────────────── TYPES ─────────────────────────── */

interface UploadRecord {
  readonly mode: "A" | "B";
  readonly index: number;
  readonly concurrency: number;
  readonly signMs: number | null;
  readonly uploadMs: number | null;
  readonly totalMs: number | null;
  readonly status: number | null;
  readonly dataTxId: string | null;
  readonly error: string | null;
}

interface PrecheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

interface ModeReport {
  readonly mode: "A" | "B";
  readonly concurrency: number;
  readonly startIso: string;
  readonly endIso: string;
  readonly totalMs: number;
  readonly uploads: readonly UploadRecord[];
  readonly errors: number;
  readonly http429: number;
  readonly http5xx: number;
  readonly providerErrors: readonly string[];
}

/* ─────────────────────────── PRECHECKS ─────────────────────────── */

/**
 * Runs BEFORE any signature or upload. Any failure aborts the run with
 * zero signatures requested.
 *
 * Checks 1-8 from the operator spec.
 */
async function runPrechecks(): Promise<{
  results: PrecheckResult[];
  ok: boolean;
  wallet: CreatorIrysWallet | null;
  account: string | null;
  balanceAtomic: string | null;
}> {
  const results: PrecheckResult[] = [];
  const push = (name: string, ok: boolean, detail: string) =>
    results.push({ name, ok, detail });

  // 1. window exists
  const hasWindow = typeof window !== "undefined";
  push("window exists", hasWindow, hasWindow ? "present" : "MISSING");

  // 2. location.origin exists
  const origin = hasWindow && typeof location !== "undefined" ? location.origin : "";
  const hasOrigin = origin.length > 0;
  push("location.origin exists", hasOrigin, hasOrigin ? origin : "MISSING");

  // 3. Phantom provider exists
  const provider = hasWindow
    ? (window as unknown as { solana?: unknown; phantom?: { solana?: unknown } }).solana ??
      (window as unknown as { phantom?: { solana?: unknown } }).phantom?.solana
    : undefined;
  const hasProvider = Boolean(provider);
  push("Phantom/provider exists", hasProvider, hasProvider ? "present" : "MISSING");

  const p = provider as
    | {
        publicKey?: { toString(): string };
        signMessage?: (m: Uint8Array) => Promise<{ signature: Uint8Array }>;
        signAndSendTransaction?: unknown;
        signTransaction?: unknown;
        sendTransaction?: unknown;
      }
    | undefined;

  // 4. provider supports signMessage
  const hasSignMessage = typeof p?.signMessage === "function";
  push("provider supports signMessage", hasSignMessage, hasSignMessage ? "yes" : "NO");

  const account = p?.publicKey ? String(p.publicKey) : null;
  push("wallet connected (publicKey)", Boolean(account), account ?? "NOT CONNECTED");

  // 8. no funding capability exposed/used
  //    We only ever pass signMessage through. Record whether the
  //    provider even has funding surfaces — informational, never used.
  const fundingSurfaces = [
    p?.signAndSendTransaction ? "signAndSendTransaction" : null,
    p?.signTransaction ? "signTransaction" : null,
    p?.sendTransaction ? "sendTransaction" : null,
  ].filter(Boolean);
  push(
    "no funding capability used",
    true,
    fundingSurfaces.length === 0
      ? "provider exposes none; none used"
      : `provider exposes [${fundingSurfaces.join(", ")}] — will NOT be called`
  );

  // Wallet adapter — built ONLY from signMessage; no sendTransaction field.
  let wallet: CreatorIrysWallet | null = null;
  if (hasProvider && hasSignMessage && account) {
    try {
      wallet = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        publicKey: (p as any).publicKey,
        signMessage: (m: Uint8Array) => p!.signMessage!(m).then((r) => r.signature),
        // NOTE: sendTransaction is intentionally OMITTED, so the Irys SDK
        // structurally cannot fund from this harness.
      };
      push("Irys wallet adapter built (signMessage only)", true, "ok");
    } catch (err) {
      push(
        "Irys wallet adapter built (signMessage only)",
        false,
        err instanceof Error ? err.message : String(err)
      );
    }
  } else {
    push("Irys wallet adapter built (signMessage only)", false, "prerequisites missing");
  }

  // 5. Irys uploader constructible — validated lazily by the first real
  //    upload; here we only assert the transport helper exists.
  push(
    "Irys upload helper present",
    typeof uploadCreatorData === "function",
    typeof uploadCreatorData === "function" ? "yes" : "NO"
  );

  // 7. planned budget
  const budget = MODE_A_UPLOADS * PAYLOAD_BYTES + MODE_B_UPLOADS * PAYLOAD_BYTES;
  push(
    "planned budget = 32768 bytes max",
    budget <= MAX_TOTAL_PAYLOAD_BYTES,
    `${budget} bytes (cap ${MAX_TOTAL_PAYLOAD_BYTES})`
  );

  // 6. prepaid Irys balance readable (READ-ONLY GET)
  let balanceAtomic: string | null = null;
  if (account) {
    try {
      const res = await fetch(`${BALANCE_URL}?address=${encodeURIComponent(account)}`, {
        method: "GET",
        cache: "no-store",
      });
      if (res.ok) {
        const json = (await res.json()) as { balance?: unknown };
        if (json?.balance !== undefined) {
          balanceAtomic = String(json.balance);
          push("prepaid Irys balance readable", true, `${balanceAtomic} atomic`);
        } else {
          push("prepaid Irys balance readable", false, "malformed body");
        }
      } else {
        push("prepaid Irys balance readable", false, `HTTP ${res.status}`);
      }
    } catch (err) {
      push(
        "prepaid Irys balance readable",
        false,
        err instanceof Error ? err.message : String(err)
      );
    }
  } else {
    push("prepaid Irys balance readable", false, "no wallet account");
  }

  const ok = results.every((r) => r.ok);
  return { results, ok, wallet, account, balanceAtomic };
}

/* ─────────────────────────── UPLOAD CORE ─────────────────────────── */

/**
 * One measured upload: sign inside uploadCreatorData, then network.
 *
 * Signing happens INSIDE the SDK (chunkingUploader.js:270). We cannot
 * separate it at the SDK boundary, so we time it by wrapping the wallet's
 * signMessage: its duration is the signature time; the remainder of the
 * call is upload/network. This is an approximation and is LABELLED as
 * such in the report.
 */
async function measuredUpload(
  wallet: CreatorIrysWallet,
  signAccumulator: { ms: number }
): Promise<UploadRecord & { mode: "A" | "B"; index: number; concurrency: number }> {
  const data = new Uint8Array(PAYLOAD_BYTES);
  const t0 = performance.now();

  const wrapped: CreatorIrysWallet = {
    publicKey: wallet.publicKey,
    signMessage: async (m: Uint8Array) => {
      const s0 = performance.now();
      const sig = await wallet.signMessage(m);
      signAccumulator.ms += performance.now() - s0;
      return sig;
    },
  };

  try {
    const { dataTxId } = await uploadCreatorData(data, wrapped);
    const totalMs = performance.now() - t0;
    const signMs = signAccumulator.ms;
    return {
      mode: "A",
      index: -1,
      concurrency: 1,
      signMs,
      uploadMs: Math.max(0, totalMs - signMs),
      totalMs,
      status: 200,
      dataTxId,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = /HTTP_(\d{3})/.exec(message)?.[1];
    return {
      mode: "A",
      index: -1,
      concurrency: 1,
      signMs: signAccumulator.ms || null,
      uploadMs: null,
      totalMs: performance.now() - t0,
      status: status ? Number(status) : null,
      dataTxId: null,
      error: message,
    };
  } finally {
    data.fill(0);
  }
}

/** C=1 — two strictly sequential uploads. */
async function runModeA(wallet: CreatorIrysWallet): Promise<ModeReport> {
  const startIso = new Date().toISOString();
  const t0 = performance.now();
  const uploads: UploadRecord[] = [];
  const providerErrors: string[] = [];
  let http429 = 0;
  let http5xx = 0;
  let errors = 0;

  for (let i = 0; i < MODE_A_UPLOADS; i++) {
    const signAcc = { ms: 0 };
    const rec = await measuredUpload(wallet, signAcc);
    const labelled: UploadRecord = { ...rec, mode: "A", index: i, concurrency: 1 };
    uploads.push(labelled);
    if (labelled.error) {
      errors += 1;
      if (labelled.status === 429) http429 += 1;
      else if (labelled.status && labelled.status >= 500) http5xx += 1;
      else providerErrors.push(labelled.error);
    }
  }

  return {
    mode: "A",
    concurrency: 1,
    startIso,
    endIso: new Date().toISOString(),
    totalMs: performance.now() - t0,
    uploads,
    errors,
    http429,
    http5xx,
    providerErrors,
  };
}

/** C=2 — two concurrent uploads (bounded: exactly 2 in flight). */
async function runModeB(wallet: CreatorIrysWallet): Promise<ModeReport> {
  const startIso = new Date().toISOString();
  const t0 = performance.now();
  const providerErrors: string[] = [];

  const signAccs = Array.from({ length: MODE_B_UPLOADS }, () => ({ ms: 0 }));

  const results = await Promise.all(
    signAccs.map((acc) => measuredUpload(wallet, acc))
  );

  const uploads: UploadRecord[] = results.map((r, i) => ({
    ...r,
    mode: "B",
    index: i,
    concurrency: 2,
  }));

  let errors = 0;
  let http429 = 0;
  let http5xx = 0;
  for (const u of uploads) {
    if (u.error) {
      errors += 1;
      if (u.status === 429) http429 += 1;
      else if (u.status && u.status >= 500) http5xx += 1;
      else providerErrors.push(u.error);
    }
  }

  return {
    mode: "B",
    concurrency: 2,
    startIso,
    endIso: new Date().toISOString(),
    totalMs: performance.now() - t0,
    uploads,
    errors,
    http429,
    http5xx,
    providerErrors,
  };
}

/* ─────────────────────────── COMPONENT ─────────────────────────── */

export default function IrysProbeDev() {
  const [prechecks, setPrechecks] = useState<PrecheckResult[] | null>(null);
  const [wallet, setWallet] = useState<CreatorIrysWallet | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [balanceBefore, setBalanceBefore] = useState<string | null>(null);
  const [balanceAfter, setBalanceAfter] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [reports, setReports] = useState<ModeReport[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);
  const abortRef = useRef(false);

  const precheckOk = useMemo(
    () => prechecks !== null && prechecks.every((r) => r.ok),
    [prechecks]
  );

  const doPrecheck = useCallback(async () => {
    setFatal(null);
    setReports([]);
    setBalanceAfter(null);
    const res = await runPrechecks();
    setPrechecks(res.results);
    setWallet(res.wallet);
    setAccount(res.account);
    setBalanceBefore(res.balanceAtomic);
  }, []);

  const readBalance = useCallback(async (): Promise<string | null> => {
    if (!account) return null;
    try {
      const res = await fetch(`${BALANCE_URL}?address=${encodeURIComponent(account)}`, {
        method: "GET",
        cache: "no-store",
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { balance?: unknown };
      return json?.balance !== undefined ? String(json.balance) : null;
    } catch {
      return null;
    }
  }, [account]);

  const doRun = useCallback(async () => {
    if (!wallet || !precheckOk) {
      setFatal("Prechecks not passing — run precheck first.");
      return;
    }

    const confirmed = window.confirm(
      "Real Irys probe: Phantom will request message signatures and " +
        "32 KiB maximum of existing prepaid Irys balance may be consumed.\n\n" +
        "Signatures expected: 4 (one per data item).\n" +
        "No funding, no sendTransaction, no AETERNA state change.\n\n" +
        "Proceed?"
    );
    if (!confirmed) return;

    setRunning(true);
    setFatal(null);
    setReports([]);
    abortRef.current = false;

    try {
      const afterA = await runModeA(wallet);
      setReports((prev) => [...prev, afterA]);
      if (abortRef.current) return;

      const afterB = await runModeB(wallet);
      setReports((prev) => [...prev, afterB]);

      setBalanceAfter(await readBalance());
    } catch (err) {
      setFatal(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [wallet, precheckOk, readBalance]);

  /* ─────────────── styles (inline, no dependency) ─────────────── */

  const box: React.CSSProperties = {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 13,
    lineHeight: 1.55,
    padding: 24,
    maxWidth: 900,
    margin: "0 auto",
  };
  const warn: React.CSSProperties = {
    border: "1px solid #b45309",
    background: "#451a03",
    color: "#fde68a",
    padding: 12,
    borderRadius: 6,
    marginBottom: 16,
  };
  const btn: React.CSSProperties = {
    padding: "8px 16px",
    borderRadius: 4,
    border: "1px solid #555",
    background: "#1f2937",
    color: "#e5e7eb",
    cursor: "pointer",
    marginRight: 8,
  };
  const ok = { color: "#4ade80" };
  const bad = { color: "#f87171" };

  return (
    <div style={box}>
      <h1 style={{ fontSize: 18 }}>AETERNA — Real Irys Probe (DEV ONLY)</h1>

      <div style={warn}>
        Real Irys probe: Phantom will request message signatures and{" "}
        <strong>32 KiB maximum</strong> of existing prepaid Irys balance may be
        consumed. No funding. No payment. No AETERNA state change.
      </div>

      <p>
        <button style={btn} onClick={doPrecheck} disabled={running}>
          RUN PRECHECK
        </button>
        <button style={btn} onClick={doRun} disabled={!precheckOk || running}>
          RUN PROBE
        </button>
        {running && <span>running…</span>}
      </p>

      {prechecks && (
        <section>
          <h2 style={{ fontSize: 15 }}>Prechecks</h2>
          <ul style={{ listStyle: "none", paddingLeft: 0 }}>
            {prechecks.map((r) => (
              <li key={r.name} style={r.ok ? ok : bad}>
                {r.ok ? "PASS" : "FAIL"} — {r.name} <em>({r.detail})</em>
              </li>
            ))}
          </ul>
          {!precheckOk && (
            <p style={bad}>
              STOP: a precheck failed. No signature will be requested and no
              upload will occur.
            </p>
          )}
        </section>
      )}

      {fatal && <p style={bad}>FATAL: {fatal}</p>}

      {reports.length > 0 && (
        <section>
          <h2 style={{ fontSize: 15 }}>Results</h2>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={th}>Mode</th>
                <th style={th}>Uploads</th>
                <th style={th}>Total</th>
                <th style={th}>Per upload</th>
                <th style={th}>Errors</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.mode}>
                  <td style={td}>
                    C={r.concurrency}
                  </td>
                  <td style={td}>{r.uploads.length}</td>
                  <td style={td}>{r.totalMs.toFixed(1)}ms</td>
                  <td style={td}>
                    {r.uploads
                      .map(
                        (u) =>
                          `sign ${u.signMs?.toFixed(0) ?? "?"} / net ${
                            u.uploadMs?.toFixed(0) ?? "?"
                          }`
                      )
                      .join(" · ")}
                  </td>
                  <td style={td}>
                    {r.errors} (429:{r.http429} 5xx:{r.http5xx})
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 style={{ fontSize: 14 }}>Raw</h3>
          <pre style={{ whiteSpace: "pre-wrap", background: "#111827", padding: 12 }}>
            {JSON.stringify({ balanceBefore, balanceAfter, reports }, null, 2)}
          </pre>

          <p>
            Balance before: <strong>{balanceBefore ?? "n/a"}</strong> ·
            Balance after: <strong>{balanceAfter ?? "n/a"}</strong>
          </p>
        </section>
      )}
    </div>
  );
}

const th: React.CSSProperties = {
  border: "1px solid #374151",
  padding: "6px 10px",
  textAlign: "left",
};
const td: React.CSSProperties = {
  border: "1px solid #374151",
  padding: "6px 10px",
  verticalAlign: "top",
};
