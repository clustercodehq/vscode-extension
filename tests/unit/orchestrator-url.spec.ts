import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveOrchestratorUrl,
  PROD_ORCHESTRATOR_URL,
  distinctOrigins,
  buildEmbedUrl,
} from '../../src/orchestrator-url.ts';

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

describe('buildEmbedUrl', () => {
  it('appends the embed path to a base URL with no trailing slash', () => {
    assert.equal(
      buildEmbedUrl('http://localhost:3000', { _vscTheme: 'dark' }),
      'http://localhost:3000/embed?_vscTheme=dark',
    );
  });
  it('appends the embed path to a base URL with a trailing slash', () => {
    assert.equal(
      buildEmbedUrl('http://localhost:3000/', { _vscTheme: 'dark' }),
      'http://localhost:3000/embed?_vscTheme=dark',
    );
  });
  it('works against the hosted console URL', () => {
    assert.equal(
      buildEmbedUrl(PROD_ORCHESTRATOR_URL, { _vscTheme: 'light' }),
      `${PROD_ORCHESTRATOR_URL}/embed?_vscTheme=light`,
    );
  });
  it('appends multiple params in insertion order', () => {
    assert.equal(
      buildEmbedUrl('http://localhost:3000', {
        _vscTheme: 'dark',
        _cbUrl: 'http://127.0.0.1:54321',
        _cbToken: 'abc123',
      }),
      'http://localhost:3000/embed?_vscTheme=dark&_cbUrl=http%3A%2F%2F127.0.0.1%3A54321&_cbToken=abc123',
    );
  });
  it('URL-encodes param values', () => {
    const url = buildEmbedUrl('http://localhost:3000', { _cbUrl: 'http://127.0.0.1:9999' });
    assert.equal(url, 'http://localhost:3000/embed?_cbUrl=http%3A%2F%2F127.0.0.1%3A9999');
  });
  it('returns just the embed path when no params are given', () => {
    assert.equal(buildEmbedUrl('http://localhost:3000', {}), 'http://localhost:3000/embed');
  });
});
