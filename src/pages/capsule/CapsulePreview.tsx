import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  FileText,
  Music,
  Video,
  Image as ImageIcon,
  Trash2,
  Pencil,
  Plus,
  GripVertical,
} from "lucide-react";

import { useCapsule } from "@/context/CapsuleContext";
import TextLetterModal from "@/components/capsule/TextLetterModal";
import ItemPreviewModal from "@/components/capsule/ItemPreviewModal";
import type {
  CapsuleItem,
  MediaItem,
} from "@/types/capsule";
import { isTouchDevice } from "@/lib/utils/isTouchDevice";
import { isoNow } from "@/lib/utils/isoNow";

/* ================= LIMITS ================= */

const MAX_FILES = 100;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;

/* ================= ICON ================= */

// FIX 1: dispatch on item.mediaType for media items (canonical schema)
const getIcon = (item: CapsuleItem) => {
  if (item.type === "text") {
    return FileText;
  }

  if ("mediaType" in item) {
    switch (item.mediaType) {
      case "audio":
        return Music;

      case "video":
        return Video;

      case "image":
        return ImageIcon;
    }
  }

  return FileText;
};

// FIX: canonical narrowing — only MediaItem carries a size field.
// TextItem has none, so size must be derived as 0 for text items.
const getItemSize = (item: CapsuleItem): number => {

  if (item.type !== "media") {
    return 0;
  }

  return item.size;

};

const formatMB = (bytes: number) =>
  (bytes / (1024 * 1024)).toFixed(1);

function getItemLabel(item: CapsuleItem): string {
  if (item.type === "text") return "Letter";

  if ("filename" in item && typeof item.filename === "string")
    return item.filename;

  return "File";
}

/* ================= COMPONENT ================= */

