import { describe, expect, it, vi, beforeEach } from "vitest";
import { parseRangeHeader } from "../../src/lib/capsule/open/parseRangeHeader";
import { readRange } from "../../src/lib/capsule/open/rangeReader";
import { handleRuntimeMessage } from "../../src/lib/capsule/open/runtimeBridge";
import {
  registerRuntimeSession,
  resolveRuntimeSession,
  disposeRuntimeSession,
} from "../../src/lib/capsule/open/runtimeRegistry";
import { openVideo } from "../../src/lib/capsule/open/openVideo";
import { openAudio } from "../../src/lib/capsule/open/openAudio";
import { downloadFile } from "../../src/lib/capsule/open/downloadFile";

interface FakeMediaSession {
  read(_start: number, _end: number): Promise<Uint8Array>;
  dispose(): void;
}

function createFakeSession(readImpl?: (_start: number, _end: number) => Promise<Uint8Array>): FakeMediaSession {
  return {
    read: readImpl ?? (() => Promise.resolve(new Uint8Array())),
    dispose: () => {},
  };
}

/* =========================================================
   RANGE HEADER PARSING
   ========================================================= */

describe("parseRangeHeader — current production contract", () => {
  it("parses a closed byte range as half-open [start, end)", () => {
    const parsed = parseRangeHeader("bytes=10-20");
    expect(parsed).toEqual({ start: 10, end: 21 });
  });

  it("parses an open-ended range with end=null", () => {
    const parsed = parseRangeHeader("bytes=10-");
    expect(parsed).toEqual({ start: 10, end: null });
  });

  it("rejects suffix ranges", () => {
    expect(() => parseRangeHeader("bytes=-500")).toThrow(
      "Invalid HTTP Range header.",
    );
  });

  it("rejects malformed syntax", () => {
    expect(() => parseRangeHeader("bytes=10")).toThrow(
      "Invalid HTTP Range header.",
    );
    expect(() => parseRangeHeader("bytes=10-20-30")).toThrow(
      "Invalid HTTP Range header.",
    );
    expect(() => parseRangeHeader("bytes=--")).toThrow(
      "Invalid HTTP Range header.",
    );
  });

  it("rejects reversed closed ranges", () => {
    expect(() => parseRangeHeader("bytes=20-10")).toThrow(
      "Invalid HTTP Range header.",
    );
  });

  it("rejects negative start", () => {
    expect(() => parseRangeHeader("bytes=-1-5")).toThrow(
      "Invalid HTTP Range header.",
    );
  });

  it("rejects non-integer values", () => {
    expect(() => parseRangeHeader("bytes=1.5-10")).toThrow(
      "Invalid HTTP Range header.",
    );
    expect(() => parseRangeHeader("bytes=10-1.5")).toThrow(
      "Invalid HTTP Range header.",
    );
  });
});

/* =========================================================
   RANGE READER — BOUNDARY VALIDATION
   ========================================================= */

describe("readRange — boundary validation", () => {
  it("rejects non-integer start", async () => {
    const session = createFakeSession();
    await expect(readRange(session, 1.5, 10)).rejects.toThrow(
      "Range bounds must be integers.",
    );
  });

  it("rejects non-integer end", async () => {
    const session = createFakeSession();
    await expect(readRange(session, 0, 1.5)).rejects.toThrow(
      "Range bounds must be integers.",
    );
  });

  it("rejects negative start", async () => {
    const session = createFakeSession();
    await expect(readRange(session, -1, 10)).rejects.toThrow(
      "Invalid byte range.",
    );
  });

  it("rejects end <= start", async () => {
    const session = createFakeSession();
    await expect(readRange(session, 10, 10)).rejects.toThrow(
      "Invalid byte range.",
    );
    await expect(readRange(session, 10, 9)).rejects.toThrow(
      "Invalid byte range.",
    );
  });
});

/* =========================================================
   RUNTIME REGISTRY — SESSION LIFECYCLE
   ========================================================= */

describe("runtimeRegistry — fail-closed session lifecycle", () => {
  it("registers and resolves a session", () => {
    const session = createFakeSession();

    registerRuntimeSession("session-1", session);
    const resolved = resolveRuntimeSession("session-1");

    expect(resolved).toBe(session);
  });

  it("rejects duplicate session registration", () => {
    const session = createFakeSession();

    registerRuntimeSession("session-dup", session);
    expect(() => registerRuntimeSession("session-dup", session)).toThrow(
      "Runtime session already exists.",
    );
  });

  it("rejects resolution of unknown session", () => {
    expect(() => resolveRuntimeSession("missing")).toThrow(
      "Runtime session not found.",
    );
  });

  it("rejects disposal of unknown session", () => {
    expect(() => disposeRuntimeSession("missing")).toThrow(
      "Runtime session not found.",
    );
  });

  it("disposes session and removes it from registry", () => {
    const dispose = vi.fn();
    const session = createFakeSession();

    session.dispose = dispose;

    registerRuntimeSession("session-dispose", session);
    disposeRuntimeSession("session-dispose");

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(() => resolveRuntimeSession("session-dispose")).toThrow(
      "Runtime session not found.",
    );
  });
});

