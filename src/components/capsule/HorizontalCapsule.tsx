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
}

const HorizontalCapsule = ({
  items,
  onViewContents,
  isSealed = false,
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
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            height: "40%",
            background: `
              linear-gradient(
                180deg,
                hsl(160, 55%, 42%)bb 0%,
                hsl(160, 55%, 42%)ff 100%
              )
            `,
            boxShadow: `
              inset 0 0 24px hsl(160, 55%, 42%),
              0 0 36px hsl(160, 55%, 42%)
            `,
            transition: "height 1.4s cubic-bezier(0.22, 0.61, 0.36, 1)",
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

        <p className="font-bold tracking-widest text-[12px] sm:text-[13px] md:text-[14px] lg:text-[15px]">
          TOTAL CONTENT
        </p>

        <p className="text-[11px] sm:text-[13px] md:text-[14px]">
          {formatBytes(totalBytes)}
        </p>

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
