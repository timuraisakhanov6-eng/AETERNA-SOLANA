import {
  useEffect,
  useRef,
  useState,
  useMemo,
} from "react";

import {
  CAPSULE_ID_REGEX
} from "@/lib/crypto/validators";

import CapsuleOpened from "./CapsuleOpened";
import CapsuleView from "./CapsuleView";

import { loadManifest } from "@/lib/capsule/loadManifest";
import { openCapsule } from "@/lib/capsule/openCapsule";
import { loadHeartbeatRecord } from "@/lib/capsule/loadHeartbeatRecord";
import { resolveEffectiveOpenAt } from "@/shared/heartbeat/resolveEffectiveOpenAt";
import { getTrustedTime } from "@/shared/time/getTrustedTime";

import type {
  ManifestV1,
  OpenAtUtc,
} from "@/types/manifest";
import type { Vault } from "@/types/vault";


type Props = {
  capsuleId: string;
  secret?: string;
  creatorAuthorityFragment?: string;
};


type InternalState =
  | { status: "loading" }
  | { status: "preview"; manifest: ManifestV1 }
  | {
      status: "opened";
      manifest: ManifestV1;
      vault: Vault;
      cryptoKey?: CryptoKey;
    }
  | { status: "error" };


/**
 * FINDING 2 — DEV-only diagnostics helper.
 *
 * Matches the canonical Runtime logging policy used across the
 * Runtime Layer (Storage, Vault rendering, Capsule opening).
 *
 * Non-fatal diagnostics (warn/log) are DEV-only noise reduction;
 * they never influence control flow.
 */
function devLog(
  level: "warn" | "error" | "log",
  ...args: unknown[]
): void {

  if (import.meta.env.DEV) {
    console[level](...args);
  }

}


