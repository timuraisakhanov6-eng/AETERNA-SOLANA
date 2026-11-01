/**
 * AETERNA - boot recovery supervisor (R9-A65).
 *
 * Replaces the former 8 s watchdog in index.html, which redirected capsule
 * visitors to /emergency.html with location.replace() before the application
 * had any chance to report success or failure.
 *
 * Responsibilities
 * ----------------
 * - detect a REAL startup failure: the entry module failed to load or to
 *   evaluate, or the module ran but React never mounted;
 * - never treat a slow load, a font/image/media failure or a failed API
 *   request as a startup failure;
 * - allow at most two automatic reload attempts, with a short backoff, tracked
 *   per tab and per capsule in sessionStorage (the fragment is never stored);
 * - keep the browser on /capsule/:id#<capability>; when the budget is spent,
 *   render a recovery panel in the SAME document;
 * - hand over to Emergency Runtime only after an explicit click.
 *
 * Deliberately a plain classic script (no modules, no bundle, no third-party
 * code): it must run even when the SPA entry chunk fails to load, and it must
 * never be able to read or move the capability fragment anywhere.
 */
(function (global) {
  "use strict";

  var MAX_AUTO_ATTEMPTS = 2;
  var BACKOFF_MS = [1500, 3000];
  var ENTRY_FAILSAFE_MS = 60000;
  var MOUNT_FAILSAFE_MS = 20000;
  var STORAGE_PREFIX = "aeterna.boot.recovery.";
  var SCREEN_ID = "aeterna-recovery-screen";
  var CAPSULE_PATH = /^\/capsule\/([a-f0-9]{64})\/?$/;
  var ENTRY_SRC = /\/assets\/[A-Za-z0-9_.-]+\.js$/;

  /** Capsule id for a recipient capsule-open path, else "". */
  function capsuleIdFromPath(pathname) {
    if (typeof pathname !== "string") {
      return "";
    }
    var match = CAPSULE_PATH.exec(pathname);
    return match ? match[1] : "";
  }

  /** A capability fragment is present and non-empty. */
  function hasCapabilityFragment(hash) {
    return typeof hash === "string" && hash.charAt(0) === "#" && hash.length > 1;
  }

  /**
   * Emergency handoff. The identifier travels in the query string; the
   * capability stays in the fragment and is never copied into query data.
   */
  function buildEmergencyHref(capsuleId, hash) {
    if (!CAPSULE_PATH.test("/capsule/" + String(capsuleId))) {
      return "";
    }
    if (!hasCapabilityFragment(hash)) {
      return "";
    }
    return "/emergency.html?capsuleId=" + encodeURIComponent(capsuleId) + hash;
  }

  function createMemoryStorage() {
    var map = {};
    return {
      getItem: function (key) {
        return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
      },
      setItem: function (key, value) {
        map[key] = String(value);
      },
      removeItem: function (key) {
        delete map[key];
      }
    };
  }

  function storageKey(capsuleId) {
    return STORAGE_PREFIX + capsuleId;
  }

  function createSupervisor(deps) {
    var win = deps.win;
    var doc = deps.doc;
    var storage = deps.storage || createMemoryStorage();
    var timers = deps.timers || {
      setTimeout: function (fn, ms) {
        return win.setTimeout(fn, ms);
      },
      clearTimeout: function (handle) {
        win.clearTimeout(handle);
      }
    };

    var capsuleId = capsuleIdFromPath(win.location.pathname);
    var applicable = capsuleId !== "" && hasCapabilityFragment(win.location.hash);

    var state = {
      applicable: applicable,
      capsuleId: capsuleId,
      phase: applicable ? "idle" : "inactive",
      attempts: 0,
      failure: ""
    };

    var entryTimer = null;
    var mountTimer = null;
    var retryTimer = null;
    var entrySrc = "";
    var started = false;

    function readAttempts() {
      try {
        var raw = storage.getItem(storageKey(capsuleId));
        var parsed = parseInt(raw, 10);
        if (!isFinite(parsed) || parsed < 0) {
          return 0;
        }
        return Math.min(parsed, MAX_AUTO_ATTEMPTS);
      } catch (error) {
        return 0;
      }
    }

    function writeAttempts(value) {
      try {
        storage.setItem(storageKey(capsuleId), String(value));
      } catch (error) {
        /* private mode / quota: retries still work, just not across reloads */
      }
    }

    function clearAttempts() {
      try {
        storage.removeItem(storageKey(capsuleId));
      } catch (error) {
        /* ignore */
      }
    }

    function clearTimers() {
      if (entryTimer !== null) {
        timers.clearTimeout(entryTimer);
        entryTimer = null;
      }
      if (mountTimer !== null) {
        timers.clearTimeout(mountTimer);
        mountTimer = null;
      }
      if (retryTimer !== null) {
        timers.clearTimeout(retryTimer);
        retryTimer = null;
      }
    }

    function settled() {
      return state.phase === "ok" || state.phase === "failed" || state.phase === "recovering";
    }

    function findEntryScript() {
      if (!doc || typeof doc.querySelector !== "function") {
        return "";
      }
      var element = doc.querySelector('script[type="module"][src]');
      if (!element) {
        return "";
      }
      var src = element.src || element.getAttribute("src") || "";
      return String(src).split("?")[0];
    }

    function isEntrySource(value) {
      if (!entrySrc || typeof value !== "string" || value === "") {
        return false;
      }
      var raw = String(value).split("?")[0];
      if (raw === entrySrc) {
        return true;
      }
      /* Relative vs absolute form of the same asset. */
      return ENTRY_SRC.test(raw) && entrySrc.indexOf(raw) !== -1;
    }

    function removeScreen() {
      if (!doc || typeof doc.getElementById !== "function") {
        return;
      }
      var existing = doc.getElementById(SCREEN_ID);
      if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
      }
    }

    function button(label, primary) {
      var element = doc.createElement("button");
      element.type = "button";
      element.textContent = label;
      element.style.cssText = [
        "display:block",
        "width:100%",
        "min-height:46px",
        "margin-top:12px",
        "padding:13px 18px",
        "border-radius:12px",
        "font:inherit",
        "font-size:14px",
        "letter-spacing:0.02em",
        "cursor:pointer",
        primary
          ? "border:1px solid rgba(251,191,36,0.75);background:rgba(251,191,36,0.14);color:#fde68a"
          : "border:1px solid rgba(232,228,220,0.16);background:transparent;color:rgba(232,228,220,0.72)"
      ].join(";");
      return element;
    }

    function showScreen() {
      if (!doc || typeof doc.createElement !== "function") {
        return;
      }
      if (doc.getElementById(SCREEN_ID)) {
        return;
      }

      var screen = doc.createElement("div");
      screen.id = SCREEN_ID;
      screen.setAttribute("role", "dialog");
      screen.setAttribute("aria-modal", "true");
      screen.setAttribute("aria-labelledby", "aeterna-recovery-title");
      screen.style.cssText = [
        "position:fixed",
        "inset:0",
        "z-index:2147483647",
        "display:flex",
        "align-items:center",
        "justify-content:center",
        "padding:24px",
        "background:#0d0f14",
        "color:#e8e4dc",
        "font-family:system-ui,-apple-system,sans-serif"
      ].join(";");

      var card = doc.createElement("div");
      card.style.cssText = [
        "width:100%",
        "max-width:400px",
        "padding:34px 26px",
        "border:1px solid rgba(255,200,140,0.16)",
        "border-radius:20px",
        "background:linear-gradient(180deg,rgba(255,200,140,0.05),transparent 70%)",
        "text-align:center"
      ].join(";");

      var eyebrow = doc.createElement("p");
      eyebrow.textContent = "AETERNA";
      eyebrow.style.cssText =
        "margin:0 0 14px;font-size:10px;letter-spacing:0.24em;text-transform:uppercase;color:rgba(251,191,36,0.7)";

      var title = doc.createElement("h1");
      title.id = "aeterna-recovery-title";
      title.textContent = "This capsule view could not start";
      title.style.cssText =
        "margin:0 0 12px;font-size:20px;font-weight:500;line-height:1.35;letter-spacing:0.01em";

      var body = doc.createElement("p");
      body.textContent =
        "The link in your address bar is unchanged and nothing has been opened or altered.";
      body.style.cssText =
        "margin:0;font-size:13px;line-height:1.7;color:rgba(232,228,220,0.55)";

      var retry = button("Try Main View Again", true);
      retry.id = "aeterna-recovery-retry";
      retry.addEventListener("click", retryNow);

      var emergency = button("Open Emergency View", false);
      emergency.id = "aeterna-recovery-emergency";
      emergency.addEventListener("click", openEmergency);

      var hint = doc.createElement("p");
      hint.textContent =
        "Emergency View uses the same decryption, trusted-time and opening rules.";
      hint.style.cssText =
        "margin:18px 0 0;font-size:11px;line-height:1.6;color:rgba(232,228,220,0.3)";

      card.appendChild(eyebrow);
      card.appendChild(title);
      card.appendChild(body);
      card.appendChild(retry);
      card.appendChild(emergency);
      card.appendChild(hint);
      screen.appendChild(card);

      (doc.body || doc.documentElement).appendChild(screen);

      if (typeof retry.focus === "function") {
        retry.focus();
      }
    }

    function retryNow() {
      clearAttempts();
      state.attempts = 0;
      state.phase = "recovering";
      removeScreen();
      win.location.reload();
    }

    function openEmergency() {
      var href = buildEmergencyHref(capsuleId, win.location.hash);
      if (!href) {
        return;
      }
      win.location.assign(href);
    }

    function fail(reason) {
      if (settled()) {
        return;
      }
      clearTimers();
      state.failure = reason;

      if (state.attempts >= MAX_AUTO_ATTEMPTS) {
        state.phase = "failed";
        showScreen();
        return;
      }

      state.attempts += 1;
      writeAttempts(state.attempts);
      state.phase = "recovering";

      var delay = BACKOFF_MS[Math.min(state.attempts - 1, BACKOFF_MS.length - 1)];
      retryTimer = timers.setTimeout(function () {
        retryTimer = null;
        win.location.reload();
      }, delay);
    }

    function onReady() {
      if (state.phase !== "waiting-entry") {
        return;
      }
      if (entryTimer !== null) {
        timers.clearTimeout(entryTimer);
        entryTimer = null;
      }
      state.phase = "waiting-mount";
      mountTimer = timers.setTimeout(function () {
        mountTimer = null;
        /* The module executed but React never committed a frame. */
        fail("mount-timeout");
      }, MOUNT_FAILSAFE_MS);
    }

    function onMounted() {
      if (!applicable) {
        return;
      }
      clearTimers();
      state.phase = "ok";
      state.attempts = 0;
      state.failure = "";
      clearAttempts();
      removeScreen();
    }

    function onError(event) {
      if (!applicable || settled()) {
        return;
      }

      var target = event && event.target;

      if (target && target !== win && target !== doc && target.tagName) {
        /* Resource error: only the entry module itself is fatal. */
        if (String(target.tagName).toUpperCase() === "SCRIPT" && isEntrySource(target.src)) {
          fail("entry-load");
        }
        return;
      }

      if (isEntrySource(event && event.filename)) {
        fail("entry-eval");
      }
    }

    function start() {
      if (started) {
        return false;
      }
      started = true;

      if (!applicable) {
        state.phase = "inactive";
        return false;
      }

      state.attempts = readAttempts();
      state.phase = "waiting-entry";
      entrySrc = findEntryScript();

      entryTimer = timers.setTimeout(function () {
        entryTimer = null;
        if (state.phase !== "waiting-entry") {
          return;
        }
        /*
         * Conservative failsafe: a slow device or network is NOT declared
         * broken and is never reloaded. The user is offered a choice instead.
         */
        state.failure = "entry-timeout";
        state.phase = "failed";
        showScreen();
      }, ENTRY_FAILSAFE_MS);

      win.addEventListener("aeterna:ready", onReady);
      win.addEventListener("aeterna:mounted", onMounted);
      win.addEventListener("error", onError, true);
      return true;
    }

    function destroy() {
      clearTimers();
      started = false;
      win.removeEventListener("aeterna:ready", onReady);
      win.removeEventListener("aeterna:mounted", onMounted);
      win.removeEventListener("error", onError, true);
      removeScreen();
    }

    return {
      start: start,
      destroy: destroy,
      getState: function () {
        return {
          applicable: state.applicable,
          capsuleId: state.capsuleId,
          phase: state.phase,
          attempts: state.attempts,
          failure: state.failure
        };
      },
      /* Test/dev seams. */
      reportFailure: fail,
      notifyReady: onReady,
      notifyMounted: onMounted,
      reportError: onError,
      showRecoveryScreen: showScreen,
      retryNow: retryNow,
      openEmergency: openEmergency,
      buildEmergencyHref: buildEmergencyHref,
      storageKey: storageKey
    };
  }

  var api = {
    createSupervisor: createSupervisor,
    buildEmergencyHref: buildEmergencyHref,
    capsuleIdFromPath: capsuleIdFromPath,
    hasCapabilityFragment: hasCapabilityFragment,
    MAX_AUTO_ATTEMPTS: MAX_AUTO_ATTEMPTS
  };

  if (global) {
    global.AETERNABootRecovery = api;

    if (!global.__AETERNA_BOOT_NO_AUTOSTART__ && global.document && global.location) {
      var storage = createMemoryStorage();
      try {
        if (global.sessionStorage) {
          storage = global.sessionStorage;
        }
      } catch (error) {
        storage = createMemoryStorage();
      }
      api.instance = createSupervisor({
        win: global,
        doc: global.document,
        storage: storage
      });
      api.instance.start();
    }
  }
})(typeof window !== "undefined" ? window : null);