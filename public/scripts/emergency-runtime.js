function Ne(e, t) {
  const n = [], r = /* @__PURE__ */ new Set();
  for (const i of e) {
    if (r.has(i.chunkId))
      throw new Error(
        `[AETERNA] Duplicate chunkId: ${i.chunkId}`
      );
    r.add(i.chunkId);
    const c = t[i.chunkId];
    if (!c)
      throw new Error(
        `[AETERNA] Missing storage pointer for chunk ${i.chunkId}`
      );
    n.push(
      Object.freeze({
        ...i,
        pointer: c
      })
    );
  }
  for (const i of Object.keys(t))
    if (!r.has(i))
      throw new Error(
        `[AETERNA] Unknown chunkPointer: ${i}`
      );
  return Object.freeze(n);
}
const C = Object.freeze(/^[a-f0-9]{64}$/), J = Object.freeze(/^[a-f0-9]{64}$/), Ie = Object.freeze(/^[a-f0-9]{64}$/), B = Object.freeze(/^[a-f0-9]{32}$/), xe = Object.freeze(/^[a-zA-Z0-9_-]{43}$/), je = xe, Le = Object.freeze(/^[a-zA-Z0-9_-]{32,256}$/);
Object.freeze(/^0x[a-fA-F0-9]{64}$/);
Object.freeze(/^[a-zA-Z0-9_-]{1,128}$/);
Object.freeze(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
Object.freeze(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
const R = Object.freeze(/^[a-f0-9]{64}$/), pe = 1;
function O(e) {
  if (typeof e != "string" || !je.test(e))
    throw new Error(
      "[AETERNA] Invalid storage pointer"
    );
  return e;
}
function he(e) {
  if (typeof e != "object" || e === null || Array.isArray(e) || Object.getPrototypeOf(e) !== Object.prototype)
    throw new Error(
      "[AETERNA] Invalid chunk pointer map"
    );
  const t = {};
  for (const [n, r] of Object.entries(e))
    t[n] = O(r);
  return Object.freeze(t);
}
function U(e) {
  if (typeof e != "string" || !Le.test(e))
    throw new Error(
      "[AETERNA] Invalid upload token"
    );
  return e;
}
const Re = 6e5, x = 12, L = 128, ke = "AETERNA_VAULT_SALT_V1", _e = "AETERNA_VAULT_KEY_V1";
function ze() {
  return new Uint8Array([1]);
}
const ne = "AETERNA_CHUNK_AAD_V1", N = 10 * 1024 * 1024, be = 10 * 1024 * 1024, Me = be + x + L / 8, re = "/api/upload", oe = 256 * 1024 * 1024, Ue = 256 * 1024 * 1024, W = 8e3, ie = 12e4, Pe = [
  "https://gateway.irys.xyz/",
  "https://arweave.net/",
  "https://permaweb.eu/",
  "https://arweave.live/"
];
function ce(...e) {
}
function h(e) {
  throw new Error(e ?? "[AETERNA] Fail closed");
}
function se(e) {
  return e.byteLength === 0 || e.buffer.byteLength === 0;
}
function ae(e) {
  let t = "";
  for (let r = 0; r < e.length; r += 32768) {
    const i = e.subarray(r, r + 32768);
    t += String.fromCharCode(...i);
  }
  return btoa(t);
}
function X(e) {
  if (typeof e != "object" || e === null) return !1;
  const t = Object.getPrototypeOf(e);
  return t === Object.prototype || t === null;
}
function Be(e, t) {
  (!e || typeof e != "object" || Array.isArray(e) || !X(e)) && h("[AETERNA] Invalid manifest shape");
  const n = e;
  (n.version !== pe || n.capsuleId !== t || typeof n.openAt != "number" || !Number.isSafeInteger(n.openAt) || typeof n.sealedAt != "number" || !Number.isSafeInteger(n.sealedAt) || n.openAt <= n.sealedAt || typeof n.saltBase != "string" || !B.test(n.saltBase) || typeof n.encryptedSizeBytes != "number" || !Number.isSafeInteger(n.encryptedSizeBytes) || !Number.isInteger(n.encryptedSizeBytes) || n.encryptedSizeBytes <= 0 || n.encryptedSizeBytes > N || typeof n.vaultTxId != "string" || !X(n.ext) || typeof n.ext.vaultSha256 != "string" || !R.test(
    n.ext.vaultSha256
  )) && h("[AETERNA] Invalid manifest fields");
}
function De(e, t) {
  X(e) || h("[AETERNA] Invalid chunk pointer response"), e.capsuleId !== t && h("[AETERNA] Chunk pointer capsule mismatch"), "chunkPointers" in e || h("[AETERNA] Missing chunk pointer payload");
  try {
    return he(
      e.chunkPointers
    );
  } catch {
    h("[AETERNA] Invalid chunk pointer payload");
  }
}
const q = {
  name: "executor-hot",
  async upload(e, t) {
    U(t), (!(e instanceof Uint8Array) || se(e) || e.byteLength === 0 || e.byteLength > oe) && h("[AETERNA] Invalid upload data");
    const n = e.slice(), r = new AbortController(), i = setTimeout(() => r.abort(), ie);
    try {
      const c = ae(n), o = await fetch(re, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: r.signal,
        body: JSON.stringify({
          uploadToken: t,
          ciphertext: c,
          // Declared ciphertext size. Used only for transport
          // integrity (server-side size-mismatch rejection, Upload
          // Law step 9) — it is not trusted as Business Authority.
          // Pricing was already fixed by the Business Quote before
          // this request exists; this field cannot change it.
          declaredSize: n.byteLength
        })
      });
      let s;
      try {
        s = await o.json();
      } catch {
        h("[AETERNA] Invalid upload response");
      }
      const a = s;
      (!o.ok || !a || typeof a != "object" || a.ok !== !0 || typeof a.storagePointer != "string") && h("[AETERNA] Upload failed");
      const l = a.storagePointer;
      return ce("[executor-hot] upload complete"), { txId: O(l) };
    } catch (c) {
      h(
        c instanceof Error ? c.message : "[AETERNA] Upload failed"
      );
    } finally {
      n.fill(0), clearTimeout(i);
    }
  },
  async uploadChunk(e, t, n) {
    U(n), (typeof t != "string" || t.length === 0) && h("[AETERNA] Invalid chunkId"), (!(e instanceof Uint8Array) || se(e) || e.byteLength === 0 || e.byteLength > oe) && h("[AETERNA] Invalid upload data");
    const r = e.slice(), i = new AbortController(), c = setTimeout(() => i.abort(), ie);
    try {
      const o = ae(r), s = await fetch(re, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: i.signal,
        body: JSON.stringify({
          uploadToken: n,
          ciphertext: o,
          // Mandatory chunkId binding: the Storage Authority
          // receives the canonical chunkId (SHA-256 of the chunk
          // ciphertext, produced by prepareMediaChunks) so it can
          // bind the returned pointer in the Chunk Pointer Registry.
          chunkId: t,
          declaredSize: r.byteLength
        })
      });
      let a;
      try {
        a = await s.json();
      } catch {
        h("[AETERNA] Invalid upload response");
      }
      const l = a;
      (!s.ok || !l || typeof l != "object" || l.ok !== !0 || typeof l.storagePointer != "string") && h("[AETERNA] Upload failed");
      const f = l.storagePointer;
      return ce("[executor-hot] uploadChunk complete"), { txId: O(f) };
    } catch (o) {
      h(
        o instanceof Error ? o.message : "[AETERNA] Upload failed"
      );
    } finally {
      r.fill(0), clearTimeout(c);
    }
  },
  async download(e) {
    O(e);
    for (const t of Pe) {
      const n = new AbortController(), r = setTimeout(() => n.abort(), W);
      try {
        const i = t.endsWith("/") ? t + e : t + "/" + e, c = await fetch(i, {
          cache: "no-store",
          signal: n.signal
        });
        if (!c.ok || c.status !== 200 || (c.headers.get("content-type") ?? "").includes("text/html")) continue;
        const s = await c.arrayBuffer();
        if (s.byteLength === 0 || s.byteLength > Ue)
          continue;
        return clearTimeout(r), new Uint8Array(s);
      } catch {
      } finally {
        clearTimeout(r);
      }
    }
    h("[AETERNA] All gateways failed");
  },
  async getManifest(e) {
    (typeof e != "string" || !C.test(e)) && h("[AETERNA] Invalid capsule ID");
    const t = new AbortController(), n = setTimeout(() => t.abort(), W);
    try {
      const r = await fetch(
        `/api/capsule/${encodeURIComponent(e)}`,
        { cache: "no-store", signal: t.signal }
      );
      (!r.ok || r.status !== 200) && h("[AETERNA] Manifest fetch failed"), (r.headers.get("content-type") ?? "").includes("application/json") || h("[AETERNA] Invalid manifest content type");
      const c = await r.json();
      return Be(c, e), O(c.vaultTxId), c;
    } catch (r) {
      h(
        r instanceof Error ? r.message : "[AETERNA] Manifest fetch failed"
      );
    } finally {
      clearTimeout(n);
    }
  },
  async getChunkPointers(e) {
    (typeof e != "string" || !C.test(e)) && h("[AETERNA] Invalid capsule ID");
    const t = new AbortController(), n = setTimeout(() => t.abort(), W);
    try {
      const r = await fetch(
        `/api/capsule/${encodeURIComponent(e)}/chunk-pointers`,
        { cache: "no-store", signal: t.signal }
      );
      (!r.ok || r.status !== 200) && h("[AETERNA] Chunk pointer fetch failed"), (r.headers.get("content-type") ?? "").includes("application/json") || h("[AETERNA] Invalid chunk pointer content type");
      const c = await r.json();
      return De(
        c,
        e
      );
    } catch (r) {
      h(
        r instanceof Error ? r.message : "[AETERNA] Chunk pointer fetch failed"
      );
    } finally {
      clearTimeout(n);
    }
  }
}, w = Object.freeze(q), me = 256 * 1024 * 1024, $e = 256 * 1024 * 1024;
function b() {
  throw new Error(
    "[AETERNA] Storage failure"
  );
}
function Ae(e) {
  return typeof e == "string" && C.test(e);
}
function D(e) {
  if (!e || typeof e != "object")
    return !1;
  const t = Object.getPrototypeOf(e);
  return t === Object.prototype || t === null;
}
function Q(e) {
  return e.byteLength === 0 || e.buffer.byteLength === 0;
}
function He(e, t) {
  (!e || typeof e != "object" || Array.isArray(e) || // FIX 7 — compare against the canonical MANIFEST_VERSION constant
  // instead of the literal `1`, so this check and the manifest
  // producer (sealCapsuleCore.ts) can never silently drift apart.
  e.version !== pe || e.capsuleId !== t || typeof e.vaultTxId != "string" || typeof e.openAt != "number" || !Number.isFinite(e.openAt) || typeof e.sealedAt != "number" || !Number.isFinite(e.sealedAt) || /**
  * Temporal invariant:
  * capsule must open strictly after sealing
  */
  e.openAt <= e.sealedAt || typeof e.encryptedSizeBytes != "number" || !Number.isFinite(
    e.encryptedSizeBytes
  ) || // FIX 3 — Enforce integer encryptedSizeBytes.
  // Byte counts must be whole numbers; fractional
  // values indicate schema drift or parser error.
  !Number.isInteger(
    e.encryptedSizeBytes
  ) || e.encryptedSizeBytes <= 0 || typeof e.saltBase != "string" || !D(e.ext) || typeof e.ext.vaultSha256 != "string" || !R.test(
    e.ext.vaultSha256
  )) && b();
}
async function Fe(e, t) {
  e instanceof Uint8Array || b(), Q(e) && b(), (e.byteLength <= 0 || // NOTE: Number.isFinite(data.byteLength) is
  // technically redundant (byteLength is always
  // an integer per the JS runtime), but retained
  // here as an explicit audit-visible assertion.
  !Number.isFinite(e.byteLength) || e.byteLength > me) && b(), U(t), (!w || typeof w.upload != "function") && b();
  try {
    const n = await w.upload(
      e,
      t
    );
    return (!n || !D(n) || typeof n.txId != "string") && b(), {
      txId: O(
        n.txId
      )
    };
  } catch {
    b();
  }
}
async function Ke(e, t, n) {
  e instanceof Uint8Array || b(), Q(e) && b(), (e.byteLength <= 0 || !Number.isFinite(e.byteLength) || e.byteLength > me) && b(), (typeof t != "string" || t.length === 0) && b(), U(n), (!w || typeof w.uploadChunk != "function") && b();
  try {
    const r = await w.uploadChunk(
      e,
      t,
      n
    );
    return (!r || !D(r) || typeof r.txId != "string") && b(), {
      txId: O(
        r.txId
      )
    };
  } catch {
    b();
  }
}
async function Ge(e) {
  O(e), (!w || typeof w.download != "function") && b();
  try {
    const t = await w.download(
      e
    );
    return (!(t instanceof Uint8Array) || Q(t) || t.byteLength <= 0 || !Number.isFinite(
      t.byteLength
    ) || t.byteLength > $e) && b(), t;
  } catch {
    b();
  }
}
async function Ve(e) {
  Ae(e) || b(), (!w || typeof w.getChunkPointers != "function") && b();
  try {
    const t = await w.getChunkPointers(
      e
    );
    return he(
      t
    );
  } catch {
    b();
  }
}
async function We(e) {
  Ae(e) || b(), (!w || typeof w.getManifest != "function") && b();
  try {
    const t = await w.getManifest(
      e
    );
    return (!t || !D(t)) && b(), He(
      t,
      e
    ), O(
      t.vaultTxId
    ), t;
  } catch {
    b();
  }
}
function Xe() {
  return w.name || "unknown";
}
const Ye = Object.freeze({
  upload: Fe,
  uploadChunk: Ke,
  download: Ge,
  getManifest: We,
  getChunkPointers: Ve,
  get name() {
    return Xe();
  }
}), g = new Error("[AETERNA] Chunk decryption failed"), le = new TextEncoder();
function j(e) {
  return e.buffer.byteLength === 0;
}
function Ze(e) {
  for (let t = 0; t < e.length; t++)
    if (e[t] !== 0)
      return !1;
  return !0;
}
function Je(e) {
  return typeof CryptoKey < "u" && e instanceof CryptoKey;
}
function qe(e, t) {
  if (ne.length === 0 || typeof e != "string" || !C.test(e) || !Number.isInteger(t) || t < 0 || t > 4294967295)
    throw g;
  const n = le.encode(
    ne
  ), r = le.encode(
    e
  );
  if (n.byteLength === 0 || r.byteLength === 0 || j(n) || j(r))
    throw g;
  const i = new Uint8Array(
    n.byteLength + r.byteLength + 4
  );
  if (i.byteLength === 0 || j(i))
    throw g;
  return i.set(n, 0), i.set(
    r,
    n.byteLength
  ), new DataView(i.buffer).setUint32(
    n.byteLength + r.byteLength,
    t,
    !1
  ), i;
}
async function Qe(e, t, n, r) {
  let i = null, c = null;
  try {
    const o = globalThis.crypto;
    if (!(o != null && o.subtle) || !(e instanceof Uint8Array) || j(e) || e.byteLength < x + L / 8 || e.byteLength > Me || !Je(t))
      throw g;
    const s = t.algorithm;
    if (t.type !== "secret" || t.extractable !== !1 || !t.usages.includes("decrypt") || s.name !== "AES-GCM" || s.length !== 256 || !Number.isInteger(n) || n < 0 || n >= 2 ** 32)
      throw g;
    const a = e.subarray(0, x);
    if (a.byteLength !== x || j(a) || Ze(a))
      throw g;
    const l = e.subarray(x);
    if (l.byteLength < L / 8 || j(l))
      throw g;
    i = qe(
      r,
      n
    );
    const f = await o.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: a,
        additionalData: i,
        tagLength: L
      },
      t,
      l
    );
    if (!(f instanceof ArrayBuffer) || (c = new Uint8Array(
      f
    ), c.byteLength === 0 || j(c)))
      throw g;
    const d = c.slice();
    return c.fill(0), d;
  } catch {
    throw g;
  } finally {
    try {
      i == null || i.fill(0);
    } catch {
    }
    try {
      c == null || c.fill(0);
    } catch {
    }
  }
}
function et(e) {
  return e.byteLength === 0 || e.buffer.byteLength === 0;
}
async function tt(e, t, n) {
  const r = await Ye.download(
    t.pointer
  );
  if (!(r instanceof Uint8Array) || r.byteLength === 0)
    throw new Error(
      "[AETERNA] Chunk download failed"
    );
  try {
    return await Qe(
      r,
      n,
      t.index,
      e
    );
  } finally {
    et(r) || r.fill(0);
  }
}
const nt = x + L / 8;
function rt(e, t) {
  if (e.length === 0)
    throw new Error(
      "Missing chunk metadata."
    );
  if (!Number.isSafeInteger(t) || t <= 0)
    throw new Error(
      "Invalid media size."
    );
  const n = [];
  let r = 0, i = 0;
  for (const c of e) {
    if (c.index !== i)
      throw new Error(
        "Invalid chunk sequence."
      );
    if (!Number.isInteger(c.size))
      throw new Error(
        "Chunk size must be an integer."
      );
    if (c.size <= 0)
      throw new Error(
        "Chunk size must be positive."
      );
    const o = Math.min(
      be,
      t - r
    );
    if (o <= 0)
      throw new Error(
        "Chunk metadata exceeds media size."
      );
    if (c.size !== o + nt)
      throw new Error(
        "Chunk ciphertext size does not match expected plaintext length."
      );
    const s = r + o;
    if (!Number.isSafeInteger(s))
      throw new Error(
        "Invalid file size."
      );
    const a = Object.freeze({
      chunk: c,
      fileOffset: r,
      length: o
    });
    n.push(a), r = s, i++;
  }
  if (r !== t)
    throw new Error(
      "Reconstructed size does not match media size."
    );
  return Object.freeze({
    entries: Object.freeze(n),
    fileSize: r
  });
}
function ot(e, t) {
  let n = 0, r = e.length - 1;
  for (; n < r; ) {
    const i = n + r >>> 1, c = e[i];
    if (!c)
      throw new Error(
        "Invalid byte map."
      );
    c.fileOffset + c.length <= t ? n = i + 1 : r = i;
  }
  return n;
}
function it(e, t, n) {
  if (!Number.isInteger(t) || !Number.isInteger(n))
    throw new Error(
      "Range bounds must be integers."
    );
  if (t < 0 || n <= t)
    throw new Error(
      "Invalid byte range."
    );
  if (n > e.fileSize)
    throw new Error(
      "Byte range exceeds file length."
    );
  const { entries: r } = e, i = ot(r, t), c = [];
  let o = 0;
  for (let s = i; s < r.length; s++) {
    const a = r[s];
    if (!a)
      throw new Error(
        "Invalid byte map."
      );
    if (a.fileOffset >= n)
      break;
    const l = a.fileOffset + a.length, f = Math.max(t, a.fileOffset), y = Math.min(n, l) - f;
    if (y <= 0)
      continue;
    const u = f - a.fileOffset, p = o + y;
    if (!Number.isSafeInteger(p))
      throw new Error(
        "Output range overflow."
      );
    const m = Object.freeze({
      chunk: a.chunk,
      chunkOffset: u,
      outputOffset: o,
      length: y
    });
    c.push(m), o = p;
  }
  return Object.freeze(c);
}
function ct(e, t, n, r) {
  const i = rt(n, r), c = /* @__PURE__ */ new Map();
  async function o(a) {
    const l = c.get(a.index);
    if (l)
      return l;
    const f = await tt(
      e,
      a,
      t
    );
    return c.set(a.index, f), f;
  }
  function s(a, l, f) {
    for (let d = 0; d < a.length; d++) {
      const y = a[d], u = l[d];
      if (!y || !u)
        throw new Error(
          "Missing plan entry or decrypted chunk."
        );
      if (y.chunkOffset + y.length > u.length)
        throw new Error(
          "Chunk length mismatch."
        );
      const p = u.subarray(
        y.chunkOffset,
        y.chunkOffset + y.length
      );
      f.set(
        p,
        y.outputOffset
      );
    }
  }
  return Object.freeze({
    async getBytes(a, l) {
      const f = it(i, a, l), d = l - a;
      if (d <= 0)
        throw new Error(
          "Invalid byte range."
        );
      if (f.reduce(
        (p, m) => p + m.length,
        0
      ) !== d)
        throw new Error(
          "Read plan length mismatch."
        );
      const u = [];
      try {
        for (const m of f)
          u.push(
            await o(m.chunk)
          );
        const p = new Uint8Array(d);
        return s(f, u, p), p;
      } finally {
        u.length = 0;
      }
    },
    dispose() {
      for (const a of c.values())
        a.fill(0);
      c.clear();
    }
  });
}
let Ee = !1;
function on() {
  Ee = !0;
}
async function cn({
  root: e,
  status: t
}) {
  if (Ee)
    throw new Error("Emergency runtime has been disposed.");
  t.textContent = "Loading emergency runtime…";
  const [
    { parseCapsuleCapability: n },
    { loadManifest: r },
    { getTrustedTime: i },
    { resolveEffectiveOpenAt: c },
    { loadHeartbeatRecord: o },
    { sendHeartbeat: s },
    { openCapsule: a }
  ] = await Promise.all([
    Promise.resolve().then(() => Et),
    Promise.resolve().then(() => Ot),
    Promise.resolve().then(() => St),
    Promise.resolve().then(() => Nt),
    Promise.resolve().then(() => It),
    Promise.resolve().then(() => jt),
    Promise.resolve().then(() => rn)
  ]), l = n(location.href);
  if (!(l != null && l.recipientSecret) && !(l != null && l.creatorAuthorityFragment)) {
    t.textContent = "Invalid capsule link.";
    return;
  }
  let f;
  try {
    const S = st();
    f = await r(S);
  } catch {
    t.textContent = "Capsule unavailable.";
    return;
  }
  let d;
  try {
    d = (await i()).nowUtc;
  } catch {
    t.textContent = "Trusted time unavailable.";
    return;
  }
  const y = f.heartbeatInterval ?? 0, u = await o(f.capsuleId), p = u == null ? void 0 : u.lastConfirmedAt, m = c({
    manifestOpenAt: f.openAt,
    lastConfirmedAt: p,
    heartbeatInterval: y
  });
  if (l.creatorAuthorityFragment && at({
    status: t,
    manifest: f,
    creatorAuthorityFragment: l.creatorAuthorityFragment,
    sendHeartbeat: s
  }), !l.recipientSecret) {
    t.textContent = "Opening requires recipient secret.";
    return;
  }
  if (d < m || f.sealedAt > d) {
    t.textContent = "Capsule is not yet open.";
    return;
  }
  t.textContent = "Opening capsule…";
  try {
    const { vault: S } = await a({
      capsuleId: f.capsuleId,
      secret: l.recipientSecret,
      manifest: f
    });
    lt(e, S, t), t.textContent = "Capsule opened.";
  } catch {
    t.textContent = "Capsule unavailable.";
  }
}
function st() {
  if (typeof location > "u" || typeof location.pathname != "string")
    return "";
  const e = location.pathname.replace(/\/+$/, ""), t = e.lastIndexOf("/");
  return (t >= 0 ? e.slice(t + 1) : e) || e || "";
}
function at(e) {
  const t = document.getElementById("confirmWrap"), n = document.getElementById("confirmBtn");
  t instanceof HTMLDivElement && n instanceof HTMLButtonElement && (t.style.display = "", n.onclick = async () => {
    if (!n.disabled) {
      n.disabled = !0, n.textContent = "CONFIRMING...";
      try {
        const r = await e.sendHeartbeat(
          e.manifest.capsuleId,
          e.creatorAuthorityFragment
        );
        if (r === "confirmed") {
          n.textContent = "CONFIRMED ✓", n.classList.add("success"), n.classList.remove("cooldown"), n.disabled = !1, setTimeout(() => {
            n.disabled = !0, n.textContent = "WAIT 15 MIN", n.classList.add("cooldown"), setTimeout(() => {
              n.disabled = !1, n.textContent = "CONFIRM PRESENCE", n.classList.remove("cooldown");
            }, 15 * 60 * 1e3);
          }, 3e3);
          return;
        }
        e.status.textContent = r === "expired" ? "Confirmation window closed." : r === "rejected" ? "Heartbeat rejected." : "Network error during heartbeat.";
      } catch {
        e.status.textContent = "Heartbeat failed. Try again.";
      } finally {
        n.disabled = !1, n.textContent = "CONFIRM PRESENCE";
      }
    }
  });
}
function lt(e, t, n) {
  var i;
  e.innerHTML = "";
  const r = ((i = t == null ? void 0 : t.capsule) == null ? void 0 : i.items) ?? [];
  for (let c = 0; c < r.length; c++) {
    const o = r[c], s = document.createElement("div");
    if (s.className = "item", s.style.animationDelay = `${c * 0.07}s`, !o || typeof o != "object") {
      e.appendChild(s);
      continue;
    }
    const a = o;
    if (a.type !== "media") {
      const G = document.createElement("p");
      G.className = "item-eyebrow", G.textContent = "Message";
      const V = document.createElement("div");
      V.className = "item-text", V.textContent = typeof a.text == "string" ? a.text : "", s.appendChild(G), s.appendChild(V), e.appendChild(s);
      continue;
    }
    const l = a, f = typeof l.filename == "string" && l.filename.length > 0 ? l.filename : "file", d = typeof l.mediaType == "string" ? l.mediaType : "file", y = typeof l.mimeType == "string" ? l.mimeType : "", u = typeof l.size == "number" ? l.size : 0, p = Array.isArray(l.chunks) ? l.chunks : [], m = document.createElement("p");
    m.className = "item-eyebrow", m.textContent = d.charAt(0).toUpperCase() + d.slice(1);
    const S = document.createElement("div");
    S.className = "media-card";
    const $ = document.createElement("div");
    $.className = "media-icon", $.innerHTML = mt(d);
    const M = document.createElement("div");
    M.className = "media-info";
    const H = document.createElement("div");
    H.className = "media-filename", H.textContent = f;
    const F = document.createElement("div");
    F.className = "media-meta";
    const te = [y];
    u > 0 && te.push(bt(u)), F.textContent = te.filter(Boolean).join(" · "), M.appendChild(H), M.appendChild(F), S.appendChild($), S.appendChild(M);
    const K = document.createElement("div");
    if (K.className = "media-unavail", K.textContent = "Preview unavailable — media recovery coming in next layer", s.appendChild(m), s.appendChild(S), s.appendChild(K), e.appendChild(s), u <= 0 || p.length === 0)
      continue;
    const k = document.createElement("div");
    k.className = "media-playground", k.style.marginTop = "12px", s.appendChild(k), d === "video" || d === "audio" ? ft({
      root: k,
      status: n,
      item: l,
      capsuleId: t.capsule.capsuleId,
      chunks: p,
      mediaType: d,
      mimeType: y,
      size: u
    }) : d === "image" ? ut({
      root: k,
      status: n,
      item: l,
      capsuleId: t.capsule.capsuleId,
      chunks: p,
      mimeType: y,
      size: u
    }) : d === "file" && dt({
      root: k,
      status: n,
      item: l,
      capsuleId: t.capsule.capsuleId,
      chunks: p,
      mimeType: y,
      size: u
    });
  }
}
function ft(e) {
  const t = e.mediaType === "video" ? document.createElement("video") : document.createElement("audio");
  t.controls = !0, t.style.width = "100%", t.style.maxHeight = "320px", t.style.borderRadius = "16px", t.style.background = "#000", t.style.marginTop = "10px";
  const n = document.createElement("div");
  n.className = "media-fallback", n.textContent = "Progressive playback unavailable — bounded recovery required.", n.style.display = "none", n.style.fontSize = "11px", n.style.color = "rgba(232,228,220,0.45)", n.style.marginTop = "10px", e.root.appendChild(t), e.root.appendChild(n);
  const r = (o) => {
    t.src && t.src.startsWith("blob:") && URL.revokeObjectURL(t.src), t.src = o, t.load();
  };
  let i = null;
  const c = () => {
    i && (i(), i = null), t.src && t.src.startsWith("blob:") && URL.revokeObjectURL(t.src), t.removeAttribute("src"), t.load(), n.style.display = "none";
  };
  t.addEventListener("error", () => {
    n.style.display = "";
  }), ee({
    root: e.root,
    status: e.status,
    item: e.item,
    capsuleId: e.capsuleId,
    chunks: e.chunks,
    mimeType: e.mimeType,
    size: e.size,
    onStreamReady: (o) => {
      c(), r(o);
    },
    getAbortController: () => {
      const o = new AbortController();
      return i = () => o.abort(), o;
    }
  });
}
function ut(e) {
  const t = document.createElement("img");
  t.alt = e.item.filename ?? "capsule media", t.style.width = "100%", t.style.borderRadius = "16px", t.style.background = "#000", t.style.marginTop = "10px";
  const n = document.createElement("div");
  n.className = "media-fallback", n.textContent = "Image preview unavailable — bounded recovery required.", n.style.fontSize = "11px", n.style.color = "rgba(232,228,220,0.45)", n.style.marginTop = "10px", e.root.appendChild(t), e.root.appendChild(n), t.addEventListener("error", () => {
    n.style.display = "";
  });
  let r = null;
  ee({
    root: e.root,
    status: e.status,
    item: e.item,
    capsuleId: e.capsuleId,
    chunks: e.chunks,
    mimeType: e.mimeType,
    size: e.size,
    onStreamReady: (i) => {
      r && r.startsWith("blob:") && URL.revokeObjectURL(r), r = i, t.src = i;
    },
    getAbortController: () => new AbortController()
  });
}
function dt(e) {
  const t = document.createElement("a");
  t.textContent = `Download ${e.item.filename ?? "file"}`, t.style.display = "inline-flex", t.style.marginTop = "10px", t.style.fontSize = "12px", t.style.color = "rgba(232,228,220,0.7)", t.style.textDecoration = "underline", t.style.textUnderlineOffset = "4px";
  const n = document.createElement("div");
  n.className = "media-fallback", n.textContent = "Streaming download unavailable — bounded recovery required.", n.style.fontSize = "11px", n.style.color = "rgba(232,228,220,0.45)", n.style.marginTop = "10px", e.root.appendChild(t), e.root.appendChild(n), t.addEventListener("click", (i) => {
    i.preventDefault(), n.style.display = "", t.removeAttribute("href");
  });
  let r = null;
  ee({
    root: e.root,
    status: e.status,
    item: e.item,
    capsuleId: e.capsuleId,
    chunks: e.chunks,
    mimeType: e.mimeType,
    size: e.size,
    onStreamReady: (i) => {
      r && r.startsWith("blob:") && URL.revokeObjectURL(r), r = i, t.href = i, t.download = e.item.filename ?? "aeterna-media", t.style.display = "inline-flex", n.style.display = "none";
    },
    getAbortController: () => new AbortController()
  });
}
function ee(e) {
  const t = yt({
    item: e.item,
    capsuleId: e.capsuleId,
    chunks: e.chunks,
    mimeType: e.mimeType,
    size: e.size,
    onStreamReady: e.onStreamReady,
    status: e.status,
    abortController: e.getAbortController()
  }), n = () => {
    try {
      t.dispose();
    } catch {
    }
  }, r = new MutationObserver(() => {
    e.root.isConnected || (n(), r.disconnect());
  });
  r.observe(e.root, { subtree: !1 }), window.addEventListener("beforeunload", n, { once: !0 });
}
function yt(e) {
  const t = Ne(
    e.chunks,
    pt(e.chunks)
  ), n = {
    capsuleId: e.capsuleId,
    cryptoKey: null,
    media: {
      mediaType: e.item.mediaType,
      filename: e.item.filename,
      mimeType: e.mimeType,
      size: e.size,
      createdAt: e.item.createdAt
    }
  }, r = ct(
    e.capsuleId,
    n.cryptoKey,
    t,
    e.size
  );
  let i = !1;
  const s = {
    read: async (u, p) => {
      if (i)
        throw new Error(
          "Emergency media session has been disposed."
        );
      if (!Number.isInteger(u) || !Number.isInteger(p))
        throw new Error("Range bounds must be integers.");
      if (u < 0 || p <= u)
        throw new Error("Invalid byte range.");
      if (p > e.size)
        throw new Error("Byte range exceeds file length.");
      return r.getBytes(u, p);
    },
    dispose: () => {
      i || (i = !0, r.dispose());
    }
  }, a = (u) => {
    if (e.abortController.signal.aborted) {
      URL.revokeObjectURL(u);
      return;
    }
    e.onStreamReady(u);
  }, l = (u) => {
    e.status.textContent = u ?? "Media recovery failed.";
  }, f = async () => {
    try {
      const u = await s.read(0, e.size), p = new Blob([u], {
        type: e.mimeType || "application/octet-stream"
      }), m = URL.createObjectURL(p);
      a(m);
    } catch (u) {
      l(
        u instanceof Error ? u.message : "Image preview failed."
      );
    } finally {
      s.dispose();
    }
  }, d = async () => {
    const u = ht({
      session: s,
      mimeType: e.mimeType,
      size: e.size,
      signal: e.abortController.signal,
      onError: () => l("Progressive playback failed.")
    });
    u && a(u), s.dispose();
  }, y = async () => {
    try {
      const u = await s.read(0, e.size), p = new Blob([u], {
        type: e.mimeType || "application/octet-stream"
      }), m = URL.createObjectURL(p);
      a(m);
    } catch (u) {
      l(
        u instanceof Error ? u.message : "Download recovery failed."
      );
    } finally {
      s.dispose();
    }
  };
  return e.item.mediaType === "image" ? (f(), s) : (e.item.mediaType === "video" || e.item.mediaType === "audio") && typeof MediaSource < "u" && MediaSource.isTypeSupported(e.mimeType) ? (d(), s) : (y(), s);
}
function pt(e) {
  const t = {};
  for (const n of e) {
    if (typeof n != "object" || n === null || Array.isArray(n))
      throw new Error(
        "[AETERNA] Invalid chunk metadata."
      );
    const r = n;
    if (typeof r.chunkId != "string" || r.chunkId.length === 0)
      throw new Error(
        "[AETERNA] Invalid chunk metadata."
      );
    if (typeof r.pointer != "string" || r.pointer.length === 0)
      throw new Error(
        `[AETERNA] Missing storage pointer for chunk ${r.chunkId}`
      );
    t[r.chunkId] = r.pointer;
  }
  return Object.freeze(t);
}
function ht(e) {
  if (typeof MediaSource > "u" || !MediaSource.isTypeSupported(e.mimeType))
    return null;
  const t = new MediaSource(), n = URL.createObjectURL(t), r = { value: null }, i = (o) => {
  }, c = () => {
    try {
      r.value === null && t.readyState === "open" && t.endOfStream();
    } catch {
    }
  };
  try {
    t.addEventListener(
      "sourceopen",
      async () => {
        if (e.signal.aborted) {
          c(), i(null);
          return;
        }
        try {
          const o = t.addSourceBuffer(e.mimeType);
          let s = 0;
          const a = 256 * 1024, l = async () => {
            if (e.signal.aborted || s >= e.size) {
              if (s >= e.size && t.readyState === "open")
                try {
                  t.endOfStream();
                } catch {
                }
              return;
            }
            const f = Math.min(
              s + a,
              e.size
            );
            let d;
            try {
              d = await e.session.read(s, f);
            } catch {
              c(), e.onError(), i(null);
              return;
            }
            if (!e.signal.aborted) {
              try {
                o.appendBuffer(d);
              } catch {
                c(), e.onError(), i(null);
                return;
              }
              s = f;
            }
          };
          o.addEventListener(
            "updateend",
            l
          ), o.addEventListener(
            "error",
            () => {
              c(), e.onError(), i(null);
            }
          ), await l(), i(n);
        } catch {
          e.onError(), i(null);
        }
      },
      { once: !0 }
    );
  } catch {
    e.onError();
  }
  return r.value ?? null;
}
function bt(e) {
  return e < 1024 ? `${e} B` : e < 1024 * 1024 ? `${(e / 1024).toFixed(1)} KB` : e < 1024 ** 3 ? `${(e / 1024 ** 2).toFixed(1)} MB` : `${(e / 1024 ** 3).toFixed(2)} GB`;
}
function mt(e) {
  const t = 'width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';
  return e === "image" ? `<svg ${t}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>` : e === "video" ? `<svg ${t}><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>` : e === "audio" ? `<svg ${t}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>` : `<svg ${t}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
}
function At(e) {
  if (typeof e != "string")
    return null;
  const t = e.startsWith("#") ? e.slice(1) : e;
  if (!t)
    return null;
  const n = t.split("&");
  if (n.length === 0 || n.length > 2)
    return null;
  let r, i;
  for (const o of n) {
    if (!o)
      return null;
    if (o.startsWith("c=")) {
      const s = o.slice(2);
      if (!Ie.test(s) || i)
        return null;
      i = s;
      continue;
    }
    if (J.test(o)) {
      if (r)
        return null;
      r = o;
      continue;
    }
    return null;
  }
  if (!r && !i)
    return null;
  const c = {};
  return r && (c.recipientSecret = r), i && (c.creatorAuthorityFragment = i), c;
}
const Et = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  parseCapsuleCapability: At
}, Symbol.toStringTag, { value: "Module" }));
function P(e, t = /* @__PURE__ */ new WeakSet()) {
  if (e === null || typeof e != "object" || t.has(e))
    return e;
  t.add(e), Object.freeze(e);
  for (const n of Reflect.ownKeys(e)) {
    const r = Object.getOwnPropertyDescriptor(e, n);
    if (r && "value" in r) {
      const i = r.value;
      i && typeof i == "object" && !Object.isFrozen(i) && P(i, t);
    }
  }
  return e;
}
function gt(e) {
  if (typeof e != "object" || e === null || Array.isArray(e) || Object.getPrototypeOf(e) !== Object.prototype)
    throw A;
  for (const t of Object.values(e))
    try {
      O(t);
    } catch {
      throw A;
    }
}
const A = new Error("[AETERNA] Capsule is sealed"), fe = 15778368e5, ue = 41024448e5, wt = Object.freeze(
  /* @__PURE__ */ new Set([
    "vaultSha256",
    "chunkPointers"
  ])
);
async function Tt(e) {
  if (typeof crypto > "u" || !crypto.subtle || typeof e != "string" || !C.test(e))
    throw A;
  const t = new AbortController(), n = setTimeout(
    () => t.abort(),
    8e3
  );
  let r;
  try {
    r = await fetch(
      `/api/capsule/${e}`,
      {
        method: "GET",
        cache: "no-store",
        signal: t.signal
      }
    );
  } catch {
    throw A;
  } finally {
    clearTimeout(n);
  }
  if (!r.ok || !(r.headers.get("content-type") ?? "").includes(
    "application/json"
  ))
    throw A;
  const c = await r.text();
  if (typeof c != "string" || c.length === 0 || c.length > 2e4 || /"__proto__"\s*:/.test(c) || /"constructor"\s*:/.test(c) || /"prototype"\s*:/.test(c))
    throw A;
  let o;
  try {
    o = JSON.parse(c);
  } catch {
    throw A;
  }
  if (!o || Array.isArray(o) || Object.getPrototypeOf(o) !== Object.prototype || o.version !== 1 || typeof o.capsuleId != "string" || !C.test(o.capsuleId) || o.capsuleId !== e || typeof o.openAt != "number" || !Number.isInteger(o.openAt) || typeof o.sealedAt != "number" || !Number.isInteger(o.sealedAt) || o.sealedAt < fe || o.sealedAt > ue || o.openAt <= o.sealedAt || o.openAt < fe || o.openAt > ue || typeof o.saltBase != "string" || !B.test(o.saltBase))
    throw A;
  try {
    O(o.vaultTxId);
  } catch {
    throw A;
  }
  if (typeof o.encryptedSizeBytes != "number" || !Number.isInteger(o.encryptedSizeBytes) || /**
  * Lower bound is > 0, not ≥ 1024.
  *
  * All runtime layers (seal, open, emergency) use > 0 semantics.
  * A 1024-byte floor here would mean a manifest that passes every
  * other layer gets rejected at the authority boundary — creating
  * a capsule that seals successfully but can never be loaded.
  * The SHA-256 integrity check and size-continuity check are the
  * authoritative integrity anchors, not a minimum size floor.
  */
  o.encryptedSizeBytes <= 0 || o.encryptedSizeBytes > N || o.description !== void 0 && (typeof o.description != "string" || o.description.length > 500) || typeof o.ext != "object" || o.ext === null || Array.isArray(o.ext) || Object.getPrototypeOf(o.ext) !== Object.prototype)
    throw A;
  const s = Object.keys(o.ext);
  for (const a of s)
    if (!wt.has(a))
      throw A;
  if (typeof o.ext.vaultSha256 != "string" || !R.test(o.ext.vaultSha256))
    throw A;
  return o.ext.chunkPointers !== void 0 && (gt(
    o.ext.chunkPointers
  ), delete o.ext.chunkPointers), P(
    o
  );
}
const Ot = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  loadManifest: Tt
}, Symbol.toStringTag, { value: "Module" })), Ct = 15778368e5, vt = 41024448e5;
async function ge() {
  const e = await fetch("/api/time", {
    method: "GET",
    cache: "no-store"
  });
  if (!e.ok)
    throw new Error(
      "[AETERNA] Trusted time unavailable"
    );
  const t = await e.json().catch(() => null), n = t == null ? void 0 : t.nowUtc;
  if (typeof n != "number" || !Number.isFinite(n) || !Number.isSafeInteger(n) || n < Ct || n > vt)
    throw new Error(
      "[AETERNA] Trusted time violation"
    );
  return {
    nowUtc: n
  };
}
const St = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  getTrustedTime: ge
}, Symbol.toStringTag, { value: "Module" })), Y = 30 * 24 * 60 * 60 * 1e3;
function we(e) {
  return e <= Y ? e : Y;
}
function Te({
  manifestOpenAt: e,
  lastConfirmedAt: t,
  heartbeatInterval: n = 0
}) {
  if (!Number.isFinite(e) || !Number.isInteger(e))
    throw new Error(
      "[AETERNA] Invalid manifest.openAt"
    );
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0)
    throw new Error(
      "[AETERNA] Invalid heartbeat timing"
    );
  const r = Number.isInteger(t) ? t : void 0;
  if (r === void 0)
    return e;
  const i = we(
    n
  ), c = r + i;
  if (!Number.isFinite(
    c
  ))
    throw new Error(
      "[AETERNA] Invalid heartbeat timing"
    );
  return Math.max(
    e,
    c
  );
}
const Nt = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  THIRTY_DAYS_MS: Y,
  resolveEffectiveOpenAt: Te,
  resolveHeartbeatRenewalMs: we
}, Symbol.toStringTag, { value: "Module" }));
async function Oe(e) {
  if (!C.test(e))
    return null;
  try {
    const t = await fetch(
      `/api/heartbeat?capsuleId=${encodeURIComponent(e)}`
    );
    if (!t.ok)
      return null;
    const n = await t.json();
    if (!n || typeof n != "object" || Array.isArray(n))
      return null;
    const r = n;
    return r.lastConfirmedAt !== null && r.lastConfirmedAt !== void 0 && (typeof r.lastConfirmedAt != "number" || !Number.isFinite(r.lastConfirmedAt) || !Number.isInteger(r.lastConfirmedAt) || r.lastConfirmedAt <= 0) ? null : {
      capsuleId: e,
      lastConfirmedAt: typeof r.lastConfirmedAt == "number" ? r.lastConfirmedAt : null
    };
  } catch {
    return null;
  }
}
const It = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  loadHeartbeatRecord: Oe
}, Symbol.toStringTag, { value: "Module" }));
async function xt(e, t) {
  if (typeof e != "string" || !C.test(e) || typeof t != "string" || !R.test(
    t
  ))
    return "rejected";
  try {
    const n = await fetch(
      "/api/heartbeat",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          capsuleId: e,
          creatorAuthorityFragment: t
        })
      }
    );
    if (n.status === 409)
      return "expired";
    if (!n.ok)
      return "rejected";
    const r = await n.json();
    return !r || typeof r != "object" || Array.isArray(r) || r.ok !== !0 ? "rejected" : "confirmed";
  } catch {
    return "network-error";
  }
}
const jt = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  sendHeartbeat: xt
}, Symbol.toStringTag, { value: "Module" }));
function Lt() {
  throw new Error(
    "[AETERNA] Storage unavailable"
  );
}
q || Lt();
const Rt = Object.freeze(q), T = new Error("[AETERNA] Cryptographic failure"), kt = Object.freeze(["v", "iv", "d"]);
function Ce(e) {
  return e.buffer.byteLength === 0;
}
function _t(e) {
  return typeof CryptoKey < "u" && e instanceof CryptoKey;
}
function zt(e) {
  return typeof e != "string" || e.length === 0 || e.length % 4 !== 0 ? !1 : /^[A-Za-z0-9+/]+={0,2}$/.test(e);
}
function Mt() {
  const e = ze();
  if (!(e instanceof Uint8Array) || e.byteLength !== 1 || e[0] !== 1)
    throw T;
  return e;
}
function de(e) {
  try {
    if (typeof e != "string" || e.length === 0 || !zt(e) || typeof atob != "function")
      throw T;
    const t = atob(e), n = t.length;
    if (!Number.isFinite(n) || n === 0)
      throw T;
    const r = new Uint8Array(n);
    for (let i = 0; i < n; i++)
      r[i] = t.charCodeAt(i);
    if (Ce(r))
      throw T;
    return r;
  } catch {
    throw T;
  }
}
async function Ut(e, t) {
  const n = globalThis.crypto;
  if (!(n != null && n.subtle) || !(e instanceof Uint8Array) || e.byteLength === 0 || e.byteLength > N || Ce(e) || !_t(t))
    throw T;
  const r = t.algorithm;
  if (t.type !== "secret" || t.extractable !== !1 || !t.usages.includes("decrypt") || r.name !== "AES-GCM" || r.length !== 256)
    throw T;
  const i = new TextDecoder(
    "utf-8",
    { fatal: !0 }
  );
  let c;
  try {
    const f = i.decode(
      e
    );
    c = JSON.parse(f);
  } catch {
    throw T;
  }
  if (!c || Object.getPrototypeOf(c) !== Object.prototype || c.v !== 2 || typeof c.iv != "string" || typeof c.d != "string")
    throw T;
  for (const f of Object.keys(c))
    if (!kt.includes(f))
      throw T;
  P(c);
  const o = de(
    c.iv
  ), s = de(
    c.d
  );
  if (o.byteLength !== x || s.byteLength < L / 8)
    throw T;
  let a, l = null;
  try {
    l = Mt(), a = await n.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: o,
        additionalData: l,
        tagLength: L
      },
      t,
      s
    );
    const f = i.decode(
      a
    ), d = JSON.parse(
      f
    );
    if (!d || typeof d != "object" || Object.getPrototypeOf(d) !== Object.prototype)
      throw T;
    return P(d), d;
  } catch {
    throw T;
  } finally {
    if (a !== void 0)
      try {
        new Uint8Array(a).fill(0);
      } catch {
      }
    try {
      l == null || l.fill(0);
    } catch {
    }
    try {
      o.fill(0);
    } catch {
    }
    try {
      s.fill(0);
    } catch {
    }
  }
}
function v() {
  throw new Error("[AETERNA] Cryptographic failure");
}
const ve = 41024448e5, Z = new TextEncoder();
function Se(e) {
  e.length % 2 !== 0 && v();
  const t = e.length, n = new Uint8Array(t / 2);
  for (let r = 0; r < t; r += 2) {
    const i = Number.parseInt(
      e.slice(r, r + 2),
      16
    );
    Number.isNaN(i) && v(), n[r / 2] = i;
  }
  return n;
}
function Pt(e) {
  (!Number.isInteger(e) || e < 0 || e > ve) && v();
  const t = new ArrayBuffer(8);
  return new DataView(t).setBigUint64(
    0,
    BigInt(e),
    !1
  ), new Uint8Array(t);
}
function Bt(e, t, n) {
  const r = Z.encode(
    ke
  ), i = Se(e), c = Pt(t), o = Z.encode(n), s = new Uint8Array(
    r.length + 1 + i.length + 1 + c.length + 1 + o.length
  );
  let a = 0;
  return s.set(r, a), a += r.length, s[a++] = 0, s.set(
    i,
    a
  ), a += i.length, s[a++] = 0, s.set(
    c,
    a
  ), a += c.length, s[a++] = 0, s.set(
    o,
    a
  ), s;
}
async function Dt(e) {
  const {
    secret: t,
    saltBase: n,
    openAt: r,
    capsuleId: i
  } = e, c = globalThis.crypto;
  c != null && c.subtle || v(), J.test(t) || v(), B.test(n) || v(), (!Number.isInteger(r) || r <= 0 || r > ve) && v(), C.test(i) || v();
  const o = Se(t);
  o.length !== 32 && v();
  let s = null, a = null, l = null, f = null;
  try {
    s = Bt(
      n,
      r,
      i
    );
    const d = await c.subtle.digest(
      "SHA-256",
      s
    );
    a = new Uint8Array(
      d
    );
    const y = Z.encode(
      _e
    );
    l = new Uint8Array(
      y.length + a.length
    ), l.set(
      y,
      0
    ), l.set(
      a,
      y.length
    );
    const u = await c.subtle.digest(
      "SHA-256",
      l
    );
    f = new Uint8Array(
      u
    );
    const p = await c.subtle.importKey(
      "raw",
      o,
      { name: "PBKDF2" },
      !1,
      ["deriveKey"]
    );
    return await c.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: f,
        iterations: Re,
        hash: "SHA-256"
      },
      p,
      {
        name: "AES-GCM",
        length: 256
      },
      !1,
      [
        "encrypt",
        "decrypt"
      ]
    );
  } catch {
    throw v();
  } finally {
    try {
      o.fill(0);
    } catch {
    }
    try {
      s == null || s.fill(0);
    } catch {
    }
    try {
      a == null || a.fill(0);
    } catch {
    }
    try {
      l == null || l.fill(0);
    } catch {
    }
    try {
      f == null || f.fill(0);
    } catch {
    }
  }
}
function I() {
  throw new Error(
    "[AETERNA] Capsule sealed"
  );
}
function $t(e) {
  return e.buffer.byteLength === 0;
}
function Ht(e, t) {
  (!(e instanceof Uint8Array) || $t(e) || e.byteLength === 0 || e.byteLength > N) && I(), (!t || typeof t != "object" || Object.getPrototypeOf(t) !== Object.prototype) && I(), t.version !== 1 && I();
  const n = t.encryptedSizeBytes;
  (typeof n != "number" || !Number.isInteger(n) || n <= 0 || n > N) && I(), (typeof t.capsuleId != "string" || !C.test(
    t.capsuleId
  )) && I(), (!t.ext || typeof t.ext != "object" || Array.isArray(t.ext) || Object.getPrototypeOf(t.ext) !== Object.prototype || typeof t.ext.vaultSha256 != "string" || !R.test(t.ext.vaultSha256)) && I(), e.byteLength !== n && I();
}
function ye(e) {
  return e.buffer.byteLength === 0;
}
async function Ft(e) {
  let t = null;
  try {
    const n = globalThis.crypto;
    if (!(n != null && n.subtle))
      throw new Error(
        "[AETERNA] WebCrypto unavailable"
      );
    if (!(e instanceof Uint8Array) || e.byteLength === 0 || ye(e))
      throw new Error(
        "[AETERNA] Invalid SHA256 input"
      );
    const r = await n.subtle.digest(
      "SHA-256",
      e
    );
    if (!(r instanceof ArrayBuffer))
      throw new Error(
        "[AETERNA] SHA256 internal failure"
      );
    if (t = new Uint8Array(r), t.byteLength !== 32 || ye(t))
      throw new Error(
        "[AETERNA] SHA256 internal failure"
      );
    let i = "";
    for (let c = 0; c < t.length; c++) {
      const o = t[c];
      if (typeof o != "number")
        throw new Error(
          "[AETERNA] SHA256 internal failure"
        );
      i += o.toString(16).padStart(2, "0");
    }
    return i;
  } finally {
    try {
      t == null || t.fill(0);
    } catch {
    }
  }
}
function Kt(e) {
  return e.buffer.byteLength === 0;
}
function Gt(e, t) {
  if (e.length !== t.length)
    return !1;
  let n = 0;
  for (let r = 0; r < e.length; r++)
    n |= e.charCodeAt(r) ^ t.charCodeAt(r);
  return n === 0;
}
async function Vt(e, t) {
  if (typeof t != "string" || t.length !== 64 || !R.test(t))
    throw new Error(
      "[AETERNA] Invalid manifest.ext.vaultSha256"
    );
  if (!(e instanceof Uint8Array) || e.byteLength === 0 || Kt(e))
    throw new Error(
      "[AETERNA] Invalid ciphertext vault buffer"
    );
  if (e.byteLength > N)
    throw new Error(
      "[AETERNA] Ciphertext exceeds protocol size limit"
    );
  const n = await Ft(e);
  if (typeof n != "string" || n.length !== 64 || !R.test(n))
    throw new Error(
      "[AETERNA] Invalid sha256 computation result"
    );
  if (!Gt(
    n,
    t
  ))
    throw new Error(
      "[AETERNA] Vault integrity verification failed"
    );
}
const _ = 15778368e5, z = 41024448e5, Wt = Object.freeze(["vaultSha256"]), Xt = Object.freeze(["version", "createdAt", "capsule"]), Yt = Object.freeze(["capsuleId", "items"]), Zt = Object.freeze([
  "type",
  "text",
  "createdAt"
]), Jt = Object.freeze([
  "type",
  "mediaType",
  "filename",
  "mimeType",
  "size",
  "chunks",
  "createdAt"
]), qt = Object.freeze(["image", "video", "audio", "file"]);
function E() {
  throw new Error(
    "[AETERNA] Capsule is sealed"
  );
}
function Qt(e) {
  return e.byteLength === 0 || e.buffer.byteLength === 0;
}
function en(e, t) {
  if (!e || typeof e != "object" || Array.isArray(e) || Object.getPrototypeOf(e) !== Object.prototype)
    return !1;
  const n = e;
  for (const c of Object.keys(n))
    if (!Xt.includes(c))
      return !1;
  if (n.version !== 2 || typeof n.createdAt != "string")
    return !1;
  const r = Date.parse(n.createdAt);
  if (!Number.isFinite(r) || r < _ || r > z || !n.capsule || typeof n.capsule != "object" || Array.isArray(n.capsule) || Object.getPrototypeOf(n.capsule) !== Object.prototype)
    return !1;
  const i = n.capsule;
  for (const c of Object.keys(i))
    if (!Yt.includes(c))
      return !1;
  if (i.capsuleId !== t || !Array.isArray(i.items) || i.items.length > 100)
    return !1;
  for (const c of i.items) {
    if (!c || typeof c != "object" || Array.isArray(c) || Object.getPrototypeOf(c) !== Object.prototype)
      return !1;
    const o = c;
    if (o.type !== "text" && o.type !== "media")
      return !1;
    if (o.type === "text") {
      if (typeof o.text != "string" || typeof o.createdAt != "string")
        return !1;
      const s = Date.parse(o.createdAt);
      if (!Number.isFinite(s) || s < _ || s > z)
        return !1;
      for (const a of Object.keys(o))
        if (!Zt.includes(a))
          return !1;
    }
    if (o.type === "media") {
      if (typeof o.filename != "string" || o.filename.length === 0 || typeof o.mediaType != "string" || !qt.includes(o.mediaType) || typeof o.mimeType != "string" || o.mimeType.length === 0 || !Number.isInteger(o.size) || o.size < 0 || !Array.isArray(o.chunks) || typeof o.createdAt != "string")
        return !1;
      const s = Date.parse(o.createdAt);
      if (!Number.isFinite(s) || s < _ || s > z)
        return !1;
      for (const a of Object.keys(o))
        if (!Jt.includes(a))
          return !1;
    }
  }
  return !0;
}
function tn(e, t) {
  return en(e, t) || E(), e;
}
async function nn({
  capsuleId: e,
  secret: t,
  manifest: n
}) {
  crypto != null && crypto.subtle || E(), (!n || Array.isArray(n) || Object.getPrototypeOf(n) !== Object.prototype) && E(), n.version !== 1 && E(), (typeof e != "string" || !C.test(e)) && E(), (typeof t != "string" || !J.test(t)) && E(), n.capsuleId !== e && E(), (typeof n.saltBase != "string" || !B.test(n.saltBase)) && E(), (!Number.isInteger(n.openAt) || n.openAt < _ || n.openAt > z) && E(), (!Number.isInteger(n.sealedAt) || n.sealedAt < _ || n.sealedAt > z) && E(), n.openAt <= n.sealedAt && E(), (!Number.isInteger(
    n.encryptedSizeBytes
  ) || n.encryptedSizeBytes <= 0 || n.encryptedSizeBytes > N) && E(), (!n.ext || typeof n.ext != "object" || Array.isArray(n.ext) || Object.getPrototypeOf(n.ext) !== Object.prototype || typeof n.ext.vaultSha256 != "string") && E();
  for (const y of Object.keys(n.ext))
    Wt.includes(y) || E();
  const { nowUtc: r } = await ge();
  (!Number.isFinite(r) || r < _ || r > z) && E();
  const i = await Oe(
    e
  ), c = Te({
    manifestOpenAt: n.openAt,
    heartbeatInterval: n.heartbeatInterval,
    lastConfirmedAt: (i == null ? void 0 : i.lastConfirmedAt) ?? void 0
  });
  r < c && E(), n.ext.vaultSha256 || E();
  const o = O(
    n.vaultTxId
  ), s = await Rt.download(
    o
  );
  (!(s instanceof Uint8Array) || s.byteLength === 0 || s.byteLength > N) && E(), Ht(
    s,
    n
  ), await Vt(
    s,
    n.ext.vaultSha256
  );
  const a = await Dt({
    secret: t,
    saltBase: n.saltBase,
    openAt: n.openAt,
    capsuleId: e
  });
  t = "";
  let l;
  try {
    l = await Ut(
      s,
      a
    );
  } finally {
    Qt(s) || s.fill(0);
  }
  const f = tn(
    l,
    e
  );
  l = null;
  function d() {
    try {
      const y = JSON.stringify(
        f,
        null,
        2
      );
      if (y.length > 5e6)
        throw new Error();
      const u = new Blob(
        [y],
        { type: "application/json" }
      ), p = URL.createObjectURL(u);
      try {
        const m = document.createElement("a");
        m.href = p, m.download = `aeterna-capsule-${e}.json`, document.body.appendChild(m), m.click(), document.body.removeChild(m);
      } finally {
        window.setTimeout(() => {
          URL.revokeObjectURL(p);
        }, 1e3);
      }
    } catch {
    }
  }
  return {
    vault: f,
    cryptoKey: a,
    downloadVaultJson: d
  };
}
const rn = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  openCapsule: nn
}, Symbol.toStringTag, { value: "Module" }));
export {
  on as disposeEmergencyRuntime,
  cn as initEmergencyRuntime
};