export default function CapsuleController({
  capsuleId,
  secret,
  creatorAuthorityFragment,
}: Props) {

  if (!CAPSULE_ID_REGEX.test(capsuleId)) {

    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background text-foreground gap-4 p-6">
        <p className="text-sm tracking-wider uppercase text-muted-foreground font-medium text-center">
          Invalid capsule identifier.
        </p>
      </div>
    );

  }

  const secretRef =
    useRef<string>(secret ?? "");

  const authorityFragmentRef =
    useRef<string>(
      creatorAuthorityFragment ?? ""
    );

  const hasAuthorityCapability =
    typeof creatorAuthorityFragment === "string" &&
    creatorAuthorityFragment.length > 0;

  const [state, setState] =
    useState<InternalState>({
      status: "loading",
    });

  // [А] Отображаемая дата открытия — обновляется при heartbeat
  const [displayOpenAt, setDisplayOpenAt] =
    useState<OpenAtUtc | null>(null);


  const manifestRef =
    useRef<ManifestV1 | null>(null);

  const heartbeatRef =
    useRef<number | undefined>(undefined);


  // openedRef: true ONLY on successful capsule open.
  // Semantic contract: "vault was decrypted and delivered to UI".
  // Do NOT set on fatal auth failure or cancellation.
  const openedRef =
    useRef<boolean>(false);

  const cancelledRef =
    useRef<boolean>(false);

  const openingRef =
    useRef<boolean>(false);

  // terminatedRef: orchestration authority flag.
  // True whenever the open pipeline must stop permanently:
  //   (a) successful open   — capsule delivered, no further work needed
  //   (b) INVALID_SECRET    — fatal auth failure, retrying is pointless
  //
  // Distinct from cancelledRef (component unmount / capsuleId change)
  // and from openedRef (success-only semantic).
  //
  // All tryOpen entry guards and interval/focus/visibility guards
  // use terminatedRef, NOT openedRef, so that adding future
  // success-only semantics to openedRef never accidentally unlocks
  // a terminated-but-not-opened pipeline.
  const terminatedRef =
    useRef<boolean>(false);


  const intervalRef =
    useRef<ReturnType<typeof setInterval> | null>(
      null
    );


  const heartbeatPollRef =
    useRef<ReturnType<typeof setInterval> | null>(
      null
    );

  // FINDING 1 — per-invocation effect generation identity.
  // Each effect run bumps generationRef; see the effect body for the
  // full contract. Also read by the render-scoped onConfirmPresence.
  const generationRef =
    useRef<number>(0);


  useEffect(() => {

    secretRef.current = secret ?? "";
    authorityFragmentRef.current =
      creatorAuthorityFragment ?? "";

    manifestRef.current = null;
    heartbeatRef.current = undefined;

    openedRef.current = false;
    cancelledRef.current = false;
    openingRef.current = false;
    terminatedRef.current = false;  // reset on capsuleId / secret change

    // FINDING 1 — per-invocation generation identity.
    //
    // Every effect invocation owns a unique generation value. All async
    // work created inside this effect (init, tryOpen, heartbeat
    // polling) belongs to this generation and MUST NOT commit state
    // once the generation is stale — i.e. after navigation to another
    // capsule/capability (generationRef advanced) or unmount
    // (cancelledRef set by cleanup).
    //
    // This closes the race where an async operation from capsule A
    // could observe cancelledRef === false again after capsule B's
    // effect reset the shared flag, and mutate B's runtime state.
    const generation =
      ++generationRef.current;

    const isStale = (): boolean =>
      generation !== generationRef.current ||
      cancelledRef.current;

    // [Б] Сбросить дату при смене capsuleId
    setDisplayOpenAt(null);


    async function init(): Promise<void> {

      try {

        const manifest =
          await loadManifest(
            capsuleId
          );

        if (
          isStale() ||
          manifest == null
        ) return;


        if (manifest.version !== 1)
          throw new Error("Unsupported manifest version");

        if (manifest.capsuleId !== capsuleId)
          throw new Error("Capsule identity mismatch");

        if (
          manifest.openAt == null ||
          manifest.vaultTxId == null ||
          manifest.saltBase == null ||
          manifest.encryptedSizeBytes == null ||
          manifest.ext?.vaultSha256 == null
        ) {
          throw new Error("Manifest corrupted");
        }

        const MIN_TIME = 1577836800000; // 2020-01-01T00:00:00.000Z
        const MAX_TIME = 4102444800000; // 2100-01-01T00:00:00.000Z

        if (
          !Number.isFinite(manifest.openAt) ||
          !Number.isSafeInteger(manifest.openAt) ||
          manifest.openAt < MIN_TIME ||
          manifest.openAt > MAX_TIME
        ) {
          throw new Error("Invalid manifest.openAt");
        }


        manifestRef.current =
          Object.freeze(
            structuredClone(manifest)
          );


        try {

          const record =
            await loadHeartbeatRecord(
              capsuleId
            );

          const ts = record?.lastConfirmedAt;

          heartbeatRef.current =
            typeof ts === "number" &&
            Number.isFinite(ts)
              ? ts
              : undefined;

        } catch (error) {

          devLog(
            "warn",
            "[AETERNA] heartbeat initial load failed",
            error
          );

          heartbeatRef.current = undefined;

        }

        // FINDING 1 — re-check staleness after the second async gap
        // (loadHeartbeatRecord) before committing any state: a stale
        // init() from a previous capsule must not overwrite the new
        // runtime's displayed open date or manifest.
        if (isStale())
          return;

        // [В] Вычислить effectiveOpenAt до первого рендера preview.
        // React 18 батчит оба вызова — один рендер, без мерцания.
        setDisplayOpenAt(
          resolveEffectiveOpenAt({
            manifestOpenAt: manifest.openAt,

            heartbeatInterval:
              manifest.heartbeatInterval,

            lastConfirmedAt:
              heartbeatRef.current,
          })
        );

        if (isStale())
          return;

        setState({
          status: "preview",
          manifest: manifestRef.current!,
        });


        queueMicrotask(() => {

          if (
            !isStale() &&
            !terminatedRef.current &&       // guard: use terminatedRef
            manifestRef.current &&
            !openedRef.current
          ) {
            void tryOpen(manifestRef.current);
          }

        });


        intervalRef.current =
          setInterval(() => {

            if (
              manifestRef.current &&
              !terminatedRef.current &&     // guard: use terminatedRef
              !openingRef.current
            ) {
              void tryOpen(manifestRef.current);
            }

          }, 5000);


        heartbeatPollRef.current =
          setInterval(async () => {

            if (!manifestRef.current)
              return;

            try {

              const record =
                await loadHeartbeatRecord(
                  capsuleId
                );

              // FINDING 1 — an in-flight poll tick from a previous
              // capsule must not refresh refs or state of the new one.
              if (isStale())
                return;

              const newTimestamp =
                record?.lastConfirmedAt ?? undefined;

              if (
                newTimestamp !==
                heartbeatRef.current
              ) {
                heartbeatRef.current =
                  newTimestamp;

                // [Г] Обновить отображаемую дату при изменении heartbeat
                if (manifestRef.current && !isStale()) {
                  setDisplayOpenAt(
                    resolveEffectiveOpenAt({
                      manifestOpenAt:
                        manifestRef.current.openAt,

                      heartbeatInterval:
                        manifestRef.current.heartbeatInterval,

                      lastConfirmedAt:
                        heartbeatRef.current,
                    })
                  );
                }

                if (
                  manifestRef.current &&
                  !terminatedRef.current && // guard: use terminatedRef
                  !openingRef.current
                ) {
                  void tryOpen(manifestRef.current);
                }
              }

            } catch (error) {

              devLog(
                "warn",
                "[AETERNA] heartbeat refresh failed",
                error
              );

            }

          }, 30000);

      }

      catch (error) {

        devLog(
          "error",
          "[AETERNA] capsule initialization failed",
          error
        );

        if (!isStale()) {

          setState({
            status: "error",
          });

        }

      }

    }



    async function tryOpen(
      manifest: ManifestV1
    ): Promise<void> {

      if (
        isStale() ||
        terminatedRef.current ||         // guard: use terminatedRef
        openingRef.current
      ) return;


      openingRef.current = true;


      let secretLocal =
        secretRef.current;

      let tookSecretOwnership = false;


      try {

        const { nowUtc } =
          await getTrustedTime();

        // FINDING 1 — a stale tryOpen (previous capsule/generation)
        // must not wipe the current secretRef or decrypt the wrong
        // capsule. Bail before any shared-ref mutation.
        if (isStale())
          return;


        const effectiveOpenAt =
          resolveEffectiveOpenAt({

            manifestOpenAt:
              manifest.openAt,

            heartbeatInterval:
              manifest.heartbeatInterval,

            lastConfirmedAt:
              heartbeatRef.current

          });


        if (nowUtc < effectiveOpenAt) {

          openingRef.current = false;
          return;

        }


        if (!secretLocal) {

          openingRef.current = false;

          return;

        }


        tookSecretOwnership = true;
        secretRef.current = "";


        const result =
          await openCapsule({

            capsuleId,
            secret: secretLocal,
            manifest,

          });


        if (isStale())
          return;


        // Successful open: set BOTH flags.
        // openedRef     → "vault was successfully decrypted and delivered"
        // terminatedRef → "orchestration pipeline is permanently closed"
        openedRef.current = true;
        terminatedRef.current = true;


        if (intervalRef.current) {

          clearInterval(intervalRef.current);
          intervalRef.current = null;

        }


        if (heartbeatPollRef.current) {

          clearInterval(
            heartbeatPollRef.current
          );

          heartbeatPollRef.current =
            null;

        }

        // FINDING 1 — re-check staleness immediately before the
        // state update that follows this async gap (clearInterval calls
        // + ref writes). Narrow window, but the check is cheap and makes
        // the contract explicit rather than implicit.
        if (isStale()) {
           return;
        }

        setState({

           status: "opened",
           manifest,
           vault: result.vault,
           cryptoKey: result.cryptoKey,

     });

      }

      catch (err: unknown) {

        if (
          err &&
          typeof err === "object" &&
          (err as { code?: string }).code ===
            "INVALID_SECRET"
        ) {

          // FINDING 1 — a stale open failure must not destroy the new
          // runtime's secret ref, terminate its pipeline, or clear
          // its intervals.
          if (isStale()) {
            return;
          }

          tookSecretOwnership = true;
          secretRef.current = "";

          // Fatal auth failure: set terminatedRef ONLY.
          // openedRef remains false — the capsule was NOT successfully opened.
          // terminatedRef → "orchestration pipeline is permanently closed"
          terminatedRef.current = true;


          if (intervalRef.current) {

            clearInterval(intervalRef.current);
            intervalRef.current = null;

          }

          if (heartbeatPollRef.current) {

            clearInterval(
              heartbeatPollRef.current
            );

            heartbeatPollRef.current =
              null;

          }

          // FINDING 1 — same re-check applied to the fatal-auth-failure
          // path: this setState also follows clearInterval calls and
          // ref writes after the awaited openCapsule() call.
          if (isStale()) {
            return;
          }

          setState({
            status: "error",
          });

        }

      }

      finally {

        secretLocal = "";

        // FINDING 1 — a stale tryOpen must not reset refs owned by the
        // current runtime: openingRef may have been re-acquired by a
        // newer tryOpen, and secretRef may now hold a new capsule's
        // secret that must not be destroyed.
        if (!isStale()) {

          openingRef.current = false;

          if (tookSecretOwnership) {
            secretRef.current = "";
          }

        }

      }

    }



    function onFocus(): void {

      if (
        manifestRef.current &&
        !terminatedRef.current &&         // guard: use terminatedRef
        !openingRef.current
      ) {
        void tryOpen(manifestRef.current);
      }

    }



    function onVisibilityChange(): void {

      if (
        document.visibilityState ===
          "visible" &&
        manifestRef.current &&
        !terminatedRef.current &&         // guard: use terminatedRef
        !openingRef.current
      ) {
        void tryOpen(manifestRef.current);
      }

    }



    void init();


    window.addEventListener(
      "focus",
      onFocus
    );

    document.addEventListener(
      "visibilitychange",
      onVisibilityChange
    );


    return () => {

      cancelledRef.current = true;

      window.removeEventListener(
        "focus",
        onFocus
      );

      document.removeEventListener(
        "visibilitychange",
        onVisibilityChange
      );


      if (intervalRef.current) {

        clearInterval(intervalRef.current);
        intervalRef.current = null;

      }


      if (heartbeatPollRef.current) {

        clearInterval(
          heartbeatPollRef.current
        );

        heartbeatPollRef.current = null;

      }

    };

  }, [
    capsuleId,
    secret,
    creatorAuthorityFragment,
  ]);



  const shareUrl =
    useMemo(() => {

      if (typeof window === "undefined") {
        return "";
      }

      const origin =
        window.location.origin;

      const recipientSecret =
        secretRef.current;

      if (!recipientSecret) {
        return "";
      }

      return (
        origin +
        "/capsule/" +
        capsuleId +
        "#" +
        recipientSecret
      );

    }, [capsuleId]);

  const creatorShareUrl =
    useMemo(() => {

      if (typeof window === "undefined") {
        return undefined;
      }

      if (!hasAuthorityCapability) {
        return undefined;
      }

      const origin =
        window.location.origin;

      const recipientSecret =
        secretRef.current;

      const fragment =
        authorityFragmentRef.current;

      if (!recipientSecret || !fragment) {
        return undefined;
      }

      return (
        origin +
        "/capsule/" +
        capsuleId +
        "#" +
        recipientSecret +
        "&c=" +
        fragment
      );

    }, [capsuleId, hasAuthorityCapability]);



  // RENDERER IDENTITY GATE — INVARIANTS.md §4.1.
  //
  // The component-level state persists across prop changes: after
  // navigating from capsule A to capsule B, until the new init()
  // resolves, state still holds A's manifest/vault. Rendering that
  // stale content under capsuleId B would break capsuleId continuity
  // across the renderer runtime — "Identity mismatch MUST invalidate
  // the runtime" — and would display a previous capsule's decrypted
  // vault after navigation.
  //
  // Never render preview/opened content whose manifest does not
  // belong to the current route capsuleId; fall through to the
  // loading view instead.
  const stateMatchesRoute =
    (state.status === "preview" ||
      state.status === "opened") &&
    state.manifest.capsuleId === capsuleId;

  if (state.status === "opened" && stateMatchesRoute) {

    if (!state.cryptoKey)
      throw new Error(
        "[AETERNA] Missing cryptoKey"
      );

    return (

      <CapsuleView
        state={{

          status: "opened",

          authorityMode:
            hasAuthorityCapability,

          content: (

            <CapsuleOpened

              manifest={
                state.manifest
              }

              capsuleId={
                capsuleId
              }

              initialVault={
                state.vault
              }

              initialCryptoKey={
                state.cryptoKey
              }

            />

          ),

        }}

      />

    );

  }



  if (state.status === "preview" && stateMatchesRoute) {

    const { manifest } =
      state;

    return (

      <CapsuleView
        state={{

          status: "preview",

          capsuleId: capsuleId,

          authorityMode:
            hasAuthorityCapability,

          onConfirmPresence:
            async () => {

              // FINDING 1 — capture the effect generation this handler
              // belongs to. A confirmation that completes after
              // navigation or unmount must not commit state into the
              // new runtime.
              const generation =
                generationRef.current;

              const stale = (): boolean =>
                generation !==
                  generationRef.current ||
                cancelledRef.current;

              const fragment =
                authorityFragmentRef.current;

              if (!fragment) {
                devLog(
                  "warn",
                  "[AETERNA] confirmPresence: missing authority fragment"
                );
                return;
              }

              try {

                const { nowUtc } =
                  await getTrustedTime();

                if (stale())
                  return;

                const {
                  confirmPresence
                } = await import(
                  "@/lib/heartbeat/confirmPresence"
                );

                // FINDING 1 — a stale confirmation must not fire a
                // server call for the previous capsule.
                if (stale())
                  return;

                const result =
                  await confirmPresence({

                    capsuleId,

                    creatorAuthorityFragment:
                      fragment,

                    manifestOpenAt:
                      manifest.openAt,

                    heartbeatInterval:
                      manifest.heartbeatInterval,

                    lastConfirmedAt:
                      heartbeatRef.current,

                    trustedNow:
                      nowUtc,

                  });

                if (result === "confirmed") {

                  if (stale())
                    return;

                  devLog(
                    "log",
                    "[AETERNA] presence confirmed"
                  );

                  // [Д] Перечитать свежий heartbeat и сразу обновить дату в UI
                  try {
                    const freshRecord = await loadHeartbeatRecord(capsuleId);
                    if (stale())
                      return;
                    const freshTs = freshRecord?.lastConfirmedAt;
                    if (
                      typeof freshTs === "number" &&
                      Number.isFinite(freshTs)
                    ) {
                      heartbeatRef.current = freshTs;
                    }
                  } catch (err) {
                    devLog(
                      "warn",
                      "[AETERNA] heartbeat reload after confirm failed",
                      err
                    );
                  }

                  if (!stale()) {
                    setDisplayOpenAt(
                      resolveEffectiveOpenAt({
                        manifestOpenAt: manifest.openAt,

                        heartbeatInterval:
                          manifest.heartbeatInterval,

                        lastConfirmedAt:
                          heartbeatRef.current,
                      })
                    );
                  }

                }

                if (result === "expired") {

                  devLog(
                    "warn",
                    "[AETERNA] confirmation window expired"
                  );

                }

                if (result === "rejected") {

                  devLog(
                    "warn",
                    "[AETERNA] confirmation rejected"
                  );

                }

              } catch (error) {

                devLog(
                  "warn",
                  "[AETERNA] confirmPresence failed",
                  error
                );

              }

            },

          title:
            manifest.description ?? "",

          // [Е] displayOpenAt с фоллбэком на manifest.openAt (защита от race
          // между setDisplayOpenAt и первым рендером, теоретически невозможного
          // из-за батчинга React 18, но явный контракт лучше молчаливого).
          openAt:
              displayOpenAt ??
              manifest.openAt,

          shareUrl,

          creatorShareUrl,

          onCopyLink:
            async () => {

              try {

                await navigator.clipboard.writeText(
                  shareUrl
                );

              } catch (error) {

                devLog(
                  "warn",
                  "[AETERNA] clipboard write failed",
                  error
                );

              }

            },

          onCopyCreatorLink:
            creatorShareUrl
              ? async () => {

                  try {

                    await navigator.clipboard.writeText(
                      creatorShareUrl
                    );

                  } catch (error) {

                    devLog(
                      "warn",
                      "[AETERNA] clipboard write failed",
                      error
                    );

                  }

                }
              : undefined,

          onPrint:
            () => {

              setTimeout(() => {

                window.print();

              }, 500);

            },

          onCreate:
            () =>
              window.location.assign(
                "/create"
              ),

        }}

      />

    );

  }



  if (state.status === "error") {

    return (

      <div className="min-h-screen flex flex-col items-center justify-center bg-background text-foreground gap-4 p-6">

        <p className="text-sm tracking-wider uppercase text-muted-foreground font-medium text-center">

          Could not load capsule. Check your link and try again.

        </p>

        <button
          onClick={() =>
            window.location.reload()
          }
          className="text-xs underline underline-offset-4 text-muted-foreground hover:text-foreground transition-colors"
        >

          Retry

        </button>

      </div>

    );

  }



  return (

    <CapsuleView
      state={{
        status: "opening",
      }}
    />

  );

}