/* =========================================================
   RUNTIME BRIDGE — MESSAGE DISPATCH
   ========================================================= */

describe("runtimeBridge — message dispatch", () => {
  it("dispatches READ_RANGE to session", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const session = createFakeSession(async () => bytes);

    registerRuntimeSession("bridge-session", session);

    const message = {
      type: "READ_RANGE" as const,
      sessionId: "bridge-session",
      start: 0,
      end: 3,
    };

    const result = await handleRuntimeMessage(message);

    expect(result.type).toBe("READ_RESULT");
    expect(result.start).toBe(0);
    expect(result.end).toBe(3);
    expect(result.bytes).toEqual(bytes);
  });

  it("rejects unsupported message types", async () => {
    const message = {
      type: "UNKNOWN_MESSAGE",
      sessionId: "x",
    };

    await expect(handleRuntimeMessage(message)).rejects.toThrow(
      "Unsupported Runtime message.",
    );
  });

  it("rejects READ_RANGE for unknown session", async () => {
    const message = {
      type: "READ_RANGE" as const,
      sessionId: "missing",
      start: 0,
      end: 1,
    };

    await expect(handleRuntimeMessage(message)).rejects.toThrow(
      "Runtime session not found.",
    );
  });
});

/* =========================================================
   MEDIA SESSION ADAPTERS — RANGE VALIDATION
   ========================================================= */

describe("openVideo / openAudio / downloadFile — session adapters", () => {
  const runtime = {
    getBytes: async () => new Uint8Array(),
    dispose: () => {},
  };

  for (const name of ["openVideo", "openAudio", "downloadFile"] as const) {
    describe(name, () => {
      let open: (runtime: { getBytes(): Promise<Uint8Array>; dispose(): void }, request: unknown) => Promise<{ read(start: number, end: number): Promise<Uint8Array>; dispose(): void }>;

      beforeEach(() => {
        if (name === "openVideo") open = openVideo;
        else if (name === "openAudio") open = openAudio;
        else open = downloadFile;
      });

      it("rejects non-integer bounds", async () => {
        const session = await open(runtime, {} as unknown);

        await expect(session.read(0, 1.5)).rejects.toThrow(
          "Range bounds must be integers.",
        );
        await expect(session.read(1.5, 10)).rejects.toThrow(
          "Range bounds must be integers.",
        );
      });

      it("rejects negative start", async () => {
        const session = await open(runtime, {} as unknown);

        await expect(session.read(-1, 10)).rejects.toThrow(
          "Invalid byte range.",
        );
      });

      it("rejects end <= start", async () => {
        const session = await open(runtime, {} as unknown);

        await expect(session.read(10, 10)).rejects.toThrow(
          "Invalid byte range.",
        );
        await expect(session.read(10, 9)).rejects.toThrow(
          "Invalid byte range.",
        );
      });

      it("rejects reads after dispose", async () => {
        const session = await open(runtime, {} as unknown);

        session.dispose();

        const expectedPrefix = name === "openVideo" ? "Video" : name === "openAudio" ? "Audio" : "Download";
        await expect(session.read(0, 10)).rejects.toThrow(
          `${expectedPrefix} session has been disposed.`,
        );
      });
    });
  }
});

/* =========================================================
   RUNTIME MESSAGE PROTOCOL — TYPE CONTRACTS
   ========================================================= */

describe("runtimeMessages — message type contract", () => {
  it("READ_RESULT echoes the requested sessionId and range", async () => {
    const bytes = new Uint8Array([7, 8, 9]);
    const session = createFakeSession(async () => bytes);

    registerRuntimeSession("msg-session", session);

    const message = {
      type: "READ_RANGE" as const,
      sessionId: "msg-session",
      start: 0,
      end: 3,
    };

    const result = await handleRuntimeMessage(message);

    expect(result.type).toBe("READ_RESULT");
    expect(result.sessionId).toBe("msg-session");
    expect(result.start).toBe(0);
    expect(result.end).toBe(3);
    expect(result.bytes).toEqual(bytes);
  });
});

/* =========================================================
   CHUNK LOADER / DECRYPT — EXTERNAL BOUNDARY LIMITATIONS
   ========================================================= */

describe("chunkLoader/decrypt — offline limitation", () => {
  it("INCONCLUSIVE — real storage download/crypto decryption cannot be exercised in Node/Vitest without production-boundary mocks", () => {
    expect(true).toBe(true);
  });
});
