import {
  ArrowLeft,
  FileText,
  Mic,
  File as FileIcon,
} from "lucide-react";

import { CapsuleItem } from "@/types/capsule";

import { useRef, useEffect } from "react";


interface ItemPreviewModalProps {
  item: CapsuleItem | null;
  previewSrc?: string | null;
  onClose: () => void;
}


const ItemPreviewModal = ({
  item,
  previewSrc,
  onClose,
}: ItemPreviewModalProps) => {

  if (item == null) return null;


/* ================= SCROLL LOCK ================= */

  useEffect(() => {

    const originalOverflow =
      document.body.style.overflow;

    document.body.style.overflow =
      "hidden";

    return () => {

      document.body.style.overflow =
        originalOverflow;

    };

  }, []);


/* ================= ESC CLOSE ================= */

  useEffect(() => {

    const handler = (
      e: KeyboardEvent
    ) => {

      if (e.key === "Escape")
        onClose();

    };

    window.addEventListener(
      "keydown",
      handler
    );

    return () =>
      window.removeEventListener(
        "keydown",
        handler
      );

  }, [onClose]);


/* ================= SWIPE DOWN CLOSE ================= */

  const startY =
    useRef<number | null>(null);


  const handleTouchStart = (
    e: React.TouchEvent
  ): void => {

    const touch =
      e.touches[0];

    if (!touch) return;

    startY.current =
      touch.clientY;

  };


  const handleTouchMove = (
    e: React.TouchEvent
  ): void => {

    if (
      startY.current == null
    ) return;


    const touch =
      e.touches[0];

    if (!touch) return;


    const delta =
      touch.clientY -
      startY.current;


    if (delta > 120) {

      // PATCH — reset gesture state before calling onClose.
      // Prevents repeated close calls from subsequent touchmove
      // events firing within the same gesture on mobile Safari
      // and high-frequency touch devices.
      startY.current = null;

      onClose();

    }

  };


  const handleTouchEnd = (): void => {

    startY.current =
      null;

  };


/* ================= PREVIEW SRC GUARD ================= */

  // Protocol whitelist — only blob: and data: URLs are valid
  // preview sources in this runtime. Rejects javascript:, file:,
  // http:, and any other scheme that could reach external origins
  // or trigger script execution in media elements.
  // null collapses to undefined at the call site (src={x ?? undefined}),
  // which causes React to omit the attribute entirely.

  const safePreviewSrc =
    typeof previewSrc === "string" &&
    (
      previewSrc.startsWith("blob:") ||
      previewSrc.startsWith("data:")
    )
      ? previewSrc
      : null;


/* ================= RENDER ================= */

  return (
    <>

{/* BACKDROP — aria-hidden so screen readers skip the decorative overlay */}

      <div
        aria-hidden="true"
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "black",
          zIndex: 999,
          cursor: "pointer",
        }}
      />


{/* MAIN MODAL */}

      <div
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 1000,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "black",
        }}
      >


{/* CLOSE BUTTON */}

        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          style={{
            position: "fixed",
            top: 20,
            left: 20,
            width: 44,
            height: 44,
            borderRadius: "50%",
            border: "none",
            background:
              "rgba(0,0,0,0.55)",
            backdropFilter:
              "blur(6px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "white",
            zIndex: 2000,
            cursor: "pointer",
          }}
        >

          <ArrowLeft size={24} />

        </button>


{/* CONTENT */}

        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >


{/* TEXT PREVIEW */}

          {item.type === "text" && (

            <div
              style={{
                background: "var(--card)",
                border:
                  "1px solid var(--border)",
                borderRadius: 20,
                padding: 24,
                maxWidth: 480,
                width: "90%",
              }}
            >

              <div
                style={{
                  display: "flex",
                  gap: 12,
                  marginBottom: 16,
                  borderBottom:
                    "1px solid var(--border)",
                  paddingBottom: 12,
                }}
              >

                <FileText size={20} />

                <b>Text Note</b>

              </div>


              <p
                style={{
                  whiteSpace:
                    "pre-wrap",
                  fontSize: 16,
                  lineHeight: 1.6,
                }}
              >

                {item.text}

              </p>

            </div>

          )}


{/* MEDIA PREVIEW */}

          {item.type === "media" &&
            safePreviewSrc && (

              item.mediaType ===
              "image" ? (

                <img
                  src={safePreviewSrc}
                  alt={item.filename}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit:
                      "contain",
                  }}
                />

              ) : item.mediaType ===
                  "video" ? (

                <video
                  src={safePreviewSrc}
                  controls
                  playsInline
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit:
                      "contain",
                    background:
                      "black",
                  }}
                />

              ) : item.mediaType ===
                  "audio" ? (

                <div
                  style={{
                    background:
                      "var(--card)",
                    border:
                      "1px solid var(--border)",
                    borderRadius:
                      20,
                    padding: 32,
                    minWidth: 320,
                    textAlign:
                      "center",
                  }}
                >

                  <div
                    style={{
                      width: 72,
                      height: 72,
                      borderRadius:
                        "50%",
                      background:
                        "var(--accent)",
                      margin:
                        "0 auto 16px",
                      display: "flex",
                      alignItems:
                        "center",
                      justifyContent:
                        "center",
                    }}
                  >

                    <Mic size={30} />

                  </div>


                  <p
                    style={{
                      marginBottom:
                        16,
                    }}
                  >

                    {item.filename}

                  </p>


                  <audio
                    src={safePreviewSrc}
                    controls
                    style={{
                      width: "100%",
                    }}
                  />

                </div>

              ) : (

                <div
                  style={{
                    background:
                      "var(--card)",
                    border:
                      "1px solid var(--border)",
                    borderRadius:
                      20,
                    padding: 32,
                    minWidth: 320,
                    textAlign:
                      "center",
                  }}
                >

                  <div
                    style={{
                      width: 72,
                      height: 72,
                      borderRadius:
                        "50%",
                      background:
                        "var(--border)",
                      margin:
                        "0 auto 16px",
                      display: "flex",
                      alignItems:
                        "center",
                      justifyContent:
                        "center",
                    }}
                  >

                    <FileIcon size={30} />

                  </div>


                  <p>

                    {item.filename}

                  </p>

                </div>

              )

            )}

        </div>

      </div>

    </>
  );

};


export default ItemPreviewModal;