/**
 * Our avatar, over Radix `Avatar`: a picture when there is one, the initial when there is
 * not, and never a broken image icon in between (Radix only swaps in the fallback once the
 * image has actually failed or after a short delay, so a fast image does not flash).
 *
 * The initial is taken with `Intl.Segmenter` where it exists, so an Arabic name yields its
 * first *grapheme* and an emoji avatar is not cut in half by a UTF-16 slice.
 */
import type { ReactNode } from 'react';
import { Avatar as RadixAvatar } from 'radix-ui';

export type AvatarSize = 'sm' | 'md' | 'lg';

/** The first grapheme of a name — one character a person would recognise, never half of one. */
export function initialOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const Segmenter = (
    Intl as unknown as {
      Segmenter?: new (
        l?: string,
        o?: { granularity: string },
      ) => { segment(s: string): Iterable<{ segment: string }> };
    }
  ).Segmenter;
  if (Segmenter) {
    for (const part of new Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed))
      return part.segment;
  }
  return [...trimmed][0] ?? '?';
}

export function Avatar({
  name,
  src,
  mark,
  size = 'md',
  tone = 'accent',
  testId,
}: {
  /** Also the accessible name of the image, and the source of the fallback initial. */
  name: string;
  src?: string | null;
  /** A drawn mark to stand in for the initial — an agent wears its own (`agentMark`). */
  mark?: ReactNode;
  size?: AvatarSize;
  tone?: 'accent' | 'neutral';
  testId?: string;
}) {
  return (
    <RadixAvatar.Root
      className={`ch-avatar ch-avatar-${size} ch-avatar-${tone}`}
      data-testid={testId}
    >
      {src ? <RadixAvatar.Image className="ch-avatar-img" src={src} alt={name} /> : null}
      <RadixAvatar.Fallback className="ch-avatar-fallback" delayMs={src ? 300 : 0}>
        {mark ?? <span aria-hidden>{initialOf(name)}</span>}
      </RadixAvatar.Fallback>
    </RadixAvatar.Root>
  );
}
