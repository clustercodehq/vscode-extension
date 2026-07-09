import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedExternalUrl } from '../../src/url-guard.ts';

describe('isAllowedExternalUrl', () => {
  it('accepts https URLs', () => {
    assert.equal(isAllowedExternalUrl('https://docs.clustercode.io'), true);
  });
  it('accepts http URLs', () => {
    assert.equal(isAllowedExternalUrl('http://localhost:3999/docs'), true);
  });
  it('normalizes the scheme case', () => {
    assert.equal(isAllowedExternalUrl('HTTPS://example.com'), true);
  });
  it('rejects the file scheme', () => {
    assert.equal(isAllowedExternalUrl('file:///etc/passwd'), false);
  });
  it('rejects the command scheme', () => {
    assert.equal(isAllowedExternalUrl('command:workbench.action.reloadWindow'), false);
  });
  it('rejects the javascript scheme', () => {
    assert.equal(isAllowedExternalUrl('javascript:alert(1)'), false);
  });
  it('rejects non-URL strings', () => {
    assert.equal(isAllowedExternalUrl('not a url'), false);
  });
  it('rejects the empty string', () => {
    assert.equal(isAllowedExternalUrl(''), false);
  });
});
