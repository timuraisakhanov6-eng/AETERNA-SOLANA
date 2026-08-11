import { X } from "lucide-react";
import { CapsuleItem } from "@/types/capsule";
import { useEffect } from "react";

type Props = {
  item: CapsuleItem | null;
  previewSrc: string | null;
  onClose: () => void;
};

const MediaPreviewModal = ({
  item,
  previewSrc,
  onClose,
}: Props) => {

  const isVisible =
    item != null &&
    previewSrc != null &&
    item.type === "media";


  /* ================= SCROLL LOCK ================= */

  // All hooks must be called unconditionally —
  // React Rules of Hooks forbid hooks after early returns.
  // Guard logic moves into isVisible flag instead.

  useEffect(() => {

    if (!isVisible) return;

    const originalOverflow =
      document.body.style.overflow;

    document.body.style.overflow =
      "hidden";

    return () => {

      document.body.style.overflow =
        originalOverflow;

    };

  }, [isVisible]);


  /* ================= ESC CLOSE ================= */

  useEffect(() => {

    if (!isVisible) return;

    function onEsc(e: KeyboardEvent) {

      if (e.key === "Escape") {
        onClose();
      }

    }

    window.addEventListener(
      "keydown",
      onEsc
    );

    return () =>
      window.removeEventListener(
        "keydown",
        onEsc
      );

  }, [isVisible, onClose]);


  /* ================= EARLY RETURN (after all hooks) ================= */

  if (!isVisible) return null;

  // Type narrowed after isVisible guard
  if (item!.type !== "media") return null;

  const filename = item!.filename;

  // Protocol whitelist — only blob: and data: URLs are valid
  // preview sources in this runtime. Rejects javascript:, file:,
  // http:, and any other scheme that could reach external origins
  // or trigger script execution in media elements.
  const safePreviewSrc =
    typeof previewSrc === "string" &&
    (
      previewSrc.startsWith("blob:") ||
      previewSrc.startsWith("data:")
    )
      ? previewSrc
      : null;

  if (!safePreviewSrc) {
    return null;
  }


  return (

    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center px-4">

      <div className="relative max-w-3xl w-full">

        <button
          type="button"
          onClick={onClose}
          className="absolute -top-10 right-0 text-white opacity-70 hover:opacity-100"
          aria-label="Close preview"
        >
          <X size={24} />
        </button>


        {item.mediaType === "image" && (

          <img
            src={safePreviewSrc}
            alt={filename}
            className="max-h-[80vh] mx-auto rounded-lg"
          />

        )}


        {item.mediaType === "video" && (

          <video
            src={safePreviewSrc}
            controls
            autoPlay
            playsInline
            className="max-h-[80vh] rounded-lg mx-auto"
          />

        )}


        {item.mediaType === "audio" && (

          <audio
            src={safePreviewSrc}
            controls
            autoPlay
            className="w-full"
          />

        )}


        {/* ── file: no renderable preview ── */}

        {item.mediaType === "file" && (

          <div className="text-white text-center py-8 opacity-70">

            <p className="text-sm">
              {filename}
            </p>

            <p className="text-xs mt-1 text-white/50">
              Preview not available for this file type
            </p>

          </div>

        )}

      </div>

    </div>

  );

};

export default MediaPreviewModal;