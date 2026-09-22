/**
 * One shape for every place a model is chosen: the composer, the provider card, the
 * add-provider dialog and the Defaults tab all offer the same list, the same search and
 * the same Recent group.
 */
import { useCallback, useState } from 'react';
import { useAuth } from '../auth/context.js';
import type { ComboboxOption } from '../ui/Combobox.js';
import type { Model } from '../types.js';
import { readRecentModels, rememberModel } from './recentModels.js';

const storage = () => (typeof localStorage === 'undefined' ? null : localStorage);

/** A catalogue model as the picker shows it: the alias reads, the id identifies. */
export function modelOption(model: Model, value: string): ComboboxOption {
  return {
    value,
    label: model.alias ?? model.model,
    detail: model.key,
    group: model.provider,
    ...(model.disabled ? { disabled: true } : {}),
  };
}

/** The recents of this workspace, and the way to add to them. */
export function useRecentModels(): {
  recent: string[];
  remember(value: string | null): void;
} {
  const { profile } = useAuth();
  const [recent, setRecent] = useState<string[]>(() => readRecentModels(storage(), profile));
  const remember = useCallback(
    (value: string | null) => setRecent(rememberModel(storage(), profile, value)),
    [profile],
  );
  return { recent, remember };
}