const CapsulePreview = (): JSX.Element => {
  const navigate = useNavigate();

  const {
    items,
    removeItem,
    getMediaFile,
    addMediaItem,
  } = useCapsule();

/* ================= STATE ================= */

  const [order, setOrder] = useState<string[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);

  const [activeLetter, setActiveLetter] =
    useState<CapsuleItem | null>(null);

  const [activeMedia, setActiveMedia] =
    useState<CapsuleItem | null>(null);

  const [previewSrc, setPreviewSrc] =
    useState<string | null>(null);

  const [isTouch, setIsTouch] = useState(false);

/* ================= TOUCH DRAG ================= */

  const touchDragIdRef =
    useRef<string | null>(null);

  const longPressTimer =
    useRef<ReturnType<typeof setTimeout> | null>(null);

/* ================= FILE INPUT ================= */

  const fileInputRef =
    useRef<HTMLInputElement>(null);

/* ================= INIT TOUCH ================= */

  useEffect(() => {
    setIsTouch(isTouchDevice());
  }, []);

/* ================= ORDER SYNC ================= */

  useEffect(() => {
    setOrder(prev => {

      const ids = items.map(i => i.id);

      if (!prev.length) return ids;

      return ids.sort((a, b) => {

        const ai = prev.indexOf(a);
        const bi = prev.indexOf(b);

        if (ai === -1) return 1;
        if (bi === -1) return -1;

        return ai - bi;

      });

    });
  }, [items]);

/* ================= CLEANUP OBJECT URL ================= */

  useEffect(() => {
    return () => {
      if (previewSrc)
        URL.revokeObjectURL(previewSrc);
    };
  }, [previewSrc]);

/* ================= FIX: cleanup longPressTimer on unmount ================= */

  useEffect(() => {
    return () => {
      if (longPressTimer.current)
        clearTimeout(longPressTimer.current);
    };
  }, []);

/* ================= ORDERED ITEMS ================= */

  const orderedItems = useMemo(
  () =>
    order
      .map(id => items.find(i => i.id === id))
      .filter((i): i is CapsuleItem => i !== undefined),
  [order, items]
);

/* ================= SIZE ================= */

  const totalBytes = useMemo(
    () =>
      orderedItems.reduce(
        (s, i) => s + getItemSize(i),
        0
      ),
    [orderedItems]
  );

  // TEMPORARY DEV PREVIEW — REMOVE AFTER CREATE UI WORK
  // Display cap for /capsule/preview size pill.

/* ================= MEDIA PREVIEW ================= */

  const openMedia = (item: CapsuleItem) => {

    const file =
      getMediaFile(item.id);

    if (!file) {

      alert(
        "Preview unavailable in this session.\nFile still exists inside capsule."
      );

      return;
    }

    if (previewSrc) {
       URL.revokeObjectURL(previewSrc);
       setPreviewSrc(null);
  }

    const url =
      URL.createObjectURL(file);

    setPreviewSrc(url);
    setActiveMedia(item);

  };

  const closeMedia = () => {

    if (previewSrc)
      URL.revokeObjectURL(previewSrc);

    setPreviewSrc(null);
    setActiveMedia(null);

  };

/* ================= DESKTOP DRAG ================= */

  const onDragStart = (id: string) => {

    if (isTouch) return;

    setDragId(id);

  };

  const onDragOver = (
    e: React.DragEvent,
    id: string
  ) => {

    if (isTouch) return;

    e.preventDefault();

    if (!dragId || dragId === id)
      return;

    setOrder(prev => {

      const from =
        prev.indexOf(dragId);

      const to =
        prev.indexOf(id);

      if (
        from === -1 ||
        to === -1
      )
        return prev;

      const next = [...prev];

      next.splice(from, 1);
      next.splice(to, 0, dragId);

      return next;

    });

  };

  // Canonical drag cleanup — clears stale dragId after desktop drag
  // lifecycle ends (drop, cancel, or drag-out-of-window).
  // Without this, dragId persists and can cause unintended reorder
  // mutations on subsequent drag-over events.
  const onDragEnd = () => {
    setDragId(null);
  };

/* ================= MOBILE LONG PRESS DRAG ================= */

  const handleTouchStart = (id: string) => {

    longPressTimer.current =
      setTimeout(() => {

        touchDragIdRef.current = id;

      }, 150);

  };

  const handleTouchMove = (
  e: React.TouchEvent
) => {

  if (!touchDragIdRef.current)
    return;

  const touch = e.touches[0];

  if (!touch)
    return;

    const elementBelow =
      document.elementFromPoint(
        touch.clientX,
        touch.clientY
      );

    if (!elementBelow) return;

    const target =
      elementBelow.closest("[data-id]");

    if (!target) return;

    const targetId =
      target.getAttribute("data-id");

    if (!targetId) return;

    const dragId =
      touchDragIdRef.current;

    if (dragId === targetId)
      return;

    setOrder(prev => {

      const from =
        prev.indexOf(dragId);

      const to =
        prev.indexOf(targetId);

      if (
        from === -1 ||
        to === -1
      )
        return prev;

      const next = [...prev];

      next.splice(from, 1);
      next.splice(to, 0, dragId);

      return next;

    });

  };

  const handleTouchEnd = () => {

    if (longPressTimer.current)
      clearTimeout(longPressTimer.current);

    touchDragIdRef.current = null;

  };

/* ================= RENDER ================= */

  return (

<div className="h-screen bg-background flex flex-col overflow-hidden">

{/* HEADER */}

<header className="flex-none bg-background/95 backdrop-blur border-b border-border z-10">

<div className="h-16 flex items-center justify-center relative">

<button
onClick={() => navigate(-1)}
className="absolute left-4"
>
<ArrowLeft size={22} />
</button>

<div className="text-center">

<h1 className="tracking-[0.15em] font-semibold">
CONTENTS
</h1>

<p className="text-xs text-muted-foreground">
Review and edit before sealing
</p>

</div>

</div>

<div className="flex justify-center gap-4 pb-6">
  <div className="rounded-full border px-5 py-2 text-base bg-card/60">
    {items.length} / {MAX_FILES} files
  </div>
  <div className="rounded-full border px-5 py-2 text-base bg-card/60 text-muted-foreground">
    {formatMB(totalBytes)} MB
  </div>
</div>

</header>

{/* CONTENT */}

<main className="flex-1 overflow-y-auto px-6 py-10">

<div className="max-w-[960px] mx-auto">

<div className="rounded-2xl border bg-card/50 backdrop-blur p-6 space-y-3">

{orderedItems.map((item) => {

// FIX 2: pass full item to getIcon (not item.type)
const Icon = getIcon(item);

return (

<div
key={item.id}
data-id={item.id}
draggable={!isTouch}
onDragStart={() =>
onDragStart(item.id)
}
onDragOver={(e) =>
onDragOver(e, item.id)
}
onDragEnd={onDragEnd}
onTouchStart={() =>
handleTouchStart(item.id)
}
onTouchMove={
handleTouchMove
}
onTouchEnd={
handleTouchEnd
}
className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 cursor-grab active:cursor-grabbing"
>

<GripVertical
size={18}
className="opacity-50"
/>

<div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">

<Icon
size={18}
className="text-accent"
/>

</div>

<button
className="flex-1 text-left truncate"
onClick={() =>
item.type ===
"text"
? setActiveLetter(
item
)
: openMedia(
item
)
}
>

{getItemLabel(
item
)}

</button>

{item.type ===
"text" && (

<button
onClick={() =>
setActiveLetter(
item
)
}
>

<Pencil size={16} />

</button>

)}

<button
onClick={() =>
removeItem(
item.id
)
}
className="p-1 rounded hover:text-red-500 transition-colors"
>

<Trash2 size={16} />

</button>

</div>

);

})}

</div>

</div>

</main>

{/* ADD FILE */}

<div className="sticky bottom-0 border-t bg-background p-4">

<button
onClick={() =>
fileInputRef.current?.click()
}
className="max-w-[960px] mx-auto w-full rounded-xl border py-3 flex gap-2 justify-center"
>

<Plus size={18} />

Add file to capsule

</button>

<input
ref={fileInputRef}
type="file"
hidden
multiple
onChange={(e) => {

if (!e.target.files)
return;

let added = 0;

Array.from(
e.target.files
).forEach(
(file) => {

if (
items.length +
added >=
MAX_FILES
)
return;

if (
file.size >
MAX_FILE_SIZE
)
return;

// FIX 3: canonical schema — mediaType + type: "media" + globalThis.crypto
const mediaType =
file.type.startsWith(
"image/"
)
? "image"
: file.type.startsWith(
"video/"
)
? "video"
: file.type.startsWith(
"audio/"
)
? "audio"
: "file";

// FIX: mimeType guard — canonical validator requires length <= 255
const mimeType =
  typeof file.type === "string" &&
  file.type.length <= 255
    ? file.type
    : "application/octet-stream";

const mediaItem: MediaItem = {

  id: globalThis.crypto.randomUUID(),

  type: "media",

  mediaType,

  filename: file.name,

  size: file.size,

  mimeType,

  // createdAt uses client-time in builder stage;
  // canonical trusted-time is applied at the sealing boundary (sealCapsuleCore).
  createdAt: isoNow(),

};

addMediaItem(
  mediaItem,
  file
);

added++;

}
);

e.target.value = "";

}}
/>

</div>

{/* MODALS */}

<TextLetterModal
item={activeLetter}
isOpen={!!activeLetter}
isSealed={false}
onClose={() =>
setActiveLetter(null)
}
/>

<ItemPreviewModal
item={activeMedia}
previewSrc={previewSrc}
onClose={closeMedia}
/>

</div>

);

};

export default CapsulePreview;