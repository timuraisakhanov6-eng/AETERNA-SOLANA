import {
  parseCapsuleCapability,
} from "@/lib/capsule/parseCapsuleCapability";

import {
  loadManifest,
} from "@/lib/capsule/loadManifest";

import {
  loadHeartbeatRecord,
} from "@/lib/capsule/loadHeartbeatRecord";

import {
  sendHeartbeat,
} from "@/lib/capsule/sendHeartbeat";

import {
  resolveEffectiveOpenAt,
} from "@/shared/heartbeat/resolveEffectiveOpenAt";

import {
  getTrustedTime,
} from "@/shared/time/getTrustedTime";

import {
  openCapsule,
} from "@/lib/capsule/openCapsule";

import {
  resolveChunkPointers,
} from "@/lib/capsule/open/resolveChunkPointers";

import {
  createByteRuntime,
} from "@/lib/capsule/runtime/byteRuntime";

import {
  getChunkPointers,
} from "@/lib/storage/storage";

import type {
  OpenMediaRequest,
  OpenableMediaItem,
  MediaSession,
} from "@/lib/capsule/open/openTypes";

import type {
  StoragePointer,
} from "@/lib/storage/storageAdapter";

import type {
  ChunkId,
  ManifestV1,
} from "@/types/manifest";

import type {
  ChunkMetadata,
  MediaItemV2,
  VaultV2,
} from "@/types/vault";

export type EmergencyRuntimeInit = {
  root: HTMLElement;
  status: HTMLElement;
};

let runtimeDisposed = false;
let waiting = false;
let heartbeatPollHandle: ReturnType<typeof setInterval> | null = null;
let lastConfirmedAt: number | null = null;
let effectiveOpenAt = 0;

export function disposeEmergencyRuntime(): void {
  runtimeDisposed = true;
  stopHeartbeatRefresh();
}

export async function initEmergencyRuntime({
  root,
  status,
}: EmergencyRuntimeInit): Promise<void> {
  if (runtimeDisposed) {
    throw new Error("Emergency runtime has been disposed.");
  }

  status.textContent = "Loading emergency runtime…";

  const [
    { parseCapsuleCapability: parseCap },
    { loadManifest: loadManifestSource },
    { getTrustedTime: getTrustedTimeSource },
    { resolveEffectiveOpenAt: resolveOpenAtSource },
    { loadHeartbeatRecord: loadHeartbeatSource },
    { sendHeartbeat: sendHeartbeatSource },
    { openCapsule: openCapsuleSource },
  ] = await Promise.all([
    import("@/lib/capsule/parseCapsuleCapability"),
    import("@/lib/capsule/loadManifest"),
    import("@/shared/time/getTrustedTime"),
    import("@/shared/heartbeat/resolveEffectiveOpenAt"),
    import("@/lib/capsule/loadHeartbeatRecord"),
    import("@/lib/capsule/sendHeartbeat"),
    import("@/lib/capsule/openCapsule"),
  ]);

  const parsed = parseCap(location.href);

  if (!parsed?.recipientSecret && !parsed?.creatorAuthorityFragment) {
    status.textContent = "Invalid capsule link.";
    return;
  }

  let manifest: ManifestV1;
  try {
    const capsuleId = getCapsuleIdFromPath();
    manifest = await loadManifestSource(capsuleId);
  } catch {
    status.textContent = "Capsule unavailable.";
    return;
  }

  const chunkPointers = await getChunkPointers(manifest.capsuleId);

  let nowUtc: number;
  try {
    const trusted = await getTrustedTimeSource();
    nowUtc = trusted.nowUtc;
  } catch {
    status.textContent = "Trusted time unavailable.";
    return;
  }

  const heartbeatInterval = manifest.heartbeatInterval ?? 0;
  const heartbeatRecord = await loadHeartbeatSource(manifest.capsuleId);

  lastConfirmedAt = heartbeatRecord?.lastConfirmedAt ?? null;
  effectiveOpenAt = resolveOpenAtSource({
    manifestOpenAt: manifest.openAt,
    lastConfirmedAt: lastConfirmedAt ?? undefined,
    heartbeatInterval,
  });

  updateWaitingDisplay(effectiveOpenAt);
  waiting = true;

  if (parsed.creatorAuthorityFragment) {
    wireConfirmPresence({
      status,
      manifest,
      creatorAuthorityFragment: parsed.creatorAuthorityFragment,
      sendHeartbeat: sendHeartbeatSource,
      loadHeartbeat: loadHeartbeatSource,
      resolveOpenAt: resolveOpenAtSource,
    });
  }

  if (!parsed.recipientSecret) {
    status.textContent = "Opening requires recipient secret.";
    return;
  }

  if (nowUtc < effectiveOpenAt || manifest.sealedAt > nowUtc) {
    status.textContent = "Capsule is not yet open.";
    return;
  }

  status.textContent = "Opening capsule…";

  try {
    const { vault } = await openCapsuleSource({
      capsuleId: manifest.capsuleId,
      secret: parsed.recipientSecret,
      manifest,
    });

    renderEmergencyVault(root, vault, status, chunkPointers);
    status.textContent = "Capsule opened.";
  } catch {
    status.textContent = "Capsule unavailable.";
  }
}

