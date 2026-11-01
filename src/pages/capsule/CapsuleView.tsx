import type { OpenAtUtc } from "@/types/manifest";
import { useState, useMemo, useEffect, useRef, useId } from "react";
import { motion } from "framer-motion";
import { BrandMark } from "@/components/BrandMark";
import {
  ShieldCheck as ShieldIcon,
  Lock as LockIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CreatorPresenceLink,
  CREATOR_PRESENCE_RECIPIENT_LABEL,
} from "@/components/capsule/presence/CreatorPresenceNotice";
import { getUiTime } from "@/lib/utils/getUiTime";
import QRCode from "qrcode";
import type { ConfirmPresenceResult } from "@/lib/heartbeat/confirmPresence";
import { resolveConfirmAvailability } from "@/lib/heartbeat/confirmAvailability";
import {
  HEARTBEAT_COOLDOWN_MS,
  heartbeatCooldownKey,
  remainingCooldownMs,
  runConfirmPresenceAttempt,
  purgeLegacyCooldown,
  clearInvalidConfirmedRecord,
} from "@/lib/heartbeat/confirmPresenceCooldown";

/* ===== TYPES ===== */

export type CapsuleViewState =
  | {
      status: "preview";

      capsuleId: string;

      authorityMode?: boolean;

      /**
       * R9-A53 - manifest.heartbeatInterval: the ORIGINAL opening interval
       * fixed at sealing time. Selects which availability rule applies
       * (<= 30 days: always available; > 30 days: final-30-days window).
       */
      heartbeatInterval?: number;

      /**
       * R9-A53 - trusted "now" (UTC ms) from the existing Time Authority.
       * Supplied by CapsuleController from the instant it already fetches
       * for the open check. Deliberately nullable: absent trusted time must
       * never be replaced by the device clock.
       */
      trustedNowMs?: number | null;

      onConfirmPresence?: () => Promise<ConfirmPresenceResult>;

      title?: string;

      openAt: OpenAtUtc;

      shareUrl: string;

      creatorShareUrl?: string | undefined;

      onCopyLink: () => void;

      onCopyCreatorLink?: (() => void) | undefined;

      onPrint: () => void;

      onCreate?: () => void;
    }
  | { status: "checking" }
  | { status: "recovering" }
  | { status: "opening" }
  | {
      status: "opened";
      authorityMode?: boolean;
      content: React.ReactNode;
    };

type Props = {
  state: CapsuleViewState;
  className?: string;
};

/* ===== CONSTANTS ===== */

const MAX_URL_LENGTH = 2000;

/* ===== FORMATTERS ===== */

const formatUTCDate = (ts: number) => {
  if (!Number.isFinite(ts)) return "Invalid date";
  return new Date(ts).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    timeZone: "UTC",
  });
};

const daysUntilFrom = (ts: number, now: number) => {
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return 0;
  const diffMs = ts - now;
  return Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
};

/* ===== MAIN COMPONENT ===== */

