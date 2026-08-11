import type { OpenAtUtc } from "@/types/manifest";
import { useState, useMemo, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ShieldCheck as ShieldIcon,
  Lock as LockIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getUiTime } from "@/lib/utils/getUiTime";
import QRCode from "qrcode";

/* ===== TYPES ===== */

export type CapsuleViewState =
  | {
      status: "preview";

      capsuleId: string;

      authorityMode?: boolean;

      onConfirmPresence?: () => Promise<void>;

      title?: string;

      openAt: OpenAtUtc;

      shareUrl: string;

      creatorShareUrl?: string | undefined;

      onCopyLink: () => void;

      onCopyCreatorLink?: (() => void) | undefined;

      onPrint: () => void;

      onCreate?: () => void;
    }
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

  const [copied, setCopied] = useState(false);
  const [copiedCreator, setCopiedCreator] = useState(false);
  const [confirmSuccess, setConfirmSuccess] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [heartbeatCooldownActive, setHeartbeatCooldownActive] = useState(false);

  const HEARTBEAT_COOLDOWN_MS =
    15 * 60 * 1000;

  const heartbeatCooldownKey =
    state.status === "preview"
      ? `aeterna-heartbeat-${state.capsuleId}`
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
    if (!heartbeatCooldownKey) return;
    const last = localStorage.getItem(heartbeatCooldownKey);
    if (!last) return;
    const elapsed = Date.now() - Number(last);
    if (Number.isFinite(elapsed) && elapsed < HEARTBEAT_COOLDOWN_MS) {
      activateHeartbeatCooldown(HEARTBEAT_COOLDOWN_MS - elapsed);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heartbeatCooldownKey]);

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

  const handleConfirmPresenceClick = async () => {

    if (!handleConfirmPresence)
      return;

    if (confirming)
      return;

    try {

      if (heartbeatCooldownKey) {

        const lastHeartbeat =
          localStorage.getItem(
            heartbeatCooldownKey
          );

        if (lastHeartbeat) {

          const elapsed =
            Date.now() -
            Number(lastHeartbeat);

          if (
            Number.isFinite(elapsed) &&
            elapsed <
              HEARTBEAT_COOLDOWN_MS
          ) {

            return;

          }

        }

      }

      setConfirming(true);

      await handleConfirmPresence();

      setConfirmSuccess(true);
      activateHeartbeatCooldown(HEARTBEAT_COOLDOWN_MS);

      if (heartbeatCooldownKey) {

        localStorage.setItem(
          heartbeatCooldownKey,
          String(Date.now())
        );

      }

      if (confirmTimerRef.current)
        clearTimeout(confirmTimerRef.current);

      confirmTimerRef.current =
        setTimeout(
          () => setConfirmSuccess(false),
          3000
        );

    } catch {

      // ignore

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
              border-accent/25
              dark:border-accent/15
              bg-gradient-to-b
              from-accent/[0.05]
              via-transparent
              to-accent/[0.03]
              shadow-[inset_0_1px_0_rgba(255,255,255,0.6)]
              shadow-[0_0_0_1px_rgba(255,200,140,0.08),0_0_60px_rgba(255,200,140,0.18)]
              dark:shadow-[0_0_40px_-15px_hsl(var(--accent)/0.15)]
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

              {/* Capsule glyph — heartbeat pulse */}
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.8, delay: 0.15 }}
                className="mb-5 xl:mb-6 relative flex items-center justify-center"
              >
                {/* Glow ring */}
                <motion.div
                  aria-hidden
                  className="absolute rounded-full bg-accent/50 blur-md"
                  style={{ width: "54px", height: "80px" }}
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

                {/* Pill shape */}
                <motion.div
                  className="
                    relative z-10
                    w-8 h-14
                    sm:w-9 sm:h-16
                    xl:w-10 xl:h-[72px]
                    rounded-full
                    border border-accent/30
                    bg-gradient-to-b from-accent/5 to-transparent
                    overflow-hidden
                    will-change-transform
                  "
                  animate={{
                    scale:       [1, 1.18, 0.97, 1.09, 1, 1, 1, 1, 1, 1],
                    borderColor: [
                      "hsl(var(--accent)/0.3)",
                      "hsl(var(--accent)/0.75)",
                      "hsl(var(--accent)/0.4)",
                      "hsl(var(--accent)/0.6)",
                      "hsl(var(--accent)/0.3)",
                      "hsl(var(--accent)/0.3)",
                      "hsl(var(--accent)/0.3)",
                      "hsl(var(--accent)/0.3)",
                      "hsl(var(--accent)/0.3)",
                      "hsl(var(--accent)/0.3)",
                    ],
                  }}
                  transition={{
                    duration: 1.4,
                    repeat: Infinity,
                    ease: "easeOut",
                    times: [0, 0.08, 0.16, 0.26, 0.38, 0.5, 0.6, 0.7, 0.85, 1],
                  }}
                >
                  <div className="absolute inset-x-2 top-3 h-px bg-accent/20" />
                  <div className="absolute inset-x-0 top-1/2 h-px bg-accent/15" />
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
                  className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-500"
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
                  text-foreground
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
                  text-muted-foreground/80
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
                    text-foreground/80
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
                    text-muted-foreground/70
                    tracking-wide
                  "
                >
                  ~{daysLeft} day{daysLeft === 1 ? "" : "s"} remaining
                </p>
                <p className="text-[10px] font-mono text-muted-foreground/40 mt-2 tracking-wide">
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
                  <motion.button
                    onClick={handleConfirmPresenceClick}
                    disabled={confirming || heartbeatCooldownActive}
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
                        : heartbeatCooldownActive
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
                    {confirming
                      ? "CONFIRMING..."
                      : heartbeatCooldownActive
                          ? "WAIT 15 MIN"
                          : confirmSuccess
                              ? "CONFIRMED ✓"
                              : "CONFIRM PRESENCE"}
                  </motion.button>
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
                  text-muted-foreground/60
                  leading-relaxed
                  tracking-wide
                "
              >
                {authorityMode ? (
                  <>
                    This link contains a capability fragment.{" "}
                    <strong className="text-foreground/70 font-medium">
                      Capability fragments control access to the capsule lifecycle.
                    </strong>
                  </>
                ) : (
                  <>
                    This link contains the secret fragment.{" "}
                    Without it the capsule is mathematically unrecoverable.{" "}
                    <strong className="text-foreground/70 font-medium">
                      Store securely. Do not share.
                    </strong>
                  </>
                )}
              </motion.p>

            </div>
          </div>

          {/* ── Recipient Notice — весь блок кликабелен ── */}
          {!authorityMode && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8, delay: 1.0 }}
              className="mt-7"
            >
              <Link
                to="/protocol#creator-presence"
                className="
                  block
                  rounded-xl
                  border border-amber-500/20
                  bg-amber-500/5
                  px-4 py-4
                  text-center
                  transition-colors
                  hover:bg-amber-500/10
                  hover:border-amber-500/30
                "
              >
                <p className="text-sm text-foreground/90 leading-relaxed">
                  The opening date of this capsule may change over time.
                </p>
                <p className="mt-2 text-sm font-medium text-amber-600">
                  Learn why →
                </p>
              </Link>
            </motion.div>
          )}
        </motion.div>

        {/* Footer */}
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
                  Anyone who obtains this link can permanently open the capsule.
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