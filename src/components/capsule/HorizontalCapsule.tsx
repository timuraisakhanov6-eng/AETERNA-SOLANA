import { useState, useEffect, useRef } from "react";
import { CapsuleItem } from "@/types/capsule";

const MB = 1024 * 1024;

const encoder = new TextEncoder();

function formatBytes(value: number): string {
  if (value <= 0) return "0 B";
  const mb = value / MB;
  if (mb >= 1) return `${mb.toFixed(2)} MB`;
  const kb = value / 1024;
  if (kb >= 1) return `${kb.toFixed(2)} KB`;
  return `${value} B`;
}

interface HorizontalCapsuleProps {
  items: CapsuleItem[];
  onViewContents: () => void;
  isSealed?: boolean;
  maxFiles?: number;
  capacityBytes?: number;
}

const HorizontalCapsule = ({
  items,
  onViewContents,
  isSealed = false,
  maxFiles = 100,
  capacityBytes = 100 * 1024,
}: HorizontalCapsuleProps): JSX.Element => {
  const totalBytes = items.reduce((acc, item) => {
    if (
      item.type === "media" &&
      typeof item.size === "number" &&
      Number.isFinite(item.size) &&
      Number.isInteger(item.size) &&
      item.size >= 0
    ) {
      return acc + item.size;
    }

    if (item.type === "text" && typeof item.text === "string") {
      return acc + encoder.encode(item.text).byteLength;
    }

    return acc;
  }, 0);

  const [pulseActive, setPulseActive] = useState(false);

  // TEMPORARY DEV PREVIEW — REMOVE AFTER CREATE UI WORK
  const previousItemsLengthRef = useRef(items.length);
  useEffect(() => {
    if (items.length > previousItemsLengthRef.current) {
      setPulseActive(true);
      const t = setTimeout(() => setPulseActive(false), 1400);
      return () => clearTimeout(t);
    }
    previousItemsLengthRef.current = items.length;
  }, [items.length]);

  const handleClick = () => {
    if (!isSealed) onViewContents();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isSealed && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      onViewContents();
    }
  };

  return (
    <div
      role="button"
      tabIndex={isSealed ? -1 : 0}
      aria-disabled={isSealed}
      aria-label="View capsule contents"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={`
        relative
        mx-auto
        w-full
        max-w-[460px]
        sm:max-w-[520px]
        md:max-w-[600px]
        lg:max-w-[720px]
        xl:max-w-[720px]

        min-h-[140px]
        sm:min-h-[155px]
        md:min-h-[175px]
        lg:min-h-[185px]

        transition-transform
        focus-visible:ring-2
        focus-visible:ring-orange-400/40

        ${isSealed ? "cursor-default" : "cursor-pointer hover:-translate-y-1"}

        select-none
      `}
      style={{
        borderRadius: "999px",
        background: "linear-gradient(160deg, rgba(255,255,255,0.18), rgba(0,0,0,0.45))",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        border: "1px solid rgba(255,255,255,0.28)",
        boxShadow: `
          inset 0 1px 1px rgba(255,255,255,0.35),
          inset 0 -18px 30px rgba(0,0,0,0.45),
          0 18px 45px rgba(0,0,0,0.6),
          0 0 45px rgba(90,190,170,0.55),
          0 0 90px rgba(90,190,170,0.55)
        `,
        overflow: "hidden",
        opacity: isSealed ? 0.5 : 1,
        transition: "transform 0.25s ease, box-shadow 0.25s ease, opacity 0.2s ease",
      }}
    >

      <div
        style={{
          position: "absolute",
          inset: 8,
          borderRadius: "999px",
          overflow: "hidden",
          pointerEvents: "none",
        }}
      >
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "999px",
            opacity: pulseActive ? 1 : 0,
            background:
              "linear-gradient(180deg, rgba(90,190,170,0) 0%, rgba(90,190,170,0.18) 40%, rgba(90,190,170,0.35) 100%)",
            boxShadow:
              "inset 0 0 28px rgba(90,190,170,0.35), 0 0 40px rgba(90,190,170,0.25)",
            transition:
              "opacity 200ms ease-out, box-shadow 700ms ease-out",
          }}
        />
      </div>

      <div
        className="
          absolute inset-0 z-10
          flex flex-col items-center justify-center
          text-center text-white
          pointer-events-none
          gap-0.5 sm:gap-1
        "
        style={{
          textShadow: "0 1px 6px rgba(0,0,0,0.9), 0 0 16px rgba(0,0,0,0.7)",
        }}
      >

        <div className="flex items-center justify-center gap-1.5 sm:gap-2 flex-nowrap min-w-0">
          <div className="rounded-full border border-white/25 bg-black/30 px-2.5 py-1 text-[11px] sm:text-[13px] md:text-[14px] lg:text-[15px] font-semibold text-white/90 whitespace-nowrap flex-shrink min-w-0">
            {items.length} / {maxFiles} FILES
          </div>
          <div className="rounded-full border border-white/25 bg-black/30 px-2.5 py-1 text-[11px] sm:text-[13px] md:text-[14px] lg:text-[15px] font-semibold text-white/90 whitespace-nowrap flex-shrink min-w-0">
            {formatBytes(totalBytes)}
          </div>
        </div>

        <div
          aria-hidden="true"
          className="
            mt-3 px-4 py-1.5 sm:px-6 sm:py-2 md:px-8 md:py-2
            rounded-full
            border border-orange-400/80 md:border-orange-300
            text-[11px] sm:text-[13px] md:text-sm
            font-semibold text-orange-200 md:text-orange-100
            bg-black/35 md:bg-black/30
            shadow-[0_0_18px_rgba(240,180,80,0.35)] md:shadow-[0_0_24px_rgba(240,180,80,0.45)]
            opacity-80 md:opacity-90
          "
        >
          VIEW CONTENTS
        </div>

      </div>

    </div>
  );
};

export default HorizontalCapsule;
