import { describe, it, expect, vi } from "vitest";

import { openVideo } from "@/lib/capsule/open/openVideo";
import { openAudio } from "@/lib/capsule/open/openAudio";
import {
  downloadFile,
} from "@/lib/capsule/open/downloadFile";
import { openImage } from "@/lib/capsule/open/openImage";
import type {
  ByteRuntime,
  OpenMediaRequest,
} from "@/lib/capsule/open/openTypes";

function createRuntimeStub(
  overrides: Partial<ByteRuntime> = {},
): ByteRuntime {
  return {
    getBytes: vi.fn().mockResolvedValue(
      new Uint8Array([1, 2, 3]),
    ),
    dispose: vi.fn(),
    ...overrides,
  };
}

describe(
  "streamingMemory.invariant.test.ts — Main Runtime streaming/memory invariants",
  () => {
    describe("video path algorithmic contract", () => {
      it("returns a session whose read() reaches ByteRuntime.getBytes", async () => {
        const runtime =
          createRuntimeStub();
        const session = await openVideo(
          runtime,
          {} as OpenMediaRequest,
        );

        const bytes =
          await session.read(0, 3);

        expect(runtime.getBytes).toHaveBeenCalledTimes(1);
        expect(runtime.getBytes).toHaveBeenCalledWith(
          0,
          3,
        );
        expect(bytes).toEqual(
          new Uint8Array([1, 2, 3]),
        );
      });

      it("session.read rejects after dispose", async () => {
        const runtime =
          createRuntimeStub();
        const session = await openVideo(
          runtime,
          {} as OpenMediaRequest,
        );

        session.dispose();

        await expect(
          session.read(0, 1),
        ).rejects.toThrow(
          "Video session has been disposed.",
        );
      });

      it("session.read rejects invalid ranges", async () => {
        const runtime =
          createRuntimeStub();
        const session = await openVideo(
          runtime,
          {} as OpenMediaRequest,
        );

        await expect(
          session.read(-1, 1),
        ).rejects.toThrow(
          "Invalid byte range.",
        );

        await expect(
          session.read(1, 1),
        ).rejects.toThrow(
          "Invalid byte range.",
        );
      });

      it("dispose is idempotent", async () => {
        const runtime =
          createRuntimeStub();
        const session = await openVideo(
          runtime,
          {} as OpenMediaRequest,
        );

        session.dispose();
        session.dispose();

        expect(runtime.dispose).toHaveBeenCalledTimes(1);
      });
    });

    describe("audio path algorithmic contract", () => {
      it("returns a session whose read() reaches ByteRuntime.getBytes", async () => {
        const runtime =
          createRuntimeStub();
        const session = await openAudio(
          runtime,
          {} as OpenMediaRequest,
        );

        const bytes =
          await session.read(0, 3);

        expect(runtime.getBytes).toHaveBeenCalledTimes(1);
        expect(runtime.getBytes).toHaveBeenCalledWith(
          0,
          3,
        );
        expect(bytes).toEqual(
          new Uint8Array([1, 2, 3]),
        );
      });

      it("session.read rejects after dispose", async () => {
        const runtime =
          createRuntimeStub();
        const session = await openAudio(
          runtime,
          {} as OpenMediaRequest,
        );

        session.dispose();

        await expect(
          session.read(0, 1),
        ).rejects.toThrow(
          "Audio session has been disposed.",
        );
      });
    });

    describe("download path algorithmic contract", () => {
      it("returns a session whose read() reaches ByteRuntime.getBytes", async () => {
        const runtime =
          createRuntimeStub();
        const session =
          await downloadFile(runtime, {} as OpenMediaRequest);

        const bytes =
          await session.read(0, 3);

        expect(runtime.getBytes).toHaveBeenCalledTimes(1);
        expect(runtime.getBytes).toHaveBeenCalledWith(
          0,
          3,
        );
        expect(bytes).toEqual(
          new Uint8Array([1, 2, 3]),
        );
      });

      it("session.read rejects after dispose", async () => {
        const runtime =
          createRuntimeStub();
        const session =
          await downloadFile(runtime, {} as OpenMediaRequest);

        session.dispose();

        await expect(
          session.read(0, 1),
        ).rejects.toThrow(
          "Download session has been disposed.",
        );
      });
    });

    describe("image path algorithmic contract", () => {
      it("reads the requested byte range from ByteRuntime and creates an object URL", async () => {
        const runtime =
          createRuntimeStub();
        const result =
          await openImage(
            runtime,
            {
              media: {
                size: 3,
                mimeType: "image/png",
                chunks: [],
              },
            } as OpenMediaRequest,
          );

        expect(runtime.getBytes).toHaveBeenCalledTimes(1);
        expect(runtime.getBytes).toHaveBeenCalledWith(
          0,
          3,
        );

        expect(
          typeof result.objectUrl,
        ).toBe("string");
        expect(result.objectUrl.length).toBeGreaterThan(0);
      });

      it("disposes runtime even when getBytes throws", async () => {
        const runtime: ByteRuntime =
          {
            getBytes: vi
              .fn()
              .mockRejectedValue(
                new Error("boom"),
              ),
            dispose: vi.fn(),
          };

        await expect(
          openImage(
            runtime,
            {
              media: {
                size: 3,
                mimeType: "image/png",
                chunks: [],
              },
            } as OpenMediaRequest,
          ),
        ).rejects.toThrow("boom");

        expect(runtime.dispose).toHaveBeenCalledTimes(1);
      });

      it("runtime is disposed after successful open", async () => {
        const runtime =
          createRuntimeStub();

        await openImage(
          runtime,
          {
            media: {
              size: 3,
              mimeType: "image/png",
              chunks: [],
            },
          } as OpenMediaRequest,
        );

        expect(runtime.dispose).toHaveBeenCalledTimes(1);
      });
    });

    describe("session/object URL lifetime algorithmic invariants", () => {
      it("video/audio/file sessions do not call session.read(0, size) themselves", async () => {
        const videoRuntime =
          createRuntimeStub();
        const audioRuntime =
          createRuntimeStub();
        const downloadRuntime =
          createRuntimeStub();

        const videoSession =
          await openVideo(
            videoRuntime,
            {} as OpenMediaRequest,
          );
        const audioSession =
          await openAudio(
            audioRuntime,
            {} as OpenMediaRequest,
          );
        const downloadSession =
          await downloadFile(
            downloadRuntime,
            {} as OpenMediaRequest,
          );

        // None of the sessions eagerly read on creation.
        expect(
          videoRuntime.getBytes,
        ).toHaveBeenCalledTimes(0);
        expect(
          audioRuntime.getBytes,
        ).toHaveBeenCalledTimes(0);
        expect(
          downloadRuntime.getBytes,
        ).toHaveBeenCalledTimes(0);

        // Eager reads are bounded ranges, not full-object
        // reads initiated by the session itself.
        await videoSession.read(100, 200);
        await audioSession.read(
          100,
          200,
        );
        await downloadSession.read(
          100,
          200,
        );

        expect(
          videoRuntime.getBytes,
        ).toHaveBeenCalledWith(100, 200);
        expect(
          audioRuntime.getBytes,
        ).toHaveBeenCalledWith(100, 200);
        expect(
          downloadRuntime.getBytes,
        ).toHaveBeenCalledWith(100, 200);
      });

      it("image path uses ByteRuntime once and disposes runtime after open", async () => {
        const runtime =
          createRuntimeStub();

        const result =
          await openImage(
            runtime,
            {
              media: {
                size: 3,
                mimeType: "image/png",
                chunks: [],
              },
            } as OpenMediaRequest,
          );

        // openImage() performs one bounded ByteRuntime read
        // for the requested image range, then creates an
        // object URL from that decoded bytes.
        expect(runtime.getBytes).toHaveBeenCalledTimes(1);
        expect(runtime.getBytes).toHaveBeenCalledWith(
          0,
          3,
        );

        expect(
          typeof result.objectUrl,
        ).toBe("string");
        expect(result.objectUrl.length).toBeGreaterThan(0);
        expect(runtime.dispose).toHaveBeenCalledTimes(1);
      });
    });

    describe("VaultRenderer progressive transport invariants", () => {
      it("file download falls back to bounded session object URL", async () => {
        const createObjectUrlSpy =
          vi.spyOn(URL, "createObjectURL").mockReturnValue(
            "blob:file",
          );

        const runtime =
          createRuntimeStub();

        const session =
          await downloadFile(
            runtime,
            {} as OpenMediaRequest,
          );

        const { sessionToDownloadStream } =
          await import(
            "@/pages/capsule/VaultRenderer"
          );

        await expect(
          sessionToDownloadStream(
            session,
            100,
            "application/octet-stream",
            "file.bin",
          ),
        ).rejects.toThrow(
          "[AETERNA] Streaming download unavailable for 100 bytes.",
        );

        expect(runtime.getBytes).toHaveBeenCalledTimes(0);

        createObjectUrlSpy.mockRestore();
      });
    });
  },
);
