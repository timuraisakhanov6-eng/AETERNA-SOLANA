// @vitest-environment jsdom
/**
 * AETERNA - boot recovery supervisor (R9-A65).
 *
 * These tests execute the SHIPPED source of `public/boot-recovery.js` inside a
 * sandbox, so they pin the real artefact rather than a copy of its logic.
 *
 * The supervisor must never turn a slow load into a failure, must ignore
 * non-critical resource errors, must detect a genuinely broken entry module,
 * must retry at most twice, and must always keep the capsule URL and its
 * fragment untouched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");

const SUPERVISOR_SRC = readFileSync(
  resolve(REPO_ROOT, "public/boot-recovery.js"),
  "utf8"
);
const INDEX_HTML = readFileSync(resolve(REPO_ROOT, "index.html"), "utf8");

const CAPSULE_ID = "c".repeat(64);
const SECRET = "a".repeat(64);
const FRAGMENT = "#" + SECRET;
const CAPSULE_PATH = "/capsule/" + CAPSULE_ID;
const ENTRY_SRC = "https://app.test/assets/index-abc123.js";

type Storage = {
  data: Record<string, string>;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

function memoryStorage(): Storage {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: (key) => (key in data ? data[key] ?? null : null),
    setItem: (key, value) => {
      data[key] = String(value);
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

type FakeWindow = {
  location: {
    pathname: string;
    hash: string;
    assign: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
  };
  addEventListener: (type: string, fn: (event?: unknown) => void) => void;
  removeEventListener: (type: string, fn: (event?: unknown) => void) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  emit: (type: string, event?: unknown) => void;
  listenerCount: (type: string) => number;
};

function fakeWindow(pathname: string, hash: string): FakeWindow {
  const listeners: Record<string, Array<(event?: unknown) => void>> = {};

  const win: FakeWindow = {
    location: {
      pathname,
      hash,
      assign: vi.fn(),
      reload: vi.fn(),
    },
    addEventListener: (type, fn) => {
      (listeners[type] = listeners[type] ?? []).push(fn);
    },
    removeEventListener: (type, fn) => {
      listeners[type] = (listeners[type] ?? []).filter((entry) => entry !== fn);
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    emit: (type, event) => {
      (listeners[type] ?? []).slice().forEach((fn) => fn(event));
    },
    listenerCount: (type) => (listeners[type] ?? []).length,
  };

  return win;
}

type SupervisorState = {
  applicable: boolean;
  capsuleId: string;
  phase: string;
  attempts: number;
  failure: string;
};

type Supervisor = {
  start: () => boolean;
  destroy: () => void;
  getState: () => SupervisorState;
  storageKey: (capsuleId: string) => string;
  buildEmergencyHref: (capsuleId: string, hash: string) => string;
};

type SupervisorFactory = {
  createSupervisor: (deps: {
    win: FakeWindow;
    doc: Document;
    storage: Storage;
  }) => Supervisor;
};

/** Evaluates the shipped supervisor source with injected globals. */
function loadFactory() {
  const sandbox: Record<string, unknown> = {
    __AETERNA_BOOT_NO_AUTOSTART__: true,
  };
  const storage = memoryStorage();
  const run = new Function(
    "window",
    "document",
    "sessionStorage",
    "console",
    SUPERVISOR_SRC
  );
  run(sandbox, document, storage, console);
  return { sandbox, storage, api: sandbox["AETERNABootRecovery"] as SupervisorFactory };
}

function mountEntryScript(src: string) {
  const script = document.createElement("script");
  script.type = "module";
  script.src = src;
  document.head.appendChild(script);
  return script;
}

function create(options: {
  pathname?: string;
  hash?: string;
  attempts?: number;
  entrySrc?: string;
} = {}) {
  const pathname = options.pathname ?? CAPSULE_PATH;
  const hash = options.hash ?? FRAGMENT;

  const { api, storage } = loadFactory();
  if (typeof options.attempts === "number") {
    storage.setItem("aeterna.boot.recovery." + CAPSULE_ID, String(options.attempts));
  }

  document.body.innerHTML = "";
  document.head.innerHTML = "";

  const entry = options.entrySrc ? mountEntryScript(options.entrySrc) : null;
  const win = fakeWindow(pathname, hash);
  const supervisor = api.createSupervisor({ win, doc: document, storage });

  return { supervisor, win, storage, entry };
}

function screen() {
  return document.getElementById("aeterna-recovery-screen");
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("R9-A65 boot supervisor - failure classification", () => {
  it("does not treat a slow entry load as a failure", () => {
    const { supervisor, win } = create({ entrySrc: ENTRY_SRC });
    supervisor.start();

    vi.advanceTimersByTime(30_000);

    expect(win.location.reload).not.toHaveBeenCalled();
    expect(win.location.assign).not.toHaveBeenCalled();
    expect(screen()).toBeNull();
    expect(supervisor.getState().phase).toBe("waiting-entry");
  });

  it("ignores font, image, media and API failures", () => {
    const { supervisor, win } = create({ entrySrc: ENTRY_SRC });
    supervisor.start();

    const image = document.createElement("img");
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    const video = document.createElement("video");

    win.emit("error", { target: image });
    win.emit("error", { target: stylesheet });
    win.emit("error", { target: video });
    win.emit("error", {
      target: win,
      filename: "https://api.aeterna.test/api/time",
      message: "Failed to fetch",
    });

    vi.advanceTimersByTime(120_000);

    expect(win.location.reload).not.toHaveBeenCalled();
    expect(win.location.assign).not.toHaveBeenCalled();
  });

  it("detects a broken entry module", () => {
    const { supervisor, win, entry } = create({ entrySrc: ENTRY_SRC });
    supervisor.start();

    win.emit("error", { target: entry });

    expect(supervisor.getState().phase).toBe("recovering");
    expect(supervisor.getState().attempts).toBe(1);

    vi.advanceTimersByTime(1_500);

    expect(win.location.reload).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a mounted app from entry-module readiness", () => {
    const { supervisor, win } = create({ entrySrc: ENTRY_SRC });
    supervisor.start();

    win.emit("aeterna:ready");
    expect(supervisor.getState().phase).toBe("waiting-mount");

    vi.advanceTimersByTime(5_000);
    expect(win.location.reload).not.toHaveBeenCalled();

    win.emit("aeterna:mounted");
    expect(supervisor.getState().phase).toBe("ok");
    expect(win.location.reload).not.toHaveBeenCalled();
  });

  it("treats module-ready-without-mount as a startup failure", () => {
    const { supervisor, win } = create({ entrySrc: ENTRY_SRC });
    supervisor.start();

    win.emit("aeterna:ready");

    vi.advanceTimersByTime(20_000);
    expect(supervisor.getState().failure).toBe("mount-timeout");
    expect(win.location.reload).not.toHaveBeenCalled();

    // The retry itself still honours the backoff.
    vi.advanceTimersByTime(1_500);
    expect(win.location.reload).toHaveBeenCalledTimes(1);
  });

  it("does nothing on a non-capsule route or without a fragment", () => {
    const other = create({ pathname: "/protocol" });
    expect(other.supervisor.start()).toBe(false);
    expect(other.win.listenerCount("error")).toBe(0);

    const noFragment = create({ hash: "#" });
    expect(noFragment.supervisor.start()).toBe(false);
  });
});

describe("R9-A65 boot supervisor - retry budget", () => {
  it("allows at most two automatic attempts", () => {
    const first = create({ entrySrc: ENTRY_SRC });
    first.supervisor.start();
    first.win.emit("error", { target: first.entry });
    expect(first.storage.getItem("aeterna.boot.recovery." + CAPSULE_ID)).toBe("1");

    vi.advanceTimersByTime(1_500);
    expect(first.win.location.reload).toHaveBeenCalledTimes(1);

    const second = create({ entrySrc: ENTRY_SRC, attempts: 1 });
    second.supervisor.start();
    second.win.emit("error", { target: second.entry });
    expect(second.storage.getItem("aeterna.boot.recovery." + CAPSULE_ID)).toBe("2");

    vi.advanceTimersByTime(3_000);
    expect(second.win.location.reload).toHaveBeenCalledTimes(1);
    expect(second.win.location.assign).not.toHaveBeenCalled();
  });

  it("shows the panel instead of reloading once the budget is spent", () => {
    const { supervisor, win, entry } = create({ entrySrc: ENTRY_SRC, attempts: 2 });
    supervisor.start();

    win.emit("error", { target: entry });

    expect(supervisor.getState().phase).toBe("failed");
    expect(win.location.reload).not.toHaveBeenCalled();
    expect(win.location.assign).not.toHaveBeenCalled();
    expect(screen()).not.toBeNull();
  });

  it("scopes the retry state to the tab and capsule, and stores no secret", () => {
    const { supervisor, win, storage, entry } = create({ entrySrc: ENTRY_SRC });
    supervisor.start();
    win.emit("error", { target: entry });

    const key = supervisor.storageKey(CAPSULE_ID);
    expect(key).toBe("aeterna.boot.recovery." + CAPSULE_ID);
    expect(storage.getItem(key)).toBe("1");

    const dump = JSON.stringify(storage.data);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain("#");
  });

  it("resets the retry state after a successful mount", () => {
    const { supervisor, win, storage } = create({ entrySrc: ENTRY_SRC, attempts: 2 });
    supervisor.start();
    expect(storage.getItem("aeterna.boot.recovery." + CAPSULE_ID)).toBe("2");

    win.emit("aeterna:mounted");

    expect(storage.getItem("aeterna.boot.recovery." + CAPSULE_ID)).toBeNull();
    expect(supervisor.getState().phase).toBe("ok");
    expect(screen()).toBeNull();
  });
});

describe("R9-A65 boot supervisor - recovery panel", () => {
  function failing() {
    const created = create({ entrySrc: ENTRY_SRC, attempts: 2 });
    created.supervisor.start();
    created.win.emit("error", { target: created.entry });
    return created;
  }

  it("keeps the original capsule URL and never navigates", () => {
    const { win } = failing();

    expect(screen()).not.toBeNull();
    expect(win.location.pathname).toBe(CAPSULE_PATH);
    expect(win.location.hash).toBe(FRAGMENT);
    expect(win.location.assign).not.toHaveBeenCalled();
    expect(win.location.reload).not.toHaveBeenCalled();

    expect(document.body.textContent).toContain("Try Main View Again");
    expect(document.body.textContent).toContain("Open Emergency View");
  });

  it("Try Main View Again clears the budget and reloads in place", () => {
    const { win, storage } = failing();

    const retry = document.getElementById("aeterna-recovery-retry");
    expect(retry).not.toBeNull();
    (retry as HTMLButtonElement).click();

    expect(storage.getItem("aeterna.boot.recovery." + CAPSULE_ID)).toBeNull();
    expect(win.location.reload).toHaveBeenCalledTimes(1);
    expect(win.location.assign).not.toHaveBeenCalled();
    expect(win.location.hash).toBe(FRAGMENT);
    expect(screen()).toBeNull();
  });

  it("Open Emergency View keeps the capability in the fragment only", () => {
    const { win } = failing();

    const emergency = document.getElementById("aeterna-recovery-emergency");
    expect(emergency).not.toBeNull();
    (emergency as HTMLButtonElement).click();

    expect(win.location.assign).toHaveBeenCalledTimes(1);

    const call = win.location.assign.mock.calls.at(0);
    expect(call).toBeDefined();
    const href = String(call ? call[0] : "");
    const [path, fragment] = href.split("#");

    expect(path).toBe("/emergency.html?capsuleId=" + CAPSULE_ID);
    expect(fragment).toBe(SECRET);
    expect(path).not.toContain(SECRET);
    expect(href.startsWith("/emergency.html?capsuleId=")).toBe(true);
  });

  it("never redirects automatically on transient errors", () => {
    const { supervisor, win } = create({ entrySrc: ENTRY_SRC });
    supervisor.start();

    win.emit("error", { target: document.createElement("img") });
    win.emit("error", { target: win, filename: "https://api.aeterna.test/x" });
    vi.advanceTimersByTime(120_000);

    expect(win.location.assign).not.toHaveBeenCalled();
    expect(win.location.reload).not.toHaveBeenCalled();
  });
});

describe("R9-A65 index.html wiring", () => {
  it("loads the supervisor and no longer ships the 8 s emergency redirect", () => {
    expect(INDEX_HTML).toContain("/boot-recovery.js");

    expect(INDEX_HTML).not.toContain("EMERGENCY WATCHDOG");
    expect(INDEX_HTML).not.toContain("TIMEOUT_MS = 8000");
    expect(INDEX_HTML).not.toContain("/emergency.html?capsuleId=");
    expect(INDEX_HTML).not.toContain("location.replace(");
  });
});