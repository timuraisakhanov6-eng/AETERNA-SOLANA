/**
 * =========================================================
 * AETERNA — Container upload feature flag tests (Stage 3)
 * =========================================================
 *
 * The flag must be OFF by default, deterministic, and impossible to
 * enable by accident through a truthy / non-string / undefined value.
 */
import { describe, it, expect } from "vitest";

import {
  CONTAINER_UPLOAD_ENV_KEY,
  CONTAINER_UPLOAD_ENABLED_TOKEN,
  isContainerUploadEnabled,
} from "./containerUploadFlag";

describe("container upload feature flag", () => {
  it("is OFF when the variable is absent", () => {
    expect(isContainerUploadEnabled({})).toBe(false);
  });

  it("is OFF for every non-string value (no truthiness coercion)", () => {
    const values: unknown[] = [
      undefined,
      null,
      1,
      0,
      true,
      false,
      {},
      [],
      () => "true",
      Symbol("true"),
      BigInt(1),
    ];

    for (const value of values) {
      expect(
        isContainerUploadEnabled({ [CONTAINER_UPLOAD_ENV_KEY]: value })
      ).toBe(false);
    }
  });

  it("is OFF for unrecognised strings", () => {
    for (const raw of [
      "",
      " ",
      "false",
      "0",
      "yes",
      "on",
      "enabled",
      "TRUE_ENOUGH",
      "1",
      "2",
    ]) {
      expect(
        isContainerUploadEnabled({ [CONTAINER_UPLOAD_ENV_KEY]: raw })
      ).toBe(false);
    }
  });

  it("is ON only for the exact token, case-insensitively", () => {
    for (const raw of ["true", "TRUE", "True", "  true  ", "\ttrue\n"]) {
      expect(
        isContainerUploadEnabled({ [CONTAINER_UPLOAD_ENV_KEY]: raw })
      ).toBe(true);
    }
  });

  it("exposes the canonical key and token", () => {
    expect(CONTAINER_UPLOAD_ENV_KEY).toBe("VITE_AETERNA_CONTAINER_UPLOAD");
    expect(CONTAINER_UPLOAD_ENABLED_TOKEN).toBe("true");
  });

  it("is deterministic for identical input", () => {
    const env = { [CONTAINER_UPLOAD_ENV_KEY]: "true" };

    expect(isContainerUploadEnabled(env)).toBe(isContainerUploadEnabled(env));
  });

  it("ignores unrelated environment keys", () => {
    expect(
      isContainerUploadEnabled({ VITE_SOMETHING_ELSE: "true", MODE: "production" })
    ).toBe(false);
  });

  it("is OFF for a malformed environment object", () => {
    expect(isContainerUploadEnabled(null as never)).toBe(false);
    expect(isContainerUploadEnabled("true" as never)).toBe(false);
  });

  it("defaults to OFF in the ambient test environment", () => {
    // No VITE_AETERNA_CONTAINER_UPLOAD is set for the suite.
    expect(isContainerUploadEnabled()).toBe(false);
  });
});
