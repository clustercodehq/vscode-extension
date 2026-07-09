import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOrchestratorUrl, PROD_ORCHESTRATOR_URL, distinctOrigins } from '../../src/orchestrator-url.ts';

describe('resolveOrchestratorUrl', () => {
  it('uses the env value when set', () => {
    assert.equal(resolveOrchestratorUrl('http://localhost:3000'), 'http://localhost:3000');
  });
  it('trims the env value', () => {
    assert.equal(resolveOrchestratorUrl('  http://localhost:3000  '), 'http://localhost:3000');
  });
  it('falls back to the hosted console when env is undefined', () => {
    assert.equal(resolveOrchestratorUrl(undefined), PROD_ORCHESTRATOR_URL);
  });
  it('falls back to the hosted console when env is empty or whitespace', () => {
    assert.equal(resolveOrchestratorUrl(''), PROD_ORCHESTRATOR_URL);
    assert.equal(resolveOrchestratorUrl('   '), PROD_ORCHESTRATOR_URL);
  });
});

describe('PROD_ORCHESTRATOR_URL', () => {
  it('points at the hosted console', () => {
    assert.equal(PROD_ORCHESTRATOR_URL, 'https://console.clustercode.io');
  });
});

describe('distinctOrigins', () => {
  it('reduces a URL to just its origin', () => {
    assert.deepEqual(distinctOrigins(['http://localhost:3000/?x=1']), ['http://localhost:3000']);
  });
  it('dedupes same-origin URLs', () => {
    assert.deepEqual(
      distinctOrigins(['http://localhost:3000/', 'http://localhost:3000/login']),
      ['http://localhost:3000'],
    );
  });
  it('keeps distinct origins in first-seen order', () => {
    assert.deepEqual(
      distinctOrigins([
        'http://localhost:3000/',
        'http://localhost:3001/login?redirect_url=x',
        'http://localhost:3000/',
      ]),
      ['http://localhost:3000', 'http://localhost:3001'],
    );
  });
  it('treats different ports as different origins', () => {
    assert.deepEqual(
      distinctOrigins(['http://localhost:3000/', 'http://localhost:3001/']),
      ['http://localhost:3000', 'http://localhost:3001'],
    );
  });
  it('skips unparseable entries', () => {
    assert.deepEqual(distinctOrigins(['not a url', 'https://console.clustercode.io/x']), [
      'https://console.clustercode.io',
    ]);
  });
  it('returns an empty array for no input', () => {
    assert.deepEqual(distinctOrigins([]), []);
  });
});
