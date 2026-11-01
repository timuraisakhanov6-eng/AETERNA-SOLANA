// @vitest-environment jsdom
/**
 * AETERNA — R9-A82 layout contract: the Emergency Runtime return control is
 * persisted ONLY while the opened content is on screen.
 *
 * TWO DISTINCT PRESENTATION STATES (owner clarification, R9-A82)
 * --------------------------------------------------------------
 * 1. SEALED — the control stays exactly where it has always been: inside the
 *    document footer, in normal flow, never fixed or sticky, no extra bottom
 *    padding. This file pins that the shipped CSS cannot reach it.
 * 2. OPENED — the footer becomes the fixed bottom surface, the content
 *    scrolls beneath it, bottom space is reserved so the final item (and any
 *    native video controls) can always scroll clear, and the mobile
 *    safe-area inset is honoured. The button's own styling and its handler
 *    are untouched; only the surface it sits on is positioned.
 *
 * The state class is added by the page's own showState(), which runs only on
 * the runtime's explicit "opened" outcome. The sealed and opening states
 * never receive it, so their layout cannot change.
 *
 * These are structural/DOM tests (jsdom), not a visual browser run: they pin
 * the rules, the scoping and the state transition, which are the parts a
 * regression would break.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const HTML = readFileSync(resolve(REPO_ROOT, "public/emergency.html"), "utf8");

type CssRule = { selector: string; body: string };

function cssRules(css: string): CssRule[] {
  // Comments sit between rules in this stylesheet; strip them so a selector
  // is the selector and not the trailing banner of the previous block.
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: CssRule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null = re.exec(clean);
  while (match !== null) {
    out.push({
      selector: (match[1] ?? "").trim().replace(/\s+/g, " "),
      body: match[2] ?? "",
    });
    match = re.exec(clean);
  }
  return out;
}

const STYLE = (() => {
  const match = /<style>([\s\S]*?)<\/style>/.exec(HTML);
  if (!match) throw new Error("emergency.html has no <style> block");
  return match[1] ?? "";
})();

const RULES = cssRules(STYLE);

const STATE_START = "/* R9-A82 STATE CLASS:START */";
const STATE_END = "/* R9-A82 STATE CLASS:END */";

const STATE_SRC = (() => {
  const start = HTML.indexOf(STATE_START);
  const end = HTML.indexOf(STATE_END);
  if (start < 0 || end < 0) {
    throw new Error("R9-A82 state-class markers missing from emergency.html");
  }
  return HTML.slice(start, end + STATE_END.length);
})();

/** Evaluate the page's own showState() against the jsdom state elements. */
function buildShowState(): (which: HTMLElement) => void {
  const stateSealed = document.getElementById("state-sealed");
  const stateOpening = document.getElementById("state-opening");
  const stateOpened = document.getElementById("state-opened");
  if (!stateSealed || !stateOpening || !stateOpened) {
    throw new Error("state elements missing from the fixture DOM");
  }
  const factory = new Function(
    "stateSealed",
    "stateOpening",
    "stateOpened",
    STATE_SRC + "\nreturn showState;"
  ) as unknown as (
    sealed: HTMLElement,
    opening: HTMLElement,
    opened: HTMLElement
  ) => (which: HTMLElement) => void;
  return factory(stateSealed, stateOpening, stateOpened);
}

describe("R9-A82 return control: opened-only persistence", () => {
  beforeEach(() => {
    document.body.className = "";
    document.body.innerHTML =
      '<div id="state-sealed" class="state active"></div>' +
      '<div id="state-opening" class="state"></div>' +
      '<div id="state-opened" class="state"></div>';
  });

  it("SEALED: no rule can make the control fixed or sticky outside the opened state", () => {
    const offenders = RULES.filter(
      (rule) =>
        /position\s*:\s*(fixed|sticky)/i.test(rule.body) &&
        /(return-link|footer)/i.test(rule.selector) &&
        !rule.selector.includes("body.is-opened")
    );
    expect(offenders).toEqual([]);
  });

  it("SEALED: the button's own styling is unchanged", () => {
    const base = RULES.find((rule) => rule.selector === ".return-link");
    expect(base).toBeDefined();
    expect(base?.body).not.toMatch(/position\s*:/i);
    expect(base?.body).not.toMatch(/safe-area/i);
    expect(base?.body).toMatch(/padding:6px 12px/);
    expect(base?.body).toMatch(/border-radius:999px/);
    expect(base?.body).toMatch(/background:transparent/);
  });

  it("OPENED: the footer is pinned to the viewport bottom with safe-area insets", () => {
    const openedFooter = RULES.filter(
      (rule) => rule.selector === "body.is-opened footer"
    );
    expect(openedFooter).toHaveLength(1);
    const body = openedFooter[0]?.body ?? "";
    expect(body).toMatch(/position\s*:\s*fixed/);
    expect(body).toMatch(/bottom\s*:\s*0/);
    expect(body).toMatch(/env\(safe-area-inset-bottom/);
    expect(body).toMatch(/z-index\s*:\s*\d+/);
  });

  it("OPENED: bottom space is reserved so the final content stays reachable", () => {
    const openedBody = RULES.filter((rule) => rule.selector === "body.is-opened");
    expect(openedBody).toHaveLength(1);
    const body = openedBody[0]?.body ?? "";
    expect(body).toMatch(/padding-bottom\s*:\s*calc\(/);
    expect(body).toMatch(/env\(safe-area-inset-bottom/);
    const reserve = /padding-bottom\s*:\s*calc\((\d+)px/.exec(body)?.[1];
    expect(Number(reserve)).toBeGreaterThanOrEqual(96);
  });

  it("OPENED: the class is applied only for the opened state and removed on return", () => {
    const showState = buildShowState();
    const sealed = document.getElementById("state-sealed") as HTMLElement;
    const opening = document.getElementById("state-opening") as HTMLElement;
    const opened = document.getElementById("state-opened") as HTMLElement;

    showState(sealed);
    expect(document.body.classList.contains("is-opened")).toBe(false);
    expect(sealed.classList.contains("active")).toBe(true);

    showState(opening);
    expect(document.body.classList.contains("is-opened")).toBe(false);

    showState(opened);
    expect(document.body.classList.contains("is-opened")).toBe(true);
    expect(opened.classList.contains("active")).toBe(true);

    showState(sealed);
    expect(document.body.classList.contains("is-opened")).toBe(false);
  });

  it("NAVIGATION: the return control and its fragment-only secret handling are intact", () => {
    expect(HTML).toContain("/* R9-A65 RETURN CONTROL:START */");
    expect(HTML).toContain("/* R9-A65 RETURN CONTROL:END */");
    expect(HTML).toContain('id="returnToCapsule"');
    expect(HTML).toContain("Back to Main Capsule");
    expect(HTML).toContain("loc.hash");
    expect(HTML).toContain("/capsule/");
    expect(HTML).not.toMatch(/localStorage|sessionStorage/);
  });
});
