import {
  createContext,
  useContext,
  useState,
  ReactNode,
  useRef,
  useEffect,
} from "react";
import { CapsuleItem, MediaItem } from "@/types/capsule";
import { isoNow } from "@/lib/utils/isoNow";

/* ================= CONTEXT TYPE ================= */

type CapsuleContextType = {
  capsuleId: string;

  items: CapsuleItem[];

  addItem: (item: CapsuleItem) => void;
  removeItem: (id: string) => void;

  addTextItem: (text: string) => void;
  addMediaItem: (item: MediaItem, file: File) => void;

  updateTextItem: (id: string, text: string) => void;

  getMediaFile: (id: string) => File | undefined;

  /** preview objectURL accessor */
  getPreviewUrl: (id: string) => string | null;

  /** production lifecycle reset */
  resetCapsule: () => void;

  description: string;
  setDescription: (v: string) => void;

  unlockAt: number | null;
  setUnlockAt: (v: number | null) => void;

  unlockDate: Date | null;
  unlockTime: string | null;
};

/* ================= CONTEXT ================= */

const CapsuleContext =
  createContext<CapsuleContextType | null>(null);

/* ================= ITEM UUID (allowed) ================= */

function uuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
    /[xy]/g,
    (c) => {
      const r = (Math.random() * 16) | 0;
      const v =
        c === "x"
          ? r
          : (r & 0x3) | 0x8;

      return v.toString(16);
    }
  );
}

/* ================= CANONICAL CAPSULE ID ================= */

/**
 * AETERNA protocol invariant:
 *
 * capsuleId MUST be:
 * 32 random bytes
 * 64 lowercase hex chars
 */

function generateCapsuleId(): string {

  if (
    typeof crypto === "undefined" ||
    !crypto.getRandomValues
  ) {
    throw new Error(
      "[AETERNA] Secure RNG unavailable"
    );
  }

  const bytes =
    crypto.getRandomValues(
      new Uint8Array(32)
    );

  return Array
    .from(bytes)
    .map(b =>
      b.toString(16)
       .padStart(2, "0")
    )
    .join("");
}

/* ================= TEMPORAL GUARD ================= */

/**
 * Canonical temporal invariant — mirrors Temporal Authority Layer.
 *
 * Rejects floats, Infinity, NaN, and negative timestamps so that
 * derived date helpers never produce invalid Date objects from
 * malformed unlockAt values.
 */

function isValidTimestamp(v: number | null): v is number {
  return (
    typeof v === "number" &&
    Number.isFinite(v)   &&
    Number.isInteger(v)  &&
    v >= 0
  );
}

/* ================= PROVIDER ================= */

export const CapsuleProvider = ({
  children,
}: {
  children: ReactNode;
}) => {

  /* ================= CAPSULE IDENTITY ROOT ================= */

  /**
   * capsuleId = identity root of capsule session
   *
   * MUST:
   * generated once
   * stable during session
   * regenerated only after resetCapsule()
   */

  const capsuleIdRef =
    useRef<string>(
      generateCapsuleId()
    );

  function regenerateCapsuleId(): void {
    capsuleIdRef.current =
      generateCapsuleId();
  }

  /* ================= STATE ================= */

  const [items, setItems] =
    useState<CapsuleItem[]>([]);

  const [description, setDescription] =
    useState("");

  const [unlockAt, setUnlockAt] =
    useState<number | null>(null);

  /* ================= FILE STORAGE ================= */

  /**
   * media binary registry
   * never serialized
   * never exposed outside runtime
   */

  const mediaFilesRef =
    useRef<Map<string, File>>(new Map());

  /**
   * preview objectURL cache
   */

  const previewUrlRef =
    useRef<Map<string, string>>(new Map());

  /* ================= PREVIEW URL CLEANUP (PROVIDER UNMOUNT) ================= */

  useEffect(() => {

    return () => {

      previewUrlRef.current.forEach((url) => {

        URL.revokeObjectURL(url);

      });

      previewUrlRef.current.clear();

    };

  }, []);

  /* ================= ADD ITEM ================= */

  const addItem = (item: CapsuleItem) => {

    setItems((prev) => {

      if (
        prev.some(
          (i) => i.id === item.id
        )
      ) {

        throw new Error(
          "[AETERNA] Duplicate capsule item id"
        );

      }

      return [
        ...prev,
        item,
      ];

    });

  };

  /* ================= REMOVE ITEM ================= */

  const removeItem = (id: string) => {

    setItems((prev) =>
      prev.filter((i) => i.id !== id)
    );

    mediaFilesRef.current.delete(id);

    const url =
      previewUrlRef.current.get(id);

    if (url) {
      URL.revokeObjectURL(url);
      previewUrlRef.current.delete(id);
    }
  };

  /* ================= ADD TEXT ================= */

  const addTextItem = (text: string) => {

    const id =
      uuid();

    addItem({

      id,

      type: "text",

      text,

      createdAt:
        isoNow(),

    });

  };

  /* ================= ADD MEDIA ================= */

  const addMediaItem = (
    item: MediaItem,
    file: File
  ) => {

    if (mediaFilesRef.current.has(item.id)) {
      throw new Error(
        "[AETERNA] Duplicate media item id detected"
      );
    }

    // addItem FIRST — if it throws (duplicate id),
    // no object URL or file ref is created.
    // Keeps mediaFilesRef and previewUrlRef clean.
    addItem(item);

    mediaFilesRef.current.set(
      item.id,
      file
    );

    /**
     * Atomic preview URL allocation.
     *
     * If URL.createObjectURL throws (memory pressure, browser quota,
     * runtime failure), roll back both the item insertion and the
     * file ref so state remains fully consistent. Without rollback,
     * a throw here leaves a media item in the list with no preview
     * and no recovery path.
     */

    try {

      const previewUrl =
        URL.createObjectURL(file);

      previewUrlRef.current.set(
        item.id,
        previewUrl
      );

    } catch (error) {

      mediaFilesRef.current.delete(
        item.id
      );

      setItems((prev) =>
        prev.filter(
          (i) => i.id !== item.id
        )
      );

      throw error;

    }

  };

  /* ================= UPDATE TEXT ================= */

  const updateTextItem = (
    id: string,
    text: string
  ) => {

    setItems((prev) =>
      prev.map((item) =>
        item.id === id &&
        item.type === "text"
          ? {
              ...item,
              text,
            }
          : item
      )
    );

  };

  /* ================= GET FILE ================= */

  const getMediaFile = (
    id: string
  ): File | undefined => {

    return mediaFilesRef.current.get(id);

  };

  /* ================= GET PREVIEW URL ================= */

  const getPreviewUrl = (
    id: string
  ): string | null => {

    return (
      previewUrlRef.current.get(id) ??
      null
    );

  };

  /* ================= RESET CAPSULE ================= */

  /**
   * lifecycle-safe capsule reset
   */

  const resetCapsule = () => {

    setItems([]);

    setDescription("");

    setUnlockAt(null);

    mediaFilesRef.current.clear();

    previewUrlRef.current.forEach(
      (url) => {
        URL.revokeObjectURL(url);
      }
    );

    previewUrlRef.current.clear();

    /**
     * regenerate identity root
     */

    regenerateCapsuleId();

  };

  /* ================= DATE HELPERS ================= */

  /**
   * Derived from unlockAt only when value passes canonical temporal
   * invariant. Rejects floats, Infinity, NaN, and negative timestamps
   * so helpers never produce invalid Date objects.
   */

  const unlockDate =
    isValidTimestamp(unlockAt)
      ? new Date(unlockAt)
      : null;

  const unlockTime =
    isValidTimestamp(unlockAt)
      ? new Date(unlockAt)
          .toISOString()
          .slice(11, 16)
      : null;

  /* ================= PROVIDER ================= */

  return (
    <CapsuleContext.Provider
      value={{

        capsuleId: capsuleIdRef.current,

        items,

        addItem,
        removeItem,

        addTextItem,
        addMediaItem,

        updateTextItem,

        getMediaFile,
        getPreviewUrl,

        resetCapsule,

        description,
        setDescription,

        unlockAt,
        setUnlockAt,

        unlockDate,
        unlockTime,

      }}
    >
      {children}
    </CapsuleContext.Provider>
  );
};

/* ================= HOOK ================= */

export const useCapsule = () => {

  const ctx =
    useContext(CapsuleContext);

  if (!ctx) {
    throw new Error(
      "useCapsule must be used inside CapsuleProvider"
    );
  }

  return ctx;

};