/* =========================================================
   CAPABILITY / PATH HELPERS
   ========================================================= */

function updateWaitingDisplay(effectiveOpenAtValue: number): void {
  const dateMain = document.getElementById("dateMain");
  const dateDays = document.getElementById("dateDays");

  if (dateMain instanceof HTMLElement) {
    dateMain.textContent = new Date(effectiveOpenAtValue).toUTCString();
  }

  if (dateDays instanceof HTMLElement) {
    dateDays.textContent = "Waiting";
  }
}

function stopHeartbeatRefresh(): void {
  if (heartbeatPollHandle !== null) {
    clearInterval(heartbeatPollHandle);
    heartbeatPollHandle = null;
  }
}

async function attemptOpen(args: {
  root: HTMLElement;
  status: HTMLElement;
  recipientSecret: string;
  manifest: ManifestV1;
  effectiveOpenAtValue: number;
  getTrustedTime: typeof getTrustedTime;
  openCapsule: typeof openCapsule;
  chunkPointers: Readonly<Record<ChunkId, StoragePointer>>;
}): Promise<void> {
  stopHeartbeatRefresh();
  waiting = false;

  let nowUtc: number;
  try {
    nowUtc = (await args.getTrustedTime()).nowUtc;
  } catch {
    args.status.textContent = "Trusted time unavailable.";
    return;
  }

  if (nowUtc < args.effectiveOpenAtValue || args.manifest.sealedAt > nowUtc) {
    args.status.textContent = "Capsule is not yet open.";
    return;
  }

  args.status.textContent = "Opening capsule…";

  try {
    const { vault } = await args.openCapsule({
      capsuleId: args.manifest.capsuleId,
      secret: args.recipientSecret,
      manifest: args.manifest,
    });

    renderEmergencyVault(
      args.root,
      vault,
      args.status,
      args.chunkPointers,
    );
    args.status.textContent = "Capsule opened.";
  } catch {
    args.status.textContent = "Capsule unavailable.";
  }
}

function startHeartbeatRefresh(args: {
  capsuleId: string;
  manifest: ManifestV1;
  status: HTMLElement;
  root: HTMLElement;
  recipientSecret: string;
  getTrustedTime: typeof getTrustedTime;
  loadHeartbeat: typeof loadHeartbeatRecord;
  resolveOpenAt: typeof resolveEffectiveOpenAt;
  openCapsule: typeof openCapsule;
  chunkPointers: Readonly<Record<ChunkId, StoragePointer>>;
}): void {
  if (heartbeatPollHandle !== null || !waiting) {
    return;
  }

  heartbeatPollHandle = setInterval(async () => {
    if (runtimeDisposed || !waiting) {
      stopHeartbeatRefresh();
      return;
    }

    let heartbeatRecord: Awaited<
      ReturnType<typeof loadHeartbeatRecord>
    > | null = null;

    try {
      heartbeatRecord = await args.loadHeartbeat(args.capsuleId);
    } catch {
      // preserve authoritative state; retry on next tick
      return;
    }

    if (runtimeDisposed || !waiting) {
      return;
    }

    const newLastConfirmedAt = heartbeatRecord?.lastConfirmedAt ?? null;

    if (newLastConfirmedAt === lastConfirmedAt) {
      return;
    }

    lastConfirmedAt = newLastConfirmedAt;
    effectiveOpenAt = args.resolveOpenAt({
      manifestOpenAt: args.manifest.openAt,
      lastConfirmedAt: lastConfirmedAt ?? undefined,
      heartbeatInterval: args.manifest.heartbeatInterval ?? 0,
    });

    updateWaitingDisplay(effectiveOpenAt);

    let nowUtc: number;
    try {
      nowUtc = (await args.getTrustedTime()).nowUtc;
    } catch {
      return;
    }

    if (
      runtimeDisposed ||
      !waiting ||
      nowUtc < effectiveOpenAt ||
      args.manifest.sealedAt > nowUtc
    ) {
      return;
    }

    await attemptOpen({
      root: args.root,
      status: args.status,
      recipientSecret: args.recipientSecret,
      manifest: args.manifest,
      effectiveOpenAtValue: effectiveOpenAt,
      getTrustedTime: args.getTrustedTime,
      openCapsule: args.openCapsule,
      chunkPointers: args.chunkPointers,
    });
  }, 30_000);
}