export default function CapsuleView({ state, className }: Props) {

  /**
   * R9-A55 - id for the static "CREATOR PRESENCE" caption above the button.
   * Declared with the other top-level hooks: the component returns early for
   * the opened/checking/opening states, so a hook introduced further down
   * would run conditionally.
   */
  const confirmCaptionId =
    useId();

  const [copied, setCopied] = useState(false);
  const [copiedCreator, setCopiedCreator] = useState(false);
  const [confirmSuccess, setConfirmSuccess] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [heartbeatCooldownActive, setHeartbeatCooldownActive] = useState(false);
  const [confirmFeedback, setConfirmFeedback] = useState<
    "rejected" | "expired" | "network-error" | null
  >(null);

  const heartbeatCooldownKeyValue =
    state.status === "preview"
      ? heartbeatCooldownKey(state.capsuleId)
      : "";
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyCreatorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [trustedNow, setTrustedNow] = useState<number>(0);

  const [recipientQrUrl, setRecipientQrUrl] = useState<string>("");
  const [creatorQrUrl, setCreatorQrUrl] = useState<string>("");

  const activateHeartbeatCooldown = (durationMs: number) => {
    setHeartbeatCooldownActive(true);
    if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current);
    cooldownTimerRef.current = setTimeout(() => {
      setHeartbeatCooldownActive(false);
    }, durationMs);
  };

  useEffect(() => {
    let cancelled = false;

    const update = async () => {
      try {
        const { nowUtc } = await getUiTime();
        if (!cancelled) setTrustedNow(nowUtc);
      } catch {
        // fall back silently
      }
    };

    update();

    const id = setInterval(update, 60_000);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    if (copyCreatorTimerRef.current) clearTimeout(copyCreatorTimerRef.current);
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current);
  }, []);

  useEffect(() => {
    if (!heartbeatCooldownKeyValue) return;
    // HARDENING (v2): the legacy unversioned key was written on ANY
    // outcome by an earlier buggy build and is NEVER trustworthy.
    // Purge it (best-effort) so it can never arm a cooldown.
    purgeLegacyCooldown(localStorage, state.status === "preview" ? state.capsuleId : "");
    // Drop a corrupt / wrong-version v2 value so it cannot linger.
    clearInvalidConfirmedRecord(localStorage, heartbeatCooldownKeyValue);
    // Restore the cooldown ONLY from a valid v2 SUCCESSFUL
    // confirmation record. A malformed / absent value yields 0.
    const remaining = remainingCooldownMs(
      localStorage,
      heartbeatCooldownKeyValue,
      Date.now()
    );
    if (remaining > 0) {
      activateHeartbeatCooldown(remaining);
    }
  // heartbeatCooldownKeyValue is the derived capsule-scoped key; the
  // effect must re-run only when that key changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heartbeatCooldownKeyValue]);

  const openAtPrimitive = state.status === "preview" ? state.openAt : 0;
  const daysLeft = useMemo(
    () => daysUntilFrom(openAtPrimitive, trustedNow),
    [openAtPrimitive, trustedNow]
  );

  const authorityMode =
    state.status === "preview" || state.status === "opened"
      ? !!state.authorityMode
      : false;

  /* ===== SHARE URL SANITIZE ===== */

  const safeShareUrl =
    state.status === "preview" &&
    typeof state.shareUrl === "string" &&
    state.shareUrl.length > 0 &&
    state.shareUrl.includes("#")
      ? state.shareUrl.slice(0, MAX_URL_LENGTH)
      : "";

  const safeCreatorShareUrl =
    state.status === "preview" &&
    typeof state.creatorShareUrl === "string" &&
    state.creatorShareUrl.length > 0 &&
    state.creatorShareUrl.includes("#")
      ? state.creatorShareUrl.slice(0, MAX_URL_LENGTH)
      : "";

  const printUrl = authorityMode && safeCreatorShareUrl
    ? safeCreatorShareUrl
    : safeShareUrl;

  /* ===== QR CODE ===== */

  useEffect(() => {

    let cancelled = false;

    const generateQr = async () => {

      if (!safeShareUrl) {
        setRecipientQrUrl("");
        return;
      }

      try {
        const url = await QRCode.toDataURL(safeShareUrl, { margin: 1, width: 420 });
        if (!cancelled) setRecipientQrUrl(url);
      } catch {
        if (!cancelled) setRecipientQrUrl("");
      }

    };

    generateQr();
    return () => { cancelled = true; };

  }, [safeShareUrl]);

  useEffect(() => {

    let cancelled = false;

    const generateQr = async () => {

      if (!safeCreatorShareUrl) {
        setCreatorQrUrl("");
        return;
      }

      try {
        const url = await QRCode.toDataURL(safeCreatorShareUrl, { margin: 1, width: 420 });
        if (!cancelled) setCreatorQrUrl(url);
      } catch {
        if (!cancelled) setCreatorQrUrl("");
      }

    };

    generateQr();
    return () => { cancelled = true; };

  }, [safeCreatorShareUrl]);

  /* ===== OPENED ===== */

  if (state.status === "opened") {
    return (
      <div className={cn("min-h-screen bg-background text-foreground p-4 md:p-6", className)}>
        {state.content}
      </div>
    );
  }

  /* ===== CHECKING — neutral loading before sealed/open decision ===== */

  if (state.status === "checking") {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background text-foreground gap-4">
        <LockIcon size={48} className="text-amber-500 animate-pulse" />
        <p className="text-sm tracking-wider uppercase text-muted-foreground font-medium">
          Opening capsule…
        </p>
      </div>
    );
  }

  /* ===== RECOVERING — retryable recipient failure, still fail-closed ===== */

  if (state.status === "recovering") {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background text-foreground gap-4 p-6">
        <LockIcon size={48} className="text-amber-500 animate-pulse" />
        <p role="status" className="text-sm tracking-wider uppercase text-muted-foreground font-medium text-center">
          Capsule could not be loaded. Retrying…
        </p>
      </div>
    );
  }

  /* ===== OPENING ===== */

  if (state.status === "opening") {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background text-foreground gap-4">
        <LockIcon size={48} className="text-amber-500 animate-pulse" />
        <p className="text-sm tracking-wider uppercase text-muted-foreground font-medium">
          Cryptographic opening in progress…
        </p>
      </div>
    );
  }

  /* ===== FAIL CLOSED ===== */

  if (state.status !== "preview") return null;

  /* ===== COPY HANDLERS ===== */

  const handleCopy = () => {
    try {
      state.onCopyLink();
    } catch {
      console.warn("[AETERNA] Clipboard unavailable");
    }
    setCopied(true);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopied(false), 1800);
  };

  const handleCopyCreator = () => {
    if (!state.onCopyCreatorLink) return;
    try {
      state.onCopyCreatorLink();
    } catch {
      console.warn("[AETERNA] Clipboard unavailable");
    }
    setCopiedCreator(true);
    if (copyCreatorTimerRef.current) clearTimeout(copyCreatorTimerRef.current);
    copyCreatorTimerRef.current = setTimeout(() => setCopiedCreator(false), 1800);
  };

  /* ===== CONFIRM HANDLER ===== */

  const handleConfirmPresence = state.onConfirmPresence;

  /**
   * R9-A53 - visual availability, mirroring the server's 30-day window
   * rule. Trusted time only; when it is unknown the rule reports
   * "available" and the server keeps the final say.
   */
  const confirmAvailability =
    resolveConfirmAvailability({
      heartbeatInterval: state.heartbeatInterval,
      effectiveOpenAt: state.openAt,
      trustedNowMs: state.trustedNowMs,
    });

  const confirmAwaitingWindow =
    confirmAvailability.awaitingWindow;

  const confirmUnknown =
    confirmAvailability.unknown;

  /**
   * R9-A54 - resting label.
   *
   * While the 30-day window is still closed the button carries the live
   * countdown ("Available in 60 days"); when the verdict cannot be computed
   * it reads "Checking availability…" instead of guessing. Existing
   * transient states keep their exact labels and precedence.
   */
  const confirmLabel =
    confirming
      ? "CONFIRMING..."
      : confirmSuccess
        ? "CONFIRMED ✓"
        : heartbeatCooldownActive
          ? "WAIT 15 MIN"
          : confirmAwaitingWindow &&
              confirmAvailability.waitDays !== null
            ? `AVAILABLE IN ${confirmAvailability.waitDays} ${
                confirmAvailability.waitDays === 1 ? "DAY" : "DAYS"
              }`
            : confirmUnknown
              ? "CHECKING AVAILABILITY…"
              : "CONFIRM PRESENCE";

  const handleConfirmPresenceClick = async () => {

    if (!handleConfirmPresence)
      return;

    if (confirming)
      return;

    // Guard + invoke + cooldown arming are owned by the single pure
    // helper. The click is blocked ONLY by an ACTIVE cooldown backed
    // by a persisted SUCCESSFUL confirmation timestamp; the cooldown
    // arms ONLY on a "confirmed" result.
    setConfirming(true);
    // A new attempt invalidates feedback from the previous one.
    setConfirmFeedback(null);

    try {

      const outcome = await runConfirmPresenceAttempt({
        handler: handleConfirmPresence,
        storage: localStorage,
        key: heartbeatCooldownKeyValue,
        nowMs: () => Date.now(),
        legacyCapsuleId:
          state.status === "preview" ? state.capsuleId : "",
        onConfirmed: () => {
          setConfirmSuccess(true);
          setConfirmFeedback(null);
          activateHeartbeatCooldown(HEARTBEAT_COOLDOWN_MS);

          if (confirmTimerRef.current)
            clearTimeout(confirmTimerRef.current);

          confirmTimerRef.current =
            setTimeout(
              () => setConfirmSuccess(false),
              3000
            );
        },
      });

      // Creator-facing feedback: only non-success, non-cooldown
      // outcomes surface a message. A blocked attempt is already
      // communicated by the WAIT 15 MIN label, and a confirmed
      // attempt by onConfirmed above. Fixed public strings only —
      // no exceptions, fragments, or server details are surfaced.
      if (!outcome.blocked && !outcome.confirmed) {
        if (
          outcome.result === "rejected" ||
          outcome.result === "expired" ||
          outcome.result === "network-error"
        ) {
          setConfirmFeedback(outcome.result);
        }
      }

    } catch {

      // runConfirmPresenceAttempt never throws for a handler error
      // (it maps to "network-error"); this guards only against an
      // unexpected internal fault so the button can never stick.

    } finally {

      setConfirming(false);

    }

  };

  /* ===== PREVIEW RENDER ===== */

  return (
    <>
      {/* ── SCREEN ── */}
      <div
        className={cn(
          "min-h-screen flex flex-col items-center justify-between px-6 py-16 relative overflow-hidden print:hidden",
          className
        )}
      >

        <div aria-hidden />

        <motion.div
          initial={{ opacity: 0, scale: 0.88, filter: "blur(18px)" }}
          animate={{ opacity: 1, scale: 1,   filter: "blur(0px)"  }}
          transition={{ duration: 1.6, ease: [0.16, 1, 0.3, 1] }}
          className="
            relative z-10 w-full
            max-w-[300px]
            sm:max-w-[340px]
            md:max-w-[380px]
            lg:max-w-[420px]
            xl:max-w-[460px]
            2xl:max-w-[500px]
          "
        >
          {/* ── Capsule card ── */}
          <div
            className="
              relative
              rounded-[72px]
              sm:rounded-[80px]
              xl:rounded-[100px]
              border
              border-amber-500/40
              dark:border-amber-400/30
              bg-gradient-to-b
              from-[hsl(220,35%,10%)]
              via-[hsl(220,35%,7%)]
              to-[hsl(220,35%,5%)]
              shadow-[inset_0_1px_0_rgba(255,200,140,0.08)]
              shadow-[0_0_0_1px_rgba(255,180,90,0.12),0_0_70px_rgba(255,180,90,0.22)]
              dark:shadow-[0_0_0_1px_rgba(255,180,90,0.1),0_0_60px_rgba(255,180,90,0.16)]
              px-7
              pt-12
              pb-14
              sm:px-8
              sm:pt-14
              sm:pb-16
              md:pt-16
              md:pb-18
              lg:px-10
              lg:pt-18
              lg:pb-20
              xl:px-12
              xl:pt-20
              xl:pb-24
            "
          >
            <div className="flex flex-col items-center text-center">

              {/* AETERNA brand mark — heartbeat pulse (R9-A83) */}
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.8, delay: 0.15 }}
                className="mb-5 xl:mb-6 relative flex items-center justify-center"
              >
                {/* Glow ring */}
                <motion.div
                  aria-hidden
                  className="absolute inset-0 rounded-full bg-amber-400/25 blur-md"
                  animate={{
                    opacity: [0, 0.85, 0.12, 0.5, 0, 0, 0, 0, 0, 0],
                    scale:   [0.8, 1.1,  1.3,  1.1, 1.6, 1.6, 1.6, 1.6, 1.6, 0.8],
                  }}
                  transition={{
                    duration: 1.4,
                    repeat: Infinity,
                    ease: "easeOut",
                    times: [0, 0.08, 0.2, 0.28, 0.4, 0.5, 0.6, 0.7, 0.9, 1],
                  }}
                />

                {/* Circular brand mark */}
                <motion.div
                  className="relative z-10 w-14 h-14 sm:w-16 sm:h-16 xl:w-[72px] xl:h-[72px]"
                  animate={{ scale: [1, 1.18, 0.97, 1.09, 1, 1, 1, 1, 1, 1] }}
                  transition={{
                    duration: 1.4,
                    repeat: Infinity,
                    ease: "easeOut",
                    times: [0, 0.08, 0.16, 0.26, 0.38, 0.5, 0.6, 0.7, 0.85, 1],
                  }}
                >
                  <BrandMark className="w-full h-full" />
                </motion.div>
              </motion.div>

              {/* SEALED badge */}
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.8, delay: 0.2 }}
                className="mb-6 xl:mb-8"
              >
                <motion.div
                  role="status"
                  aria-label="Capsule sealed"
                  animate={{ opacity: [0.6, 0.9, 0.6] }}
                  transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
                  className="flex items-center gap-1.5 text-red-600 dark:text-red-500"
                >
                  <ShieldIcon
                    size={13}
                    className="sm:w-[14px] sm:h-[14px] xl:w-[15px] xl:h-[15px]"
                  />
                  <span
                    className="
                      text-[11px]
                      sm:text-[12px]
                      xl:text-[13px]
                      font-medium
                      tracking-[0.2em]
                    "
                  >
                    SEALED
                  </span>
                </motion.div>
              </motion.div>

              {/* Title */}
              <motion.h1
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, delay: 0.3 }}
                className="
                  font-display
                  text-[22px]
                  sm:text-[24px]
                  md:text-[27px]
                  xl:text-[30px]
                  font-medium
                  text-amber-50
                  tracking-[0.18em]
                  mb-3
                "
              >
                AETERNA CAPSULE
              </motion.h1>

              {/* Description */}
              <motion.p
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, delay: 0.4 }}
                className="
                  text-amber-100/70
                  italic
                  text-[13px]
                  md:text-[14px]
                  xl:text-[15px]
                  leading-relaxed
                  mb-6
                "
              >
                {state.title ? `"${state.title}"` : "A sealed moment in time"}
              </motion.p>

              {/* Date + days */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.8, delay: 0.5 }}
                className="mb-7 space-y-1"
              >
                <p
                  className="
                    text-[13px]
                    md:text-[14px]
                    xl:text-[15px]
                    text-amber-100/80
                    tracking-wide
                  "
                >
                  Opens on {formatUTCDate(state.openAt)} (UTC)
                </p>
                <p
                  className="
                    text-[11px]
                    md:text-[12px]
                    xl:text-[13px]
                    text-amber-100/50
                    tracking-wide
                  "
                >
                  ~{daysLeft} day{daysLeft === 1 ? "" : "s"} remaining
                </p>
                <p className="text-[10px] font-mono text-amber-100/35 mt-2 tracking-wide">
                  Link contains capsule access fragment
                </p>
              </motion.div>

              {/* Buttons */}
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, delay: 0.6 }}
                className="
                  flex flex-col gap-3
                  w-full
                  max-w-[220px]
                  sm:max-w-[240px]
                  xl:max-w-[260px]
                  mb-7
                "
              >
                {/* Row 1: COPY RECIPIENT LINK + PRINT */}
                <div className="grid grid-cols-2 gap-3">
                  <motion.button
                    onClick={handleCopy}
                    aria-label="Copy recipient link"
                    whileHover={{ scale: 1.04, filter: "brightness(1.12)" }}
                    whileTap={{ scale: 0.97 }}
                    transition={{ type: "tween", duration: 0.18 }}
                    className="h-11 sm:h-12 rounded-full text-[11px] sm:text-[12px] xl:text-[13px] font-semibold tracking-[0.15em] border-0"
                    style={
                      copied
                        ? {
                            background: "#059669",
                            color: "#ffffff",
                            boxShadow: "0 0 18px rgba(5,150,105,0.4)",
                          }
                        : {
                            background: "#fbbf24",
                            color: "#1c0a00",
                            boxShadow: "0 0 20px rgba(251,191,36,0.5)",
                          }
                    }
                  >
                    {copied ? "COPIED ✓" : (authorityMode ? "RECIPIENT LINK" : "COPY LINK")}
                  </motion.button>

                  <motion.button
                    onClick={state.onPrint}
                    aria-label="Print capsule receipt"
                    whileHover={{ scale: 1.04, filter: "brightness(1.12)" }}
                    whileTap={{ scale: 0.97 }}
                    transition={{ type: "tween", duration: 0.18 }}
                    className="h-11 sm:h-12 rounded-full text-[11px] sm:text-[12px] xl:text-[13px] font-semibold tracking-[0.15em]"
                    style={{
                      background: "rgba(251,191,36,0.12)",
                      border: "2px solid rgba(251,191,36,0.75)",
                      color: "var(--capsule-outline-btn-color, #b45309)",
                      boxShadow: "0 0 14px rgba(251,191,36,0.2)",
                    }}
                  >
                    PRINT
                  </motion.button>
                </div>

                {/* Row 2: COPY CREATOR LINK — authority mode only */}
                {authorityMode && state.onCopyCreatorLink && (
                  <motion.button
                    onClick={handleCopyCreator}
                    aria-label="Copy creator link"
                    whileHover={{ scale: 1.04, filter: "brightness(1.12)" }}
                    whileTap={{ scale: 0.97 }}
                    transition={{ type: "tween", duration: 0.18 }}
                    className="w-full h-11 sm:h-12 rounded-full text-[11px] sm:text-[12px] xl:text-[13px] font-semibold tracking-[0.15em] border-0"
                    style={
                      copiedCreator
                        ? {
                            background: "#059669",
                            color: "#ffffff",
                            boxShadow: "0 0 18px rgba(5,150,105,0.4)",
                          }
                        : {
                            background: "rgba(251,191,36,0.18)",
                            border: "2px solid rgba(251,191,36,0.75)",
                            color: "var(--capsule-outline-btn-color, #b45309)",
                            boxShadow: "0 0 14px rgba(251,191,36,0.2)",
                          }
                    }
                  >
                    {copiedCreator ? "COPIED ✓" : "CREATOR LINK"}
                  </motion.button>
                )}
              </motion.div>

              {/* CONFIRM PRESENCE — visible only in authority mode */}
              {authorityMode && handleConfirmPresence && (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.6 }}
                  className="
                    mt-4
                    w-full
                    max-w-[220px]
                    sm:max-w-[240px]
                    xl:max-w-[260px]
                  "
                >
                  <p
                    id={confirmCaptionId}
                    className="
                      mb-2
                      text-[9.5px]
                      sm:text-[10px]
                      font-semibold
                      tracking-[0.22em]
                      text-amber-200/45
                    "
                  >
                    CREATOR PRESENCE
                  </p>

                  <motion.button
                    onClick={handleConfirmPresenceClick}
                    aria-describedby={confirmCaptionId}
                    disabled={
                      confirming ||
                      heartbeatCooldownActive ||
                      !confirmAvailability.available
                    }
                    data-confirm-availability={
                      confirmAwaitingWindow
                        ? "awaiting-window"
                        : confirmUnknown
                          ? "unknown"
                          : "available"
                    }
                    whileHover={{ scale: 1.04, filter: "brightness(1.12)" }}
                    whileTap={{ scale: 0.97 }}
                    transition={{ type: "tween", duration: 0.18 }}
                    className="w-full h-11 sm:h-12 rounded-full text-[11px] sm:text-[12px] xl:text-[13px] font-semibold tracking-[0.15em]"
                    style={
                      confirmSuccess
                        ? {
                            background: "rgba(5,150,105,0.15)",
                            border: "1px solid rgba(5,150,105,0.55)",
                            color: "#059669",
                            boxShadow: "0 0 16px rgba(5,150,105,0.25)",
                          }
                        : (heartbeatCooldownActive ||
                            !confirmAvailability.available)
                          ? {
                              background: "rgba(148,163,184,0.10)",
                              border: "1px solid rgba(148,163,184,0.30)",
                              color: "rgba(148,163,184,0.65)",
                              boxShadow: "none",
                              cursor: "not-allowed",
                            }
                          : {
                              background: "rgba(6,182,212,0.15)",
                              border: "1px solid rgba(6,182,212,0.65)",
                              color: "#0891b2",
                              boxShadow: "0 0 18px rgba(6,182,212,0.22)",
                            }
                    }
                  >
                    {confirmLabel}
                  </motion.button>

                  {confirmFeedback && (
                    <p
                      role="status"
                      aria-live="polite"
                      className="mt-3 text-[11px] leading-relaxed tracking-wide text-amber-200/90"
                    >
                      {confirmFeedback === "rejected"
                        ? "Presence could not be confirmed. Check the capsule status and try again if the confirmation window is still open."
                        : confirmFeedback === "expired"
                          ? "The confirmation window has expired. Presence can no longer be confirmed for this capsule."
                          : "We couldn't verify whether the confirmation was saved. Refresh the capsule page to check its current status before trying again."}
                    </p>
                  )}
                </motion.div>
              )}

              {/* Security warning */}
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.8, delay: 0.8 }}
                className="
                  mt-7
                  text-[11px]
                  md:text-[12px]
                  xl:text-[13px]
                  text-amber-100/50
                  leading-relaxed
                  tracking-wide
                "
              >
                {authorityMode ? (
                  <>
                    This link contains a capability fragment.{" "}
                    <strong className="text-amber-100/80 font-medium">
                      Capability fragments control access to the capsule lifecycle.
                    </strong>
                  </>
                ) : (
                  <>
                    This link contains the secret fragment.{" "}
                    Without it the capsule is mathematically unrecoverable.{" "}
                    <strong className="text-amber-100/80 font-medium">
                      Store securely. Do not share.
                    </strong>
                  </>
                )}
              </motion.p>

            </div>
          </div>

          {/* ── Creator Presence link — recipient card only (R9-A52) ──
              Directly BELOW the capsule card that carries the status, the
              scheduled opening date, the Recipient Link and the capsule
              actions.

              Visibility: recipient view only. Creator Presence is part of
              every capsule, so there is no presence condition; the creator
              card never shows it.

              Presentation only: no state read, no runtime call. */}
          {!authorityMode && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8, delay: 1.0 }}
              className="mt-6 text-center sm:mt-7"
            >
              <CreatorPresenceLink
                location="recipient"
                label={CREATOR_PRESENCE_RECIPIENT_LABEL}
              />
            </motion.div>
          )}

          {/* ── X profile mark — recipient card only (R9-A59) ──
              Replaces the old footer tagline on the recipient page.
              Order: capsule card -> gold
              Protocol link -> this mark, with a modest gap.

              Same modern X glyph and the SAME official profile URL as Home
              (no legacy bird). The destination is a fixed external URL:
              the capsule id, the recipient fragment and any access data are
              never appended, and the link opens in a new tab with
              rel="noopener noreferrer".

              Presentation only: no state read, no runtime call. */}
          {!authorityMode && (
            <div className="mt-5 flex justify-center">
              <a
                href="https://x.com/aeternacapsule"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="AETERNA on X"
                data-capsule-x-link=""
                className="
                  rounded-sm
                  text-amber-100/35
                  transition-colors
                  duration-300
                  hover:text-amber-200/70
                  focus-visible:outline-none
                  focus-visible:ring-1
                  focus-visible:ring-amber-400/70
                  focus-visible:ring-offset-2
                  focus-visible:ring-offset-background
                "
              >
                <svg
                  viewBox="0 0 24 24"
                  className="w-4 h-4"
                  fill="currentColor"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
              </a>
            </div>
          )}
        </motion.div>

        {/* Footer — creator/authority view keeps its existing tagline. */}
        {authorityMode && (
          <footer className="flex justify-center px-6 pt-8">
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8, delay: 1.2 }}
              className="
                w-full
                max-w-[300px]
                sm:max-w-[340px]
                md:max-w-[380px]
                lg:max-w-[420px]
                xl:max-w-[460px]
                2xl:max-w-[500px]
                text-xs
                text-muted-foreground/65
                tracking-wide
                text-center
                leading-relaxed
              "
            >
              A non-custodial digital time capsule
            </motion.p>
          </footer>
        )}
      </div>

      {/* ── PRINT ── */}
      <div className="hidden print:block bg-white text-black min-h-screen p-8 font-serif">
        <div
          className="
            max-w-2xl
            mx-auto
            border-2
            border-black
            p-10
            space-y-8
            break-inside-avoid
            print:break-inside-avoid
          "
        >

          <div className="text-center space-y-2">
            <h1 className="text-4xl font-bold tracking-tight">AETERNA</h1>
            <p className="text-sm tracking-widest uppercase opacity-80">
              Time Capsule Protocol · Receipt
            </p>
          </div>

          <hr className="border-black" />

          <div className="text-center space-y-4">
            <p className="text-xl font-bold uppercase tracking-wider">Sealed</p>
            <p className="text-lg italic">
              {state.title ? `"${state.title}"` : "Untitled Capsule"}
            </p>
            <div className="text-base">
              Unlock date (UTC): {formatUTCDate(state.openAt)}
            </div>
          </div>

          {(authorityMode ? creatorQrUrl : recipientQrUrl) && (
            <div className="flex justify-center">
              <img
                src={authorityMode ? creatorQrUrl : recipientQrUrl}
                alt="Capsule QR"
                className="w-56 h-56"
                style={{ imageRendering: "crisp-edges" }}
              />
            </div>
          )}

          <div className="font-mono text-sm break-all text-center bg-gray-100 p-4 rounded">
            {printUrl}
          </div>

          <div className="text-xs leading-relaxed text-center border-t border-black pt-6">
            {authorityMode ? (
              <>
                <strong>CREATOR AUTHORITY LINK</strong>
                <br />
                This document contains the creator authority link.
                <br />
                It allows heartbeat confirmation to extend the capsule open window.
                <br />
                <strong className="text-red-800">
                  Keep private. Do not share.
                </strong>
              </>
            ) : (
              <>
                <strong>CRITICAL SECURITY NOTICE</strong>
                <br />
                This document contains a private access link including the secret fragment.
                <br />
                <strong className="text-red-800">
                  Anyone who obtains this link can open the capsule once the unlock time is reached.
                </strong>
                <br />
                Store securely. Do not photograph. Do not share.
              </>
            )}
          </div>

        </div>
      </div>
    </>
  );
}
