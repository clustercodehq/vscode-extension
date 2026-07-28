import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapPollOutcome,
  mapRefreshOutcome,
  nextRefreshDelayMs,
  refreshRetryDelayMs,
  isTokenUsable,
} from '../../src/auth/deviceFlow.ts';

const NOW = 1_700_000_000_000;

describe('mapPollOutcome', () => {
  it('maps a present access_token to approved and stamps absolute expiry', () => {
    const outcome = mapPollOutcome(
      200,
      { access_token: 'est_abc', token_type: 'Bearer', expires_in: 1200 },
      NOW,
    );
    assert.equal(outcome.status, 'approved');
    assert.ok(outcome.status === 'approved');
    assert.equal(outcome.token.accessToken, 'est_abc');
    assert.equal(outcome.token.tokenType, 'Bearer');
    assert.equal(outcome.token.expiresAt, NOW + 1200 * 1000);
  });

  it('defaults token_type to Bearer and expires_in to 0 when absent', () => {
    const outcome = mapPollOutcome(200, { access_token: 'est_abc' }, NOW);
    assert.ok(outcome.status === 'approved');
    assert.equal(outcome.token.tokenType, 'Bearer');
    assert.equal(outcome.token.expiresAt, NOW);
  });

  it('maps authorization_pending to pending (no diagnostic reason — the expected wait)', () => {
    const outcome = mapPollOutcome(400, { error: 'authorization_pending' }, NOW);
    assert.equal(outcome.status, 'pending');
    assert.ok(outcome.status === 'pending');
    assert.equal(outcome.reason, undefined);
  });

  it('maps access_denied to denied — the only server-driven terminal stop', () => {
    assert.equal(mapPollOutcome(400, { error: 'access_denied' }, NOW).status, 'denied');
  });

  it('keeps polling (pending) on expired_token / invalid_grant / rate-limit / 5xx / unknown / empty — only a denial or the client deadline stops the loop', () => {
    // These previously mapped to terminal `expired`, so a single transient blip
    // permanently aborted an otherwise-live pairing before the user could approve.
    assert.equal(mapPollOutcome(400, { error: 'expired_token' }, NOW).status, 'pending');
    assert.equal(mapPollOutcome(400, { error: 'invalid_grant' }, NOW).status, 'pending');
    assert.equal(mapPollOutcome(429, { error: 'Too many requests' }, NOW).status, 'pending');
    assert.equal(mapPollOutcome(502, { error: 'something_new' }, NOW).status, 'pending');
    assert.equal(mapPollOutcome(502, {}, NOW).status, 'pending');
    assert.equal(mapPollOutcome(200, {}, NOW).status, 'pending');
  });

  it('carries a diagnostic reason on a non-standard pending (error, else http_<status>, else no_response)', () => {
    const rateLimited = mapPollOutcome(429, { error: 'Too many requests' }, NOW);
    assert.ok(rateLimited.status === 'pending');
    assert.equal(rateLimited.reason, 'Too many requests');

    const emptyBody = mapPollOutcome(502, {}, NOW);
    assert.ok(emptyBody.status === 'pending');
    assert.equal(emptyBody.reason, 'http_502');

    const noResponse = mapPollOutcome(0, {}, NOW);
    assert.ok(noResponse.status === 'pending');
    assert.equal(noResponse.reason, 'no_response');
  });

  it('prefers access_token even if an error field is also present', () => {
    const outcome = mapPollOutcome(200, { access_token: 'est_x', error: 'authorization_pending' }, NOW);
    assert.equal(outcome.status, 'approved');
  });

  it('carries the refresh_token into the stored record when present', () => {
    const outcome = mapPollOutcome(
      200,
      { access_token: 'est_abc', refresh_token: 'ert_r1', expires_in: 600 },
      NOW,
    );
    assert.ok(outcome.status === 'approved');
    assert.equal(outcome.token.refreshToken, 'ert_r1');
  });

  it('leaves refreshToken undefined when the server sends none (old envelope)', () => {
    const outcome = mapPollOutcome(200, { access_token: 'est_abc', expires_in: 600 }, NOW);
    assert.ok(outcome.status === 'approved');
    assert.equal(outcome.token.refreshToken, undefined);
  });
});

describe('mapRefreshOutcome', () => {
  it('maps 200 with tokens to rotated, stamping absolute expiry and the NEW refresh token', () => {
    const outcome = mapRefreshOutcome(
      200,
      { access_token: 'est_new', refresh_token: 'ert_new', token_type: 'Bearer', expires_in: 600 },
      NOW,
    );
    assert.equal(outcome.kind, 'rotated');
    assert.ok(outcome.kind === 'rotated');
    assert.equal(outcome.token.accessToken, 'est_new');
    assert.equal(outcome.token.refreshToken, 'ert_new');
    assert.equal(outcome.token.tokenType, 'Bearer');
    assert.equal(outcome.token.expiresAt, NOW + 600 * 1000);
  });

  it('defaults token_type to Bearer and expires_in to 0 on a rotated outcome', () => {
    const outcome = mapRefreshOutcome(200, { access_token: 'est_new' }, NOW);
    assert.ok(outcome.kind === 'rotated');
    assert.equal(outcome.token.tokenType, 'Bearer');
    assert.equal(outcome.token.expiresAt, NOW);
  });

  it('maps 401 to session-ended — the only authoritative sign-out signal', () => {
    assert.equal(mapRefreshOutcome(401, { error: 'invalid_grant' }, NOW).kind, 'session-ended');
    assert.equal(mapRefreshOutcome(401, {}, NOW).kind, 'session-ended');
  });

  it('maps 404 (endpoint absent, rollout skew) to transient — NEVER a sign-out', () => {
    assert.equal(mapRefreshOutcome(404, {}, NOW).kind, 'transient');
  });

  it('maps 5xx to transient', () => {
    assert.equal(mapRefreshOutcome(500, { error: 'internal' }, NOW).kind, 'transient');
    assert.equal(mapRefreshOutcome(503, {}, NOW).kind, 'transient');
  });

  it('maps status 0 (no response) to transient', () => {
    assert.equal(mapRefreshOutcome(0, {}, NOW).kind, 'transient');
  });

  it('maps a malformed 200 (missing access_token) to transient, not rotated', () => {
    assert.equal(mapRefreshOutcome(200, {}, NOW).kind, 'transient');
    assert.equal(mapRefreshOutcome(200, { refresh_token: 'ert_only' }, NOW).kind, 'transient');
  });

  it('maps other 4xx (e.g. 400 bad request) to transient', () => {
    assert.equal(mapRefreshOutcome(400, { error: 'invalid_request' }, NOW).kind, 'transient');
  });
});

describe('nextRefreshDelayMs', () => {
  it('fires leadMs before expiry under normal conditions', () => {
    // Token expires in 10 min; default 60 s lead → fire in 9 min.
    assert.equal(nextRefreshDelayMs(NOW + 600_000, NOW), 540_000);
  });

  it('clamps to minDelayMs when expiry is nearer than the lead', () => {
    assert.equal(nextRefreshDelayMs(NOW + 30_000, NOW), 1_000);
  });

  it('clamps to minDelayMs (never negative/zero) when the token is already expired', () => {
    assert.equal(nextRefreshDelayMs(NOW - 600_000, NOW), 1_000);
    assert.ok(nextRefreshDelayMs(NOW - 600_000, NOW) > 0);
  });

  it('honors custom lead and min-delay values', () => {
    assert.equal(nextRefreshDelayMs(NOW + 600_000, NOW, 120_000, 5_000), 480_000);
    assert.equal(nextRefreshDelayMs(NOW + 100, NOW, 120_000, 5_000), 5_000);
  });

  it('default jitter (0) leaves the delay deterministic', () => {
    // rand must not even be consulted when jitterMs is 0.
    const rand = () => {
      throw new Error('rand should not be called when jitterMs=0');
    };
    assert.equal(nextRefreshDelayMs(NOW + 600_000, NOW, 60_000, 1_000, 0, rand), 540_000);
  });

  it('subtracts a [0, jitterMs) slice so two windows fire at different instants', () => {
    // Same expiresAt, different rand() → different (earlier) delays.
    const winA = nextRefreshDelayMs(NOW + 600_000, NOW, 60_000, 1_000, 15_000, () => 0); // no jitter
    const winB = nextRefreshDelayMs(NOW + 600_000, NOW, 60_000, 1_000, 15_000, () => 0.5); // -7500
    assert.equal(winA, 540_000, 'jitter only ever moves the fire earlier, never later than the lead point');
    assert.equal(winB, 540_000 - 7_500);
    assert.ok(winB < winA, 'two windows off the identical expiry de-sync');
  });

  it('jitter never delays a near-expired salvage past minDelayMs', () => {
    // Already-expired token: even the largest jitter can only clamp to minDelayMs,
    // so a reload/restart salvage stays near-immediate.
    assert.equal(nextRefreshDelayMs(NOW - 600_000, NOW, 60_000, 1_000, 15_000, () => 0.999), 1_000);
  });
});

describe('refreshRetryDelayMs', () => {
  it('starts at the base delay and doubles per consecutive failure', () => {
    assert.equal(refreshRetryDelayMs(0), 30_000);
    assert.equal(refreshRetryDelayMs(1), 60_000);
    assert.equal(refreshRetryDelayMs(2), 120_000);
  });

  it('is capped at the max delay', () => {
    assert.equal(refreshRetryDelayMs(4), 300_000);
    assert.equal(refreshRetryDelayMs(50), 300_000);
  });

  it('clamps a negative/fractional attempt to a sane non-negative integer', () => {
    assert.equal(refreshRetryDelayMs(-3), 30_000);
    assert.equal(refreshRetryDelayMs(1.9), 60_000);
  });

  it('honors custom base and max', () => {
    assert.equal(refreshRetryDelayMs(0, 1_000, 4_000), 1_000);
    assert.equal(refreshRetryDelayMs(3, 1_000, 4_000), 4_000);
  });
});

describe('isTokenUsable', () => {
  const skew = 30_000;

  it('is usable when expiry is comfortably in the future', () => {
    assert.equal(isTokenUsable({ accessToken: 't', tokenType: 'Bearer', expiresAt: NOW + 600_000 }, NOW, skew), true);
  });

  it('is unusable once already expired', () => {
    assert.equal(isTokenUsable({ accessToken: 't', tokenType: 'Bearer', expiresAt: NOW - 1 }, NOW, skew), false);
  });

  it('is unusable inside the skew window (about to expire mid-flight)', () => {
    assert.equal(isTokenUsable({ accessToken: 't', tokenType: 'Bearer', expiresAt: NOW + skew - 1 }, NOW, skew), false);
  });

  it('is usable exactly past the skew boundary', () => {
    assert.equal(isTokenUsable({ accessToken: 't', tokenType: 'Bearer', expiresAt: NOW + skew + 1 }, NOW, skew), true);
  });
});
