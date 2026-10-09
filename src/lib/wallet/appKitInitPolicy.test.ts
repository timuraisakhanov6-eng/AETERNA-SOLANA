/**
 * AETERNA — AppKit initialization policy tests (security).
 *
 * SYNTHETIC values only. No real capsule secret is used anywhere here.
 *
 * Context: AppKit's MANDATORY `INITIALIZE` telemetry embeds
 * `url: window.location.href`. The policy must keep capability-bearing URLs
 * away from that event by deferring eager AppKit construction. The guard is
 * route/fragment-PRESENCE based, so it must not depend on the 64-hex shape.
 */

import { describe, it, expect } from 'vitest';
import {
  isCapsuleOpenPath,
  hasCapabilityFragment,
  shouldDeferAppKitInitialization,
} from '@/lib/wallet/appKitInitPolicy';

const SYNTHETIC_CAPSULE_ID = 'c'.repeat(64);
const SYNTHETIC_RECIPIENT = 'a'.repeat(64);
const SYNTHETIC_AUTHORITY = 'b'.repeat(64);

describe('isCapsuleOpenPath', () => {
  it('recognizes the capsule-open route', () => {
    expect(isCapsuleOpenPath(`/capsule/${SYNTHETIC_CAPSULE_ID}`)).toBe(true);
  });

  it('recognizes a trailing-slash variant', () => {
    expect(isCapsuleOpenPath(`/capsule/${SYNTHETIC_CAPSULE_ID}/`)).toBe(true);
  });

  it('does NOT treat the creator preview route as a capsule-open route', () => {
    expect(isCapsuleOpenPath('/capsule/preview')).toBe(false);
  });

  it('does NOT treat the bare capsule prefix as a capsule-open route', () => {
    expect(isCapsuleOpenPath('/capsule/')).toBe(false);
    expect(isCapsuleOpenPath('/capsule')).toBe(false);
  });

  it('does NOT match unrelated routes', () => {
    expect(isCapsuleOpenPath('/create')).toBe(false);
    expect(isCapsuleOpenPath('/')).toBe(false);
    expect(isCapsuleOpenPath('/create/hold')).toBe(false);
  });
});

describe('hasCapabilityFragment', () => {
  it('detects a recipient capability fragment', () => {
    expect(hasCapabilityFragment(`#${SYNTHETIC_RECIPIENT}`)).toBe(true);
  });

  it('detects a creator capability fragment', () => {
    expect(hasCapabilityFragment(`#${SYNTHETIC_RECIPIENT}&c=${SYNTHETIC_AUTHORITY}`)).toBe(true);
  });

  it('detects a creator-only authority fragment', () => {
    expect(hasCapabilityFragment(`#c=${SYNTHETIC_AUTHORITY}`)).toBe(true);
  });

  it('detects an UNKNOWN fragment form (presence-based, not shape-based)', () => {
    expect(hasCapabilityFragment('#synthetic-unknown-form')).toBe(true);
  });

  it('returns false for empty fragments', () => {
    expect(hasCapabilityFragment('')).toBe(false);
    expect(hasCapabilityFragment('#')).toBe(false);
  });
});

describe('shouldDeferAppKitInitialization', () => {
  it('defers on the capsule-open route with a recipient capability', () => {
    expect(
      shouldDeferAppKitInitialization(
        `/capsule/${SYNTHETIC_CAPSULE_ID}`,
        `#${SYNTHETIC_RECIPIENT}`
      )
    ).toBe(true);
  });

  it('defers on the capsule-open route with a creator capability', () => {
    expect(
      shouldDeferAppKitInitialization(
        `/capsule/${SYNTHETIC_CAPSULE_ID}`,
        `#${SYNTHETIC_RECIPIENT}&c=${SYNTHETIC_AUTHORITY}`
      )
    ).toBe(true);
  });

  it('defers on the capsule-open route even without a fragment', () => {
    expect(
      shouldDeferAppKitInitialization(`/capsule/${SYNTHETIC_CAPSULE_ID}`, '')
    ).toBe(true);
  });

  it('defers on any path that carries a capability fragment', () => {
    expect(
      shouldDeferAppKitInitialization('/create/hold', `#c=${SYNTHETIC_AUTHORITY}`)
    ).toBe(true);
  });

  it('does NOT defer on a normal creator page', () => {
    expect(shouldDeferAppKitInitialization('/create', '')).toBe(false);
  });

  it('does NOT defer on the creator preview route', () => {
    expect(shouldDeferAppKitInitialization('/capsule/preview', '')).toBe(false);
  });

  it('does NOT defer on the home page', () => {
    expect(shouldDeferAppKitInitialization('/', '')).toBe(false);
  });
});

describe('telemetry payload shape (capability leakage)', () => {
  it('a deferred URL carrying a capability is never the href AppKit would send', () => {
    // Simulates the decision: if deferral is required, AppKit is not created,
    // so the mandatory INITIALIZE event (which embeds window.location.href)
    // is never emitted for this location.
    const pathname = `/capsule/${SYNTHETIC_CAPSULE_ID}`;
    const hash = `#${SYNTHETIC_RECIPIENT}`;
    const href = `https://aeterna-solana.pages.dev${pathname}${hash}`;

    expect(href.includes(SYNTHETIC_RECIPIENT)).toBe(true);
    expect(shouldDeferAppKitInitialization(pathname, hash)).toBe(true);
  });
});
