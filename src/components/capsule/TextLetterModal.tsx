import {
  useEffect,
  useRef,
  useState,
} from "react";

import {
  X,
  Pencil,
  ArrowLeft,
} from "lucide-react";

import { CapsuleItem } from "@/types/capsule";
import { useCapsule } from "@/context/CapsuleContext";


interface Props {
  item: CapsuleItem | null;
  isOpen: boolean;
  isSealed: boolean;
  onClose: () => void;
}


const PREVIEW_LIMIT = 280;


const TextLetterModal = ({
  item,
  isOpen,
  isSealed,
  onClose,
}: Props) => {

  const {
    updateTextItem,
  } = useCapsule();


  const [
    mode,
    setMode,
  ] =
    useState<
      "preview" |
      "read" |
      "edit"
    >("preview");


  const [
    text,
    setText,
  ] =
    useState<string>("");


  const scrollRef =
    useRef<
      HTMLDivElement |
      null
    >(null);


  // PATCH 2 — controlled textarea focus via ref + effect.
  // Replaces autoFocus which causes focus jumps and mobile
  // keyboard races under StrictMode remounts (iOS Safari,
  // Android Chrome).
  const textareaRef =
    useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {

    if (mode !== "edit") {
      return;
    }

    const id =
      requestAnimationFrame(() => {

        textareaRef.current?.focus();

      });

    return () => {

      cancelAnimationFrame(id);

    };

  }, [mode]);


  useEffect(() => {

    if (
      !isOpen ||
      !item ||
      item.type !== "text"
    ) {
      return;
    }

    setText(item.text);

    setMode(
      item.text.length >
        PREVIEW_LIMIT
        ? "preview"
        : "read"
    );

  }, [
    item,
    isOpen,
  ]);


/* ================= SCROLL LOCK ================= */

  useEffect(() => {

    if (!isOpen)
      return;

    const originalOverflow =
      document.body.style.overflow;

    document.body.style.overflow =
      "hidden";

    return () => {

      document.body.style.overflow =
        originalOverflow;

    };

  }, [isOpen]);


  if (
    !isOpen ||
    item == null ||
    item.type !== "text"
  ) {

    return null;

  }


  const preview =
    text.length >
    PREVIEW_LIMIT

      ? text.slice(
          0,
          PREVIEW_LIMIT
        ) + "\u2026"

      : text;


  return (

    <div className="fixed inset-0 z-50 flex items-center justify-center">

      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />


      <div
        className="
          relative
          w-[92vw]
          max-w-[640px]
          max-h-[85vh]
          rounded-2xl
          bg-[#faf7f2]
          ring-1 ring-black/5
          shadow-[0_30px_80px_rgba(0,0,0,0.45)]
          flex flex-col
          overflow-hidden
        "
      >

{/* HEADER */}

        <div className="flex items-center justify-between px-6 py-4 border-b border-black/10">

          <div className="flex items-center gap-2">

            {mode === "read" && (

              <button
                type="button"
                onClick={() =>
                  setMode(
                    "preview"
                  )
                }
                className="
                  p-2 rounded-lg
                  text-neutral-700
                  hover:text-neutral-900
                  hover:bg-black/5
                  transition
                "
                title="Back"
              >

                <ArrowLeft size={18} />

              </button>

            )}


            <h2 className="text-lg font-semibold tracking-wide text-neutral-900">

              Letter

            </h2>

          </div>


          <div className="flex items-center gap-2">

            {!isSealed &&
              mode !== "edit" && (

                <button
                  type="button"
                  onClick={() =>
                    setMode(
                      "edit"
                    )
                  }
                  className="
                    p-2 rounded-lg
                    text-neutral-700
                    hover:text-neutral-900
                    hover:bg-black/5
                    transition
                  "
                  title="Edit letter"
                >

                  <Pencil size={18} />

                </button>

              )}


            <button
              type="button"
              onClick={onClose}
              className="
                p-2 rounded-lg
                text-neutral-700
                hover:text-neutral-900
                hover:bg-black/5
                transition
              "
              title="Close"
            >

              <X size={18} />

            </button>

          </div>

        </div>


{/* BODY */}

        <div
          ref={scrollRef}
          className="
            flex-1
            overflow-y-auto
            px-6 py-5
            text-[15px]
            leading-relaxed
            whitespace-pre-wrap
            break-words
            text-neutral-900
          "
          style={{
            fontFamily:
              'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
          }}
        >

          {mode === "preview" && (

            <>

              <p>

                {preview}

              </p>


              {text.length >
                PREVIEW_LIMIT && (

                <button
                  type="button"
                  onClick={() =>
                    setMode(
                      "read"
                    )
                  }
                  className="mt-6 text-sm font-medium text-accent underline"
                >

                  Read full letter

                </button>

              )}

            </>

          )}


          {mode === "read" && (

            <p>

              {text}

            </p>

          )}


          {mode === "edit" && (

            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) =>
                setText(
                  e.target.value
                )
              }
              className="
                w-full
                min-h-[320px]
                bg-transparent
                outline-none
                resize-none
                text-[15px]
                leading-relaxed
                text-neutral-900
              "
            />

          )}

        </div>


{/* FOOTER */}

        {mode === "edit" && (

          <div className="px-6 py-4 border-t border-black/10 flex justify-end gap-3">

            <button
              type="button"
              onClick={() => {

                setText(
                  item.text
                );

                setMode(
                  item.text.length > PREVIEW_LIMIT
                     ? "preview"
                     : "read"
                );

              }}
              className="
                px-4 py-2 rounded-lg
                border border-black/10
                text-neutral-700
                hover:bg-black/5
              "
            >

              Cancel

            </button>


            <button
              type="button"
              onClick={() => {

                // PATCH 1 — no-op save guard.
                // Skips the update cycle when text is unchanged.
                if (text === item.text) {

                  setMode(
                    item.text.length > PREVIEW_LIMIT
                      ? "preview"
                      : "read"
                  );

                  return;

                }

                updateTextItem(
                  item.id,
                  text
                );

                setMode(
                  text.length > PREVIEW_LIMIT
                    ? "preview"
                    : "read"
                );

              }}
              className="
                px-4 py-2 rounded-lg
                bg-accent
                text-accent-foreground
                hover:opacity-90
              "
            >

              Save

            </button>

          </div>

        )}

      </div>

    </div>

  );

};


export default TextLetterModal;