function getCapsuleIdFromPath(): string {
  if (
    typeof location === "undefined" ||
    typeof location.pathname !== "string"
  ) {
    return "";
  }

  const trimmed = location.pathname.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  const segment = index >= 0 ? trimmed.slice(index + 1) : trimmed;

  return segment || trimmed || "";
}

function wireConfirmPresence(args: {
  status: HTMLElement;
  manifest: ManifestV1;
  creatorAuthorityFragment: string;
  sendHeartbeat: typeof sendHeartbeat;
  loadHeartbeat: typeof loadHeartbeatRecord;
  resolveOpenAt: typeof resolveEffectiveOpenAt;
}): void {
  const confirmWrap =
    document.getElementById("confirmWrap");
  const confirmBtn = document.getElementById("confirmBtn");

  if (!(confirmWrap instanceof HTMLDivElement)) {
    return;
  }

  if (!(confirmBtn instanceof HTMLButtonElement)) {
    return;
  }

  confirmWrap.style.display = "";

  confirmBtn.onclick = async () => {
    if (confirmBtn.disabled) return;

    confirmBtn.disabled = true;
    confirmBtn.textContent = "CONFIRMING...";

    try {
      const result = await args.sendHeartbeat(
        args.manifest.capsuleId,
        args.creatorAuthorityFragment,
      );

      if (result === "confirmed") {
        confirmBtn.textContent = "CONFIRMED ✓";
        confirmBtn.classList.add("success");
        confirmBtn.classList.remove("cooldown");
        confirmBtn.disabled = false;

        setTimeout(() => {
          confirmBtn.disabled = true;
          confirmBtn.textContent = "WAIT 15 MIN";
          confirmBtn.classList.add("cooldown");
          setTimeout(() => {
            confirmBtn.disabled = false;
            confirmBtn.textContent = "CONFIRM PRESENCE";
            confirmBtn.classList.remove("cooldown");
          }, 15 * 60 * 1000);
        }, 3000);

        try {
          const refreshed = await args.loadHeartbeat(
            args.manifest.capsuleId,
          );

          if (!runtimeDisposed && waiting) {
            lastConfirmedAt = refreshed?.lastConfirmedAt ?? lastConfirmedAt;
            effectiveOpenAt = args.resolveOpenAt({
              manifestOpenAt: args.manifest.openAt,
              lastConfirmedAt: lastConfirmedAt ?? undefined,
              heartbeatInterval: args.manifest.heartbeatInterval ?? 0,
            });

            updateWaitingDisplay(effectiveOpenAt);
          }
        } catch {
          // retain authoritative state; polling can retry
        }

        return;
      }

      args.status.textContent =
        result === "expired"
          ? "Confirmation window closed."
          : result === "rejected"
            ? "Heartbeat rejected."
            : "Network error during heartbeat.";
    } catch {
      args.status.textContent = "Heartbeat failed. Try again.";
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "CONFIRM PRESENCE";
    }
  };
}

/* =========================================================
   VAULT RENDERING
   ========================================================= */

function renderEmergencyVault(
  root: HTMLElement,
  vault: VaultV2,
  status: HTMLElement,
  chunkPointers: Readonly<Record<ChunkId, StoragePointer>>,
): void {
  root.innerHTML = "";

  const items = vault?.capsule?.items ?? [];

  for (let index = 0; index < items.length; index++) {
    const item = items[index];

    const div = document.createElement("div");
    div.className = "item";
    div.style.animationDelay = `${index * 0.07}s`;

    if (!item || typeof item !== "object") {
      root.appendChild(div);
      continue;
    }

    const record = item as Record<string, unknown>;

    if (record.type !== "media") {
      const eyebrow = document.createElement("p");
      eyebrow.className = "item-eyebrow";
      eyebrow.textContent = "Message";

      const body = document.createElement("div");
      body.className = "item-text";
      body.textContent =
        typeof record.text === "string"
          ? record.text
          : "";

      div.appendChild(eyebrow);
      div.appendChild(body);
      root.appendChild(div);
      continue;
    }

    const mediaItem = record as Partial<MediaItemV2>;

    const filename =
      typeof mediaItem.filename === "string" &&
      mediaItem.filename.length > 0
        ? mediaItem.filename
        : "file";

    const mediaType =
      typeof mediaItem.mediaType === "string"
        ? mediaItem.mediaType
        : "file";

    const mimeType =
      typeof mediaItem.mimeType === "string"
        ? mediaItem.mimeType
        : "";

    const size =
      typeof mediaItem.size === "number"
        ? mediaItem.size
        : 0;

    const chunks = Array.isArray(mediaItem.chunks)
      ? (mediaItem.chunks as readonly ChunkMetadata[])
      : [];

    const eyebrow = document.createElement("p");
    eyebrow.className = "item-eyebrow";
    eyebrow.textContent =
      mediaType.charAt(0).toUpperCase() + mediaType.slice(1);

    const card = document.createElement("div");
    card.className = "media-card";

    const icon = document.createElement("div");
    icon.className = "media-icon";
    icon.innerHTML = mediaIconSvg(mediaType);

    const info = document.createElement("div");
    info.className = "media-info";

    const filenameEl = document.createElement("div");
    filenameEl.className = "media-filename";
    filenameEl.textContent = filename;

    const meta = document.createElement("div");
    meta.className = "media-meta";
    const metaParts = [mimeType];
    if (size > 0) metaParts.push(formatBytes(size));
    meta.textContent = metaParts.filter(Boolean).join(" · ");

    info.appendChild(filenameEl);
    info.appendChild(meta);
    card.appendChild(icon);
    card.appendChild(info);

    const unavailable = document.createElement("div");
    unavailable.className = "media-unavail";
    unavailable.textContent =
      "Preview unavailable — media recovery coming in next layer";

    div.appendChild(eyebrow);
    div.appendChild(card);
    div.appendChild(unavailable);
    root.appendChild(div);

    if (size <= 0 || chunks.length === 0) {
      continue;
    }

    const anchor = document.createElement("div");
    anchor.className = "media-playground";
    anchor.style.marginTop = "12px";
    div.appendChild(anchor);

    if (mediaType === "video" || mediaType === "audio") {
      buildEmergencyMediaElement({
        root: anchor,
        status,
        item: mediaItem,
        capsuleId: vault.capsule.capsuleId,
        chunks,
        chunkPointers,
        mediaType,
        mimeType,
        size,
      });
    } else if (mediaType === "image") {
      buildEmergencyImage({
        root: anchor,
        status,
        item: mediaItem,
        capsuleId: vault.capsule.capsuleId,
        chunks,
        chunkPointers,
        mimeType,
        size,
      });
    } else if (mediaType === "file") {
      buildEmergencyFile({
        root: anchor,
        status,
        item: mediaItem,
        capsuleId: vault.capsule.capsuleId,
        chunks,
        chunkPointers,
        mimeType,
        size,
      });
    }
  }
}

/* =========================================================
   EMERGENCY MEDIA ADAPTERS
   ========================================================= */

function buildEmergencyMediaElement(args: {
  root: HTMLElement;
  status: HTMLElement;
  item: Partial<MediaItemV2>;
  capsuleId: string;
  chunks: readonly ChunkMetadata[];
  chunkPointers: Readonly<Record<ChunkId, StoragePointer>>;
  mediaType: MediaItemV2["mediaType"];
  mimeType: string;
  size: number;
}): void {
  const media =
    args.mediaType === "video"
      ? document.createElement("video")
      : document.createElement("audio");

  media.controls = true;
  media.style.width = "100%";
  media.style.maxHeight = "320px";
  media.style.borderRadius = "16px";
  media.style.background = "#000";
  media.style.marginTop = "10px";

  const fallback = document.createElement("div");
  fallback.className = "media-fallback";
  fallback.textContent =
    "Progressive playback unavailable — bounded recovery required.";
  fallback.style.display = "none";
  fallback.style.fontSize = "11px";
  fallback.style.color = "rgba(232,228,220,0.45)";
  fallback.style.marginTop = "10px";

  args.root.appendChild(media);
  args.root.appendChild(fallback);

  const attachObjectUrl = (objectUrl: string) => {
    if (media.src && media.src.startsWith("blob:")) {
      URL.revokeObjectURL(media.src);
    }

    media.src = objectUrl;
    media.load();
  };

  let currentAbort: (() => void) | null = null;

  const disposePrevious = () => {
    if (currentAbort) {
      currentAbort();
      currentAbort = null;
    }

    if (media.src && media.src.startsWith("blob:")) {
      URL.revokeObjectURL(media.src);
    }

    media.removeAttribute("src");
    media.load();
    fallback.style.display = "none";
  };

  media.addEventListener("error", () => {
    fallback.style.display = "";
  });

  buildEmergencyMediaSession({
    root: args.root,
    status: args.status,
    item: args.item,
    capsuleId: args.capsuleId,
    chunks: args.chunks,
    chunkPointers: args.chunkPointers,
    mimeType: args.mimeType,
    size: args.size,
    onStreamReady: (objectUrl) => {
      disposePrevious();
      attachObjectUrl(objectUrl);
    },
    getAbortController: () => {
      const ac = new AbortController();
      currentAbort = () => ac.abort();
      return ac;
    },
  });
}

function buildEmergencyImage(args: {
  root: HTMLElement;
  status: HTMLElement;
  item: Partial<MediaItemV2>;
  capsuleId: string;
  chunks: readonly ChunkMetadata[];
  chunkPointers: Readonly<Record<ChunkId, StoragePointer>>;
  mimeType: string;
  size: number;
}): void {
  const img = document.createElement("img");
  img.alt = args.item.filename ?? "capsule media";
  img.style.width = "100%";
  img.style.borderRadius = "16px";
  img.style.background = "#000";
  img.style.marginTop = "10px";

  const fallback = document.createElement("div");
  fallback.className = "media-fallback";
  fallback.textContent =
    "Image preview unavailable — bounded recovery required.";
  fallback.style.fontSize = "11px";
  fallback.style.color = "rgba(232,228,220,0.45)";
  fallback.style.marginTop = "10px";

  args.root.appendChild(img);
  args.root.appendChild(fallback);

  img.addEventListener("error", () => {
    fallback.style.display = "";
  });

  let objectUrl: string | null = null;

  buildEmergencyMediaSession({
    root: args.root,
    status: args.status,
    item: args.item,
    capsuleId: args.capsuleId,
    chunks: args.chunks,
    chunkPointers: args.chunkPointers,
    mimeType: args.mimeType,
    size: args.size,
    onStreamReady: (url) => {
      if (objectUrl && objectUrl.startsWith("blob:")) {
        URL.revokeObjectURL(objectUrl);
      }

      objectUrl = url;
      img.src = url;
    },
    getAbortController: () => new AbortController(),
  });
}

function buildEmergencyFile(args: {
  root: HTMLElement;
  status: HTMLElement;
  item: Partial<MediaItemV2>;
  capsuleId: string;
  chunks: readonly ChunkMetadata[];
  chunkPointers: Readonly<Record<ChunkId, StoragePointer>>;
  mimeType: string;
  size: number;
}): void {
  const anchor = document.createElement("a");
  anchor.textContent = `Download ${args.item.filename ?? "file"}`;
  anchor.style.display = "inline-flex";
  anchor.style.marginTop = "10px";
  anchor.style.fontSize = "12px";
  anchor.style.color = "rgba(232,228,220,0.7)";
  anchor.style.textDecoration = "underline";
  anchor.style.textUnderlineOffset = "4px";

  const fallback = document.createElement("div");
  fallback.className = "media-fallback";
  fallback.textContent =
    "Streaming download unavailable — bounded recovery required.";
  fallback.style.fontSize = "11px";
  fallback.style.color = "rgba(232,228,220,0.45)";
  fallback.style.marginTop = "10px";

  args.root.appendChild(anchor);
  args.root.appendChild(fallback);

  anchor.addEventListener("click", (event) => {
    event.preventDefault();
    fallback.style.display = "";
    anchor.removeAttribute("href");
  });

  let objectUrl: string | null = null;

  buildEmergencyMediaSession({
    root: args.root,
    status: args.status,
    item: args.item,
    capsuleId: args.capsuleId,
    chunks: args.chunks,
    chunkPointers: args.chunkPointers,
    mimeType: args.mimeType,
    size: args.size,
    onStreamReady: (url) => {
      if (objectUrl && objectUrl.startsWith("blob:")) {
        URL.revokeObjectURL(objectUrl);
      }

      objectUrl = url;
      anchor.href = url;
      anchor.download = args.item.filename ?? "aeterna-media";
      anchor.style.display = "inline-flex";
      fallback.style.display = "none";
    },
    getAbortController: () => new AbortController(),
  });
}

