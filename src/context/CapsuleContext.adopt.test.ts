// @vitest-environment jsdom
/**
 * AETERNA — CapsuleContext adoptCapsuleId (Phase 3BM-R4) — focused tests.
 *
 * The resume path re-points the session identity root at an EXISTING,
 * server-validated capsule id. These tests pin:
 *   - the adoption makes the adopted id visible to consumers (the provider
 *     value is rebuilt on the next render — exactly how the resume
 *     navigation into /create/hold consumes it);
 *   - a non-canonical id is silently refused (fail-closed);
 *   - normal NEW-capsule generation is unchanged (fresh mount produces a
 *     canonical 64-hex id; resetCapsule re-rolls a DIFFERENT one).
 *
 * No network, no wallet, no storage side effects.
 */

import { describe, expect, it, afterEach } from "vitest";
import { createElement } from "react";
import { render, screen, act, cleanup } from "@testing-library/react";

import { CapsuleProvider, useCapsule } from "./CapsuleContext";

const ADOPTED_ID = "a".repeat(64);
const OTHER_VALID_ID = "b".repeat(64);

function Probe() {
  const { capsuleId, adoptCapsuleId, resetCapsule } = useCapsule();
  return createElement(
    "div",
    {},
    createElement("div", { "data-testid": "capsule-id" }, capsuleId),
    createElement(
      "button",
      { "data-testid": "adopt", onClick: () => adoptCapsuleId(ADOPTED_ID) },
      "adopt"
    ),
    createElement(
      "button",
      {
        "data-testid": "adopt-other",
        onClick: () => adoptCapsuleId(OTHER_VALID_ID),
      },
      "adopt-other"
    ),
    createElement(
      "button",
      {
        "data-testid": "adopt-invalid",
        onClick: () => adoptCapsuleId("not-a-capsule-id"),
      },
      "adopt-invalid"
    ),
    createElement(
      "button",
      { "data-testid": "reset", onClick: () => resetCapsule() },
      "reset"
    )
  );
}

const tree = () => createElement(CapsuleProvider, null, createElement(Probe));

const readId = () =>
  (screen.getByTestId("capsule-id") as HTMLElement).textContent;

const click = (testId: string) => {
  (screen.getByTestId(testId) as HTMLButtonElement).click();
};

describe("CapsuleContext adoptCapsuleId", () => {
  afterEach(() => {
    cleanup();
  });

  it("adopts a canonical existing capsule id", () => {
    const view = render(tree());
    const fresh = readId();
    expect(fresh).toMatch(/^[a-f0-9]{64}$/);

    act(() => {
      click("adopt");
    });
    // Force the provider re-render: the value object is rebuilt and the
    // adopted ref becomes visible — the same way the resume navigation
    // remounts CapsuleHold after the gate adopts the id.
    view.rerender(tree());
    expect(readId()).toBe(ADOPTED_ID);
  });

  it("refuses a non-canonical id without changing the root", () => {
    const view = render(tree());

    act(() => {
      click("adopt");
    });
    view.rerender(tree());
    expect(readId()).toBe(ADOPTED_ID);

    act(() => {
      click("adopt-invalid");
    });
    view.rerender(tree());
    expect(readId()).toBe(ADOPTED_ID);
  });

  it("adopts a different valid id later (idempotent re-pointing)", () => {
    const view = render(tree());

    act(() => {
      click("adopt");
    });
    view.rerender(tree());
    expect(readId()).toBe(ADOPTED_ID);

    act(() => {
      click("adopt-other");
    });
    view.rerender(tree());
    expect(readId()).toBe(OTHER_VALID_ID);
  });

  it("leaves normal new-capsule generation untouched", () => {
    const view = render(tree());
    const fresh = readId();
    expect(fresh).toMatch(/^[a-f0-9]{64}$/);

    act(() => {
      click("reset");
    });
    view.rerender(tree());
    const regenerated = readId();
    expect(regenerated).toMatch(/^[a-f0-9]{64}$/);
    expect(regenerated).not.toBe(fresh);

    // A valid adoption still works after a reset — and a reset after an
    // adoption re-rolls a NEW id instead of returning to the adopted one.
    act(() => {
      click("adopt");
    });
    view.rerender(tree());
    expect(readId()).toBe(ADOPTED_ID);

    act(() => {
      click("reset");
    });
    view.rerender(tree());
    expect(readId()).toMatch(/^[a-f0-9]{64}$/);
    expect(readId()).not.toBe(ADOPTED_ID);
  });
});
