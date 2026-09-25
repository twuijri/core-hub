/**
 * «ربط منصة» / "Link a platform": every platform the agent's Hermes can answer on, in one
 * searchable list, instead of a long catalog under the linked channels (the owner, 2026-09-25).
 *
 * - The widely used platforms come first, in a fixed order; the rest follow alphabetically in the
 *   reader's language (a platform with an Arabic name sorts by it in Arabic).
 * - The search matches the platform's name in either language, its own name and Hermes's key, so
 *   "telegram" and «تيليجرام» both find it, whatever the interface language.
 * - Each row carries what the platform needs before it can work, as small badges: a library
 *   downloaded on first start, an address the internet can reach, a program the image lacks.
 * - A platform already linked in this profile is marked and cannot be picked twice.
 *
 * Picking one hands it back; the page opens that platform's own form.
 */
import { useMemo, useState } from 'react';
import { useI18n } from '../i18n/context.js';
import { LANGUAGES, createTranslator } from '../i18n/index.js';
import { Badge, Dialog, Input } from '../ui/index.js';
import { IconSearch } from '../ui/icons.js';
import type { ChannelPlatform } from './skills.js';
import { platformName } from './toolErrors.js';

/** The platforms people reach for first, in this order. */
export const POPULAR_PLATFORMS: readonly string[] = [
  'telegram',
  'whatsapp',
  'discord',
  'slack',
  'email',
  'teams',
  'google_chat',
  'signal',
];

type T = (key: string, values?: Record<string, string | number>) => string;

/** Lower case, without Arabic diacritics or tatweel, so a search is forgiving. */
function fold(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[\u0622\u0623\u0625]/g, '\u0627')
    .replace(/_/g, ' ');
}

/** Both languages' names are searched, whichever one the page is in. */
const TRANSLATORS = Object.fromEntries(
  LANGUAGES.map((each) => [each, createTranslator(each)]),
) as Record<(typeof LANGUAGES)[number], T>;

export interface PickerGroups {
  popular: ChannelPlatform[];
  more: ChannelPlatform[];
}

/**
 * The platforms split into the popular ones (fixed order) and the rest (alphabetical in
 * `language`), both narrowed to what `query` matches.
 */
export function pickerGroups(
  platforms: readonly ChannelPlatform[],
  query: string,
  t: T,
  language: string,
): PickerGroups {
  const needle = fold(query.trim());
  const matches = (spec: ChannelPlatform) =>
    needle === '' ||
    [
      ...LANGUAGES.map((each) => platformName(spec.platform, TRANSLATORS[each], spec.label)),
      spec.label,
      spec.platform,
    ].some((text) => fold(text).includes(needle));
  const shown = platforms.filter(matches);
  const popular = POPULAR_PLATFORMS.map((platform) =>
    shown.find((spec) => spec.platform === platform),
  ).filter((spec): spec is ChannelPlatform => spec !== undefined);
  const collator = new Intl.Collator(language, { sensitivity: 'base' });
  const more = shown
    .filter((spec) => !POPULAR_PLATFORMS.includes(spec.platform))
    .sort((a, b) =>
      collator.compare(platformName(a.platform, t, a.label), platformName(b.platform, t, b.label)),
    );
  return { popular, more };
}

export function ChannelPlatformPicker({
  platforms,
  linked,
  onPick,
  onClose,
}: {
  platforms: readonly ChannelPlatform[];
  /** Platforms already linked in this profile. */
  linked: ReadonlySet<string>;
  onPick: (spec: ChannelPlatform) => void;
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const [query, setQuery] = useState('');
  const groups = useMemo(
    () => pickerGroups(platforms, query, t, language),
    [platforms, query, t, language],
  );
  const empty = groups.popular.length === 0 && groups.more.length === 0;

  const option = (spec: ChannelPlatform) => {
    const name = platformName(spec.platform, t, spec.label);
    const done = linked.has(spec.platform);
    return (
      <li key={spec.platform} className="skill-row" data-enabled={done ? undefined : true}>
        <button
          type="button"
          className="skill-open"
          disabled={done}
          aria-disabled={done || undefined}
          data-testid={`platform-option-${spec.platform}`}
          onClick={() => onPick(spec)}
        >
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium" dir="auto">
              {name}
            </span>
            {done && (
              <Badge tone="success" testId={`platform-option-linked-${spec.platform}`}>
                {t('channels.linked')}
              </Badge>
            )}
            {spec.packages === 'first_use' && (
              <Badge>{t('channels.platform.badge_first_use')}</Badge>
            )}
            {spec.inbound && <Badge tone="warning">{t('channels.platform.badge_inbound')}</Badge>}
            {spec.program && (
              <Badge tone="warning">
                {t('channels.platform.badge_program', { program: spec.program })}
              </Badge>
            )}
          </span>
        </button>
      </li>
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('channels.picker.title')}
      description={t('channels.picker.intro')}
      closeLabel={t('common.cancel')}
      testId="platform-picker"
    >
      <div className="flex flex-col gap-3">
        {/* The search stays in view while the list scrolls under it. */}
        <div className="sticky top-0 z-10 bg-surface px-0.5 pt-0.5 pb-1">
          <Input
            type="search"
            inputSize="sm"
            icon={<IconSearch size={14} />}
            placeholder={t('channels.picker.search')}
            aria-label={t('channels.picker.search')}
            autoFocus
            value={query}
            data-testid="platform-picker-search"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {groups.popular.length > 0 && (
          <section className="flex flex-col gap-2" data-testid="platform-picker-popular">
            <h3 className="text-sm font-semibold text-muted">{t('channels.picker.popular')}</h3>
            <ul className="flex flex-col gap-2">{groups.popular.map(option)}</ul>
          </section>
        )}
        {groups.more.length > 0 && (
          <section className="flex flex-col gap-2" data-testid="platform-picker-more">
            <h3 className="text-sm font-semibold text-muted">{t('channels.picker.more')}</h3>
            <ul className="flex flex-col gap-2">{groups.more.map(option)}</ul>
          </section>
        )}
        {empty && (
          <p className="text-sm text-muted" data-testid="platform-picker-none" dir="auto">
            {t('channels.picker.none', { query: query.trim() })}
          </p>
        )}
      </div>
    </Dialog>
  );
}