/* =========================================================
   SHARED MEDIA SESSION BUILDER
   ========================================================= */

function buildEmergencyMediaSession(args: {
  root: HTMLElement;
  status: HTMLElement;
  item: Partial<MediaItemV2>;
  capsuleId: string;
  chunks: readonly ChunkMetadata[];
  chunkPointers: Readonly<Record<ChunkId, StoragePointer>>;
  mimeType: string;
  size: number;
  onStreamReady: (objectUrl: string) => void;
  getAbortController: () => AbortController;
}): void {
  const session = createEmergencyMediaSession({
    item: args.item,
    capsuleId: args.capsuleId,
    chunks: args.chunks,
    chunkPointers: args.chunkPointers,
    mimeType: args.mimeType,
    size: args.size,
    onStreamReady: args.onStreamReady,
    status: args.status,
    abortController: args.getAbortController(),
  });

  const cleanup = () => {
    try {
      session.dispose();
    } catch {
      // best-effort teardown
    }
  };

  const rootObserver = new MutationObserver(() => {
    if (!args.root.isConnected) {
      cleanup();
      rootObserver.disconnect();
    }
  });

  rootObserver.observe(args.root, { subtree: false });

  window.addEventListener("beforeunload", cleanup, { once: true });
}

/* =========================================================
   EMERGENCY MEDIA SESSION
   ========================================================= */

function createEmergencyMediaSession(args: {
  item: Partial<MediaItemV2>;
  capsuleId: string;
  chunks: readonly ChunkMetadata[];
  chunkPointers: Readonly<Record<ChunkId, StoragePointer>>;
  mimeType: string;
  size: number;
  onStreamReady: (objectUrl: string) => void;
  status: HTMLElement;
  abortController: AbortController;
}): MediaSession {
  const resolvedChunks = resolveChunkPointers(
    args.chunks as MediaItemV2["chunks"],
    args.chunkPointers,
  );

  const request: OpenMediaRequest = {
    capsuleId: args.capsuleId,
    cryptoKey: null as unknown as CryptoKey,
    media: {
      mediaType: args.item.mediaType as MediaItemV2["mediaType"],
      filename: args.item.filename as string,
      mimeType: args.mimeType,
      size: args.size,
      chunks: resolvedChunks,
      createdAt: args.item.createdAt as string,
    } as OpenableMediaItem,
  };

  const runtime = createByteRuntime(
    args.capsuleId,
    request.cryptoKey,
    resolvedChunks,
    args.size,
  );

  let disposed = false;

  const read = async (start: number, end: number): Promise<Uint8Array> => {
    if (disposed) {
      throw new Error(
        "Emergency media session has been disposed.",
      );
    }

    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end)
    ) {
      throw new Error("Range bounds must be integers.");
    }

    if (start < 0 || end <= start) {
      throw new Error("Invalid byte range.");
    }

    if (end > args.size) {
      throw new Error("Byte range exceeds file length.");
    }

    return runtime.getBytes(start, end);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    runtime.dispose();
  };

  const session: MediaSession = {
    read,
    dispose,
  };

  const acceptObjectUrl = (objectUrl: string) => {
    if (args.abortController.signal.aborted) {
      URL.revokeObjectURL(objectUrl);
      return;
    }

    args.onStreamReady(objectUrl);
  };

  const fail = (reason?: string) => {
    args.status.textContent =
      reason ?? "Media recovery failed.";
  };

  const runImage = async () => {
    try {
      const bytes = await session.read(0, args.size);
      const blob = new Blob([bytes], {
        type: args.mimeType || "application/octet-stream",
      });
      const objectUrl = URL.createObjectURL(blob);
      acceptObjectUrl(objectUrl);
    } catch (err) {
      fail(
        err instanceof Error
          ? err.message
          : "Image preview failed.",
      );
    } finally {
      session.dispose();
    }
  };

  const runProgressiveMedia = async () => {
    const objectUrl = emergencyMediaSourceStream({
      session,
      mimeType: args.mimeType,
      size: args.size,
      signal: args.abortController.signal,
      onError: () => fail("Progressive playback failed."),
    });

    if (objectUrl) {
      acceptObjectUrl(objectUrl);
    }

    session.dispose();
  };

  const runFileFallback = async () => {
    try {
      const bytes = await session.read(0, args.size);
      const blob = new Blob([bytes], {
        type: args.mimeType || "application/octet-stream",
      });
      const objectUrl = URL.createObjectURL(blob);
      acceptObjectUrl(objectUrl);
    } catch (err) {
      fail(
        err instanceof Error
          ? err.message
          : "Download recovery failed.",
      );
    } finally {
      session.dispose();
    }
  };

  if (args.item.mediaType === "image") {
    void runImage();
    return session;
  }

  if (
    args.item.mediaType === "video" ||
    args.item.mediaType === "audio"
  ) {
    if (
      typeof MediaSource !== "undefined" &&
      MediaSource.isTypeSupported(args.mimeType)
    ) {
      void runProgressiveMedia();
      return session;
    }

    void runFileFallback();
    return session;
  }

  void runFileFallback();
  return session;
}

