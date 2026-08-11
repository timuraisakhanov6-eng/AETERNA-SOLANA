import { Button } from "@/components/ui/button";
import {
  Trash2,
  FileText,
  Image as ImageIcon,
  Video,
  Mic,
  Type,
} from "lucide-react";

import type { CapsuleItem } from "@/types/capsule";

interface CapsuleContentsProps {
  items: CapsuleItem[];
  onRemoveItem: (id: string) => void;
}

export default function CapsuleContents({
  items,
  onRemoveItem,
}: CapsuleContentsProps) {
  if (items.length === 0) {
    return (
      <div className="text-center text-sm text-muted-foreground py-12">
        Capsule is empty
      </div>
    );
  }

  /**
   * Canonical icon resolver
   *
   * Safe narrowing:
   * CapsuleItem =
   *   TextCapsuleItem
   *   MediaCapsuleItem
   *   FileCapsuleItem
   *
   * mediaType exists ONLY on MediaCapsuleItem
   */
  function iconForItem(item: CapsuleItem) {
    if (item.type === "text") {
      return (
        <Type
          size={16}
          className="text-amber-400"
        />
      );
    }

    if (
      "mediaType" in item &&
      typeof item.mediaType === "string"
    ) {
      switch (item.mediaType) {
        case "image":
          return (
            <ImageIcon
              size={16}
              className="text-blue-400"
            />
          );

        case "video":
          return (
            <Video
              size={16}
              className="text-purple-400"
            />
          );

        case "audio":
          return (
            <Mic
              size={16}
              className="text-pink-400"
            />
          );

        case "file":
          return (
            <FileText
              size={16}
              className="text-gray-400"
            />
          );
      }
    }

    return (
      <FileText
        size={16}
        className="text-gray-400"
      />
    );
  }

  /**
   * Canonical label resolver
   *
   * filename guard requires typeof string — prevents silent
   * React coercion if a malformed runtime object carries
   * filename: number or filename: object.
   */
  function labelForItem(item: CapsuleItem): string {
    if (item.type === "text") {
      const preview = item.text.slice(0, 20);

      return (
        preview +
        (item.text.length > 20
          ? "…"
          : "")
      );
    }

    if (
      "filename" in item &&
      typeof item.filename === "string"
    ) {
      return item.filename;
    }

    return "File";
  }

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <div
          key={item.id}
          className="
            flex items-center justify-between
            rounded-lg border border-border
            bg-card/60 px-4 py-3
            transition-colors hover:bg-card/80
          "
        >
          {/* LEFT */}
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex-shrink-0">
              {iconForItem(item)}
            </div>

            <div className="truncate text-sm font-medium text-foreground/90">
              {labelForItem(item)}
            </div>
          </div>

          {/* RIGHT */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() =>
              onRemoveItem(item.id)
            }
            className="
              hover:bg-transparent
              text-muted-foreground
              hover:text-red-500
              transition-colors
            "
            title="Remove item"
          >
            <Trash2 size={16} />
          </Button>
        </div>
      ))}
    </div>
  );
}