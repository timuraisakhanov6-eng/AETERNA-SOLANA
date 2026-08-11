import {
  useEffect,
  useRef,
} from "react";

import {
  Camera,
  Video,
  FileUp,
} from "lucide-react";

import type {
  LucideIcon,
} from "lucide-react";


type ActionType =
  | "photo"
  | "video"
  | "file";


interface ActionMenuProps {

  isOpen: boolean;

  onClose: () => void;

  onSelect: (
    action: ActionType
  ) => void;

}


interface ActionItem {

  type: ActionType;

  icon: LucideIcon;

  label: string;

}


const ACTIONS: ActionItem[] = [

  {
    type: "photo",
    icon: Camera,
    label: "Take photo",
  },

  {
    type: "video",
    icon: Video,
    label: "Record video",
  },

  {
    type: "file",
    icon: FileUp,
    label: "Attach file",
  },

];


const ActionMenu = ({
  isOpen,
  onClose,
  onSelect,
}: ActionMenuProps): JSX.Element | null => {


  /**
   * Escape-key global handler
   *
   * Allows closing menu even if backdrop
   * is not focused.
   */

  useEffect(() => {

    if (!isOpen) {
      return;
    }

    function handleEscape(
      e: KeyboardEvent
    ): void {

      if (
        e.key === "Escape"
      ) {

        onClose();

      }

    }

    window.addEventListener(
      "keydown",
      handleEscape
    );

    return () => {

      window.removeEventListener(
        "keydown",
        handleEscape
      );

    };

  }, [
    isOpen,
    onClose,
  ]);


  // PATCH — paint-safe focus via requestAnimationFrame
  // Replaces synchronous focus() call which can fire before
  // layout is committed under dialog animation timing on
  // iOS Safari, Samsung Internet, and Android Chrome:
  //   - focus before paint → mobile keyboard flicker
  //   - viewport snapshot shift
  //   - StrictMode double-mount rAF skew (cancelAnimationFrame
  //     in cleanup handles this correctly)

  const firstButtonRef =
    useRef<HTMLButtonElement | null>(null);

  useEffect(() => {

    if (!isOpen) {
      return;
    }

    const id =
      requestAnimationFrame(() => {
        firstButtonRef.current?.focus();
      });

    return () => {
      cancelAnimationFrame(id);
    };

  }, [isOpen]);


  /**
   * Render guard
   */

  if (!isOpen) {

    return null;

  }


  return (

    <>

      {/* Backdrop */}

      <div

        role="button"

        tabIndex={0}

        aria-label="Close menu"

        className="fixed inset-0 bg-black/60 z-20"

        onClick={onClose}

        onKeyDown={(e) => {

          if (
            e.key === "Escape"
          ) {

            onClose();

          }

        }}

      />


      {/* Action menu dialog */}

      <div

        role="dialog"

        aria-modal="true"

        className="
          fixed bottom-24
          left-1/2 -translate-x-1/2
          z-50
          w-[calc(100%-2.5rem)]
          max-w-[460px]
          flex flex-col gap-1
          rounded-xl
          border border-border
          bg-card
          p-2
          shadow-xl
        "

      >

        {

          ACTIONS.map(
            (
              {
                type,
                icon: Icon,
                label,
              },
              index
            ) => (

              <button

                key={type}

                type="button"

                ref={
                  index === 0
                    ? firstButtonRef
                    : undefined
                }

                onClick={() => {

                  onSelect(type);

                  onClose();

                }}

                className="
                  flex items-center gap-3
                  px-4 py-3
                  rounded-lg
                  text-foreground
                  text-sm
                  font-medium
                  transition-colors
                  hover:bg-muted
                "

              >

                <Icon

                  size={20}

                  className="text-accent"

                />

                {label}

              </button>

            )

          )

        }

      </div>

    </>

  );

};

export default ActionMenu;