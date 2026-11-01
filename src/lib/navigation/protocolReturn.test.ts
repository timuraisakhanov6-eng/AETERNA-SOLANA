/**
 * AETERNA - Protocol return context (R9-A57). Pure-unit suite.
 *
 * The state carries an ORIGIN TOKEN, never a URL. Resolution maps each
 * origin to a fixed destination; anything else falls back to Home.
 */

import { describe, expect, it } from "vitest";

import {
  PROTOCOL_RETURN_KEY,
  protocolReturnState,
  resolveProtocolReturn,
} from "./protocolReturn";

describe("protocolReturnState", () => {
  it("writes a namespaced origin token and nothing else", () => {
    expect(protocolReturnState("home")).toEqual({
      [PROTOCOL_RETURN_KEY]: { from: "home" },
    });
    expect(protocolReturnState("create")).toEqual({
      [PROTOCOL_RETURN_KEY]: { from: "create" },
    });
    expect(protocolReturnState("capsule")).toEqual({
      [PROTOCOL_RETURN_KEY]: { from: "capsule" },
    });
  });

  it("never stores a URL, path or fragment", () => {
    for (const from of ["home", "create", "capsule"] as const) {
      const serialized = JSON.stringify(protocolReturnState(from));
      expect(serialized).not.toContain("/");
      expect(serialized).not.toContain("#");
      expect(serialized).not.toContain("http");
    }
  });
});

describe("resolveProtocolReturn", () => {
  it("maps home to /", () => {
    expect(resolveProtocolReturn(protocolReturnState("home"))).toEqual({
      kind: "path",
      path: "/",
    });
  });

  it("maps create to /create", () => {
    expect(resolveProtocolReturn(protocolReturnState("create"))).toEqual({
      kind: "path",
      path: "/create",
    });
  });

  it("maps capsule to a history step (fragment restored by the browser)", () => {
    expect(resolveProtocolReturn(protocolReturnState("capsule"))).toEqual({
      kind: "history",
    });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty", {}],
    ["string", "home"],
    ["array", []],
    ["wrong namespace", { somethingElse: { from: "create" } }],
    ["unknown origin", { [PROTOCOL_RETURN_KEY]: { from: "admin" } }],
    ["missing origin", { [PROTOCOL_RETURN_KEY]: {} }],
    ["origin as object", { [PROTOCOL_RETURN_KEY]: { from: { path: "/x" } } }],
    ["url as origin", { [PROTOCOL_RETURN_KEY]: { from: "https://evil.test" } }],
    [
      "origin inherited from a prototype (not an own token)",
      Object.create({ [PROTOCOL_RETURN_KEY]: { from: "capsule" } }),
    ],
  ])("falls back to Home for %s", (_label, state) => {
    expect(resolveProtocolReturn(state)).toEqual({
      kind: "path",
      path: "/",
    });
  });

  it("accepts a null-prototype state object (own token, no host prototype)", () => {
    const state = Object.assign(Object.create(null), {
      [PROTOCOL_RETURN_KEY]: { from: "capsule" },
    });

    expect(resolveProtocolReturn(state)).toEqual({ kind: "history" });
  });

  it("ignores path-like values smuggled into a valid origin", () => {
    const tampered = {
      [PROTOCOL_RETURN_KEY]: {
        from: "create",
        path: "https://evil.test",
      },
    };

    // The destination is derived from the origin token only.
    expect(resolveProtocolReturn(tampered)).toEqual({
      kind: "path",
      path: "/create",
    });
  });
});
