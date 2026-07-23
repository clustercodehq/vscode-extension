/**
 * Pure, `vscode`-free decision logic for the "Open" command's signed-out
 * sign-in prompt, extracted so the choice-to-action mapping can be
 * unit-tested without the VS Code runtime (mirrors {@link ./deviceFlow}).
 */

export type OpenPromptAction = 'signIn' | 'openAnonymously' | 'none';

/**
 * Maps the user's response to the signed-out "Open" prompt to the action to
 * take next. Any choice other than the two known button labels — including
 * `undefined`, i.e. the prompt was dismissed without a choice — resolves to
 * `'none'` (do nothing).
 */
export function resolveOpenPromptChoice(choice: string | undefined): OpenPromptAction {
  if (choice === 'Sign In') return 'signIn';
  if (choice === 'Open Without Signing In') return 'openAnonymously';
  return 'none';
}