/* =========================================================
   EMERGENCY MEDIA SOURCE STREAM
   ========================================================= */

function emergencyMediaSourceStream(args: {
  session: MediaSession;
  mimeType: string;
  size: number;
  signal: AbortSignal;
  onError: () => void;
}): string | null {
  if (
    typeof MediaSource === "undefined" ||
    !MediaSource.isTypeSupported(args.mimeType)
  ) {
    return null;
  }

  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);

  const settled = { value: null as string | null };

  const done = (outcome: string | null) => {
    if (settled.value === undefined) {
      settled.value = outcome;
    }
  };

  const cleanup = () => {
    try {
      if (
        settled.value === null &&
        mediaSource.readyState === "open"
      ) {
        mediaSource.endOfStream();
      }
    } catch {
      // preserve current state on terminal errors
    }
  };

  try {
    mediaSource.addEventListener(
      "sourceopen",
      async () => {
        if (args.signal.aborted) {
          cleanup();
          done(null);
          return;
        }

        try {
          const sourceBuffer =
            mediaSource.addSourceBuffer(args.mimeType);

          let offset = 0;
          const chunkSize = 256 * 1024;

          const appendNext = async () => {
            if (args.signal.aborted || offset >= args.size) {
              if (
                offset >= args.size &&
                mediaSource.readyState === "open"
              ) {
                try {
                  mediaSource.endOfStream();
                } catch {
                  // already closed / closing
                }
              }
              return;
            }

            const end = Math.min(
              offset + chunkSize,
              args.size,
            );

            let bytes: Uint8Array;

            try {
              bytes = await args.session.read(offset, end);
            } catch {
              cleanup();
              args.onError();
              done(null);
              return;
            }

            if (args.signal.aborted) {
              return;
            }

            try {
              sourceBuffer.appendBuffer(bytes);
            } catch {
              cleanup();
              args.onError();
              done(null);
              return;
            }

            offset = end;
          };

          sourceBuffer.addEventListener(
            "updateend",
            appendNext,
          );

          sourceBuffer.addEventListener(
            "error",
            () => {
              cleanup();
              args.onError();
              done(null);
            },
          );

          await appendNext();
          done(objectUrl);
        } catch {
          args.onError();
          done(null);
        }
      },
      { once: true },
    );
  } catch {
    args.onError();
    done(null);
  }

  return settled.value ?? null;
}

/* =========================================================
   RENDER HELPERS
   ========================================================= */

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function mediaIconSvg(mediaType: string): string {
  const common =
    'width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';

  if (mediaType === "image") {
    return `<svg ${common}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
  }

  if (mediaType === "video") {
    return `<svg ${common}><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`;
  }

  if (mediaType === "audio") {
    return `<svg ${common}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
  }

  return `<svg ${common}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
}
