import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOpenPromptChoice } from '../../src/auth/openFlow.ts';

describe('resolveOpenPromptChoice', () => {
  it('maps "Sign In" to the signIn action', () => {
    assert.equal(resolveOpenPromptChoice('Sign In'), 'signIn');
  });

  it('maps "Open Without Signing In" to the openAnonymously action', () => {
    assert.equal(resolveOpenPromptChoice('Open Without Signing In'), 'openAnonymously');
  });

  it('maps a dismissed prompt (undefined) to none', () => {
    assert.equal(resolveOpenPromptChoice(undefined), 'none');
  });

  it('maps any unrecognized choice to none', () => {
    assert.equal(resolveOpenPromptChoice('Something Else'), 'none');
  });
});
