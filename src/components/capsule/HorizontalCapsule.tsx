import { CapsuleItem } from "@/types/capsule";
import { calculatePrice, FIRST_BLOCK_MB, NEXT_BLOCK_MB, NEXT_BLOCK_PRICE } from "@/lib/pricing";
import { Infinity } from "lucide-react";

interface HorizontalCapsuleProps {
  items: CapsuleItem[];
  onViewContents: () => void;
  isSealed?: boolean;
}

const encoder = new TextEncoder();

const HorizontalCapsule = ({
  items,
  onViewContents,
  isSealed = false,
}: HorizontalCapsuleProps): JSX.Element => {

  /* ===== SIZE CALC ===== */

  const totalBytes = items.reduce((acc, item) => {

    // PATCH — canonical size invariant: non-negative integer bytes only.
    // Rejects negative values, floats, and non-finite numbers that would
    // corrupt totalBytes accounting, pricing calculations, and fillPercent.
    if (
      item.type === "media" &&
      typeof item.size === "number" &&
      Number.isFinite(item.size) &&
      Number.isInteger(item.size) &&
      item.size >= 0
    ) {
      return acc + item.size;
    }

    // canonical Vault v2 text sizing rule
    if (
      item.type === "text" &&
      typeof item.text === "string"
    ) {
      return (
        acc +
        encoder
          .encode(item.text)
          .byteLength
      );
    }

    return acc;

  }, 0);


  const totalMB =
    totalBytes /
    (1024 * 1024);


  /* ===== BLOCK CALC ===== */

  let blockIndex = 1;

  let currentBlockLimit =
    FIRST_BLOCK_MB;

  let usedInBlock =
    totalMB;


  if (
    totalMB >
    FIRST_BLOCK_MB
  ) {

    const remaining =
      totalMB -
      FIRST_BLOCK_MB;

    const extraBlocks =
      Math.ceil(
        remaining /
        NEXT_BLOCK_MB
      );

    blockIndex =
      1 +
      extraBlocks;

    currentBlockLimit =
      NEXT_BLOCK_MB;

    usedInBlock =
      remaining -
      Math.floor(
        remaining /
        NEXT_BLOCK_MB
      ) *
        NEXT_BLOCK_MB;

    if (
      usedInBlock === 0 &&
      remaining > 0
    ) {
      usedInBlock =
        NEXT_BLOCK_MB;
    }

  }


  const remainingMB =
    Math.max(
      0,
      currentBlockLimit -
        usedInBlock
    );


  const fillPercent =
    Math.min(
      100,
      (usedInBlock /
        currentBlockLimit) *
        100
    );


  /* ===== COLORS ===== */

  const getFillColor = () => {

    if (fillPercent >= 95)
      return "hsl(0, 40%, 55%)";

    if (fillPercent >= 80)
      return "hsl(45, 75%, 50%)";

    return "hsl(160, 55%, 42%)";

  };


  const getGlowColor = () => {

    if (fillPercent >= 95)
      return "rgba(200,120,120,0.55)";

    if (fillPercent >= 80)
      return "rgba(240,190,90,0.65)";

    return "rgba(90,190,170,0.55)";

  };


  const getBlockDigitColor = () => {

    if (fillPercent >= 95)
      return "hsl(0, 55%, 60%)";

    if (fillPercent >= 80)
      return "hsl(45, 85%, 55%)";

    return "hsl(160, 55%, 55%)";

  };


  const rawPrice =
  calculatePrice(totalBytes);

if (
  !Number.isFinite(rawPrice) ||
  rawPrice < 0
) {
  throw new Error(
    "[AETERNA] Invalid price calculation"
  );
}

const price =
  rawPrice.toFixed(2);


  const handleClick = () => {

    if (!isSealed)
      onViewContents();

  };


  const handleKeyDown = (
    e: React.KeyboardEvent
  ) => {

    if (
      !isSealed &&
      (
        e.key === "Enter" ||
        e.key === " "
      )
    ) {

      e.preventDefault();

      onViewContents();

    }

  };


  return (

    <div
      role="button"
      tabIndex={
        isSealed
          ? -1
          : 0
      }
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

        ${isSealed
          ? "cursor-default"
          : "cursor-pointer hover:-translate-y-1"
        }

        select-none
      `}
      style={{

        borderRadius:
          "999px",

        background:
          "linear-gradient(160deg, rgba(255,255,255,0.18), rgba(0,0,0,0.45))",

        backdropFilter:
          "blur(16px)",

        WebkitBackdropFilter:
          "blur(16px)",

        border:
          "1px solid rgba(255,255,255,0.28)",

        boxShadow: `
          inset 0 1px 1px rgba(255,255,255,0.35),
          inset 0 -18px 30px rgba(0,0,0,0.45),
          0 18px 45px rgba(0,0,0,0.6),
          0 0 45px ${getGlowColor()},
          0 0 90px ${getGlowColor()}
        `,

        overflow:
          "hidden",

        opacity:
          isSealed
            ? 0.5
            : 1,

        transition:
          "transform 0.25s ease, box-shadow 0.25s ease, opacity 0.2s ease",

      }}

    >

      {/* FILL */}

      <div
        style={{
          position:
            "absolute",
          inset: 8,
          borderRadius:
            "999px",
          overflow:
            "hidden",
          pointerEvents:
            "none",
        }}
      >

        <div
          style={{
            position:
              "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            height:
              `${fillPercent}%`,
            background: `
              linear-gradient(
                180deg,
                ${getFillColor()}bb 0%,
                ${getFillColor()}ff 100%
              )
            `,
            boxShadow: `
              inset 0 0 24px ${getFillColor()},
              0 0 36px ${getFillColor()}
            `,
            transition:
              "height 1.4s cubic-bezier(0.22, 0.61, 0.36, 1)",
          }}
        />

      </div>


      {/* CONTENT */}

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

        <p
          className="
            font-bold tracking-widest
            text-[12px] sm:text-[13px] md:text-[14px] lg:text-[15px]
          "
        >

          BLOCK{" "}

          <span
            style={{
              color:
                getBlockDigitColor(),
            }}
          >

            {blockIndex}

          </span>

        </p>


        <p
          className="
            opacity-80 text-[10px] sm:text-[12px] md:text-[13px]
          "
        >
          {totalMB.toFixed(2)} MB USED · {remainingMB.toFixed(2)} MB LEFT
        </p>

        <p className="opacity-70 text-[9px] sm:text-[11px]">
          NEXT +{NEXT_BLOCK_MB}MB (+${NEXT_BLOCK_PRICE.toFixed(2)})
        </p>


        <div
          className="
            flex items-center gap-3
          "
        >

          <span
            className="
              font-display font-bold
            "
            style={{
              fontSize:
                "clamp(28px, 6vw, 44px)",
              textShadow:
                "0 0 22px rgba(255,200,120,0.55)",
            }}
          >

            ${price}

          </span>

          <Infinity
            size={26}
            color="hsl(35 70% 60%)"
            aria-hidden="true"
          />

        </div>


        <div
          aria-hidden="true"
          className="
            mt-2 px-6 py-1.5
            rounded-full
            border border-orange-400/80
            text-[12px] sm:text-[13px]
            font-semibold text-orange-300
            bg-black/35
            shadow-[0_0_18px_rgba(240,180,80,0.35)]
            opacity-80
          "
        >

          VIEW CONTENTS

        </div>

      </div>

    </div>

  );

};

export default HorizontalCapsule;