import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveOrchestratorUrl,
  PROD_ORCHESTRATOR_URL,
  distinctOrigins,
  buildEmbedUrl,
  safeHttpOrigin,
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
  // Regression: new URL('localhost:3000').origin is the literal string
  // "null", not a thrown error — a scheme-less URL must not leak that
  // string into the result as if it were a real origin.
  it('skips a scheme-less host:port instead of returning the literal "null"', () => {
    assert.deepEqual(distinctOrigins(['localhost:3000']), []);
  });
  it('skips non-http(s) schemes (e.g. file:, data:) instead of returning "null"', () => {
    assert.deepEqual(distinctOrigins(['file:///etc/passwd', 'data:text/plain,hi']), []);
  });
});

describe('safeHttpOrigin', () => {
  it('returns the origin for an http URL', () => {
    assert.equal(safeHttpOrigin('http://localhost:3000'), 'http://localhost:3000');
  });
  it('returns the origin for an https URL, including a non-default port', () => {
    assert.equal(safeHttpOrigin('https://console.example.io:8080'), 'https://console.example.io:8080');
  });
  it('normalizes away path/query/fragment', () => {
    assert.equal(safeHttpOrigin('http://localhost:3000/embed?x=1#y'), 'http://localhost:3000');
  });
  // Regression (root cause): new URL('localhost:3000') does NOT throw — it
  // parses as an opaque-origin URL whose .origin is the literal string
  // "null". A naive try/catch around new URL(...).origin lets that string
  // through as if it were a real, usable origin. It must return null here.
  it('returns null for a scheme-less host:port (does not return the string "null")', () => {
    const result = safeHttpOrigin('localhost:3000');
    assert.equal(result, null);
    assert.notEqual(result, 'null');
  });
  it('returns null for a non-URL string', () => {
    assert.equal(safeHttpOrigin('not a url'), null);
  });
  it('returns null for a data: URL', () => {
    assert.equal(safeHttpOrigin('data:text/plain,hello'), null);
  });
  it('returns null for a file: URL', () => {
    assert.equal(safeHttpOrigin('file:///etc/passwd'), null);
  });
  it('returns null for undefined', () => {
    assert.equal(safeHttpOrigin(undefined), null);
  });
  it('returns null for an empty string', () => {
    assert.equal(safeHttpOrigin(''), null);
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
