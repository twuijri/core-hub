// The composer has seven looks and exactly one of them at a time. Keeping the choice in a
// pure function means the states are unit-tested (tests/composer.test.tsx) instead of being
// an accident of how the JSX happens to nest, and `data-state` on the surface lets the CSS
// and the e2e journeys name the same thing the code does.
export const COMPOSER_STATES = [
  'disabled',
  'dragging',
  'streaming',
  'sending',
  'error',
  'typing',
  'empty',
] as const;
export type ComposerState = (typeof COMPOSER_STATES)[number];

export interface ComposerInput {
  /** The session cannot take a message at all (loading, deleted, no agent). */
  disabled: boolean;
  /** Files are over the drop zone. */
  dragging: boolean;
  /** A run is streaming: the send button is a stop button. */
  busy: boolean;
  /** The POST is in flight. */
  sending: boolean;
  /** The last attempt failed and the message is still on screen. */
  error: boolean;
  /** Text typed, or at least one attachment uploaded. */
  hasContent: boolean;
}

export function composerState(input: ComposerInput): ComposerState {
  if (input.disabled) return 'disabled';
  if (input.dragging) return 'dragging';
  if (input.busy) return 'streaming';
  if (input.sending) return 'sending';
  if (input.error) return 'error';
  return input.hasContent ? 'typing' : 'empty';
}

/** Sending is only possible with something to send, and never twice at once. */
export function canSend(input: ComposerInput): boolean {
  return !input.disabled && !input.sending && input.hasContent;
}
