import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapPollOutcome, isTokenUsable } from '../../src/auth/deviceFlow.ts';

const NOW = 1_700_000_000_000;

describe('mapPollOutcome', () => {
  it('maps a present access_token to approved and stamps absolute expiry', () => {
    const outcome = mapPollOutcome(
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
    const outcome = mapPollOutcome({ access_token: 'est_abc' }, NOW);
    assert.ok(outcome.status === 'approved');
    assert.equal(outcome.token.tokenType, 'Bearer');
    assert.equal(outcome.token.expiresAt, NOW);
  });

  it('maps authorization_pending to pending', () => {
    assert.equal(mapPollOutcome({ error: 'authorization_pending' }, NOW).status, 'pending');
  });

  it('maps access_denied to denied', () => {
    assert.equal(mapPollOutcome({ error: 'access_denied' }, NOW).status, 'denied');
  });

  it('maps expired_token / invalid_grant / unknown errors to terminal expired', () => {
    assert.equal(mapPollOutcome({ error: 'expired_token' }, NOW).status, 'expired');
    assert.equal(mapPollOutcome({ error: 'invalid_grant' }, NOW).status, 'expired');
    assert.equal(mapPollOutcome({ error: 'something_new' }, NOW).status, 'expired');
    assert.equal(mapPollOutcome({}, NOW).status, 'expired');
  });

  it('prefers access_token even if an error field is also present', () => {
    const outcome = mapPollOutcome({ access_token: 'est_x', error: 'authorization_pending' }, NOW);
    assert.equal(outcome.status, 'approved');
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
