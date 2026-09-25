/**
 * «غيّر N ملفات (+a −b)» under the last reply of a run (decision §49): the files the run
 * changed in the conversation's folder, each with its added and removed lines, each opening
 * what the run did to it in the file panel beside the chat.
 *
 * The sentence follows the page's direction; the paths and the counts are code and stay
 * left-to-right inside it (`dir="ltr"` on each, isolated), so `+12 −3` never turns around in
 * Arabic.
 */
import { useState } from 'react';
import { useI18n } from '../i18n/context.js';
import { directionOf } from '../i18n/index.js';
import type { RunChanges, RunFileChange } from '../types.js';
import { pluralOf } from './changes.js';
import { useOpenDiff } from './context.js';

/** Files shown before "Show all": a card under a reply stays a glance. */
export const CARD_FILES = 5;

export function RunChangesCard({ changes }: { changes: RunChanges }) {
  const { t, language } = useI18n();
  const open = useOpenDiff();
  const [expanded, setExpanded] = useState(false);
  const count = changes.files_changed;
  const shown = expanded ? changes.files : changes.files.slice(0, CARD_FILES);
  const hidden = changes.files.length - shown.length;
  const unlisted = count - changes.files.length;
  return (
    <section
      className="run-changes"
      // The transcript row is fixed left-to-right (the sides are physical); the card's
      // words follow the page, and its paths and counts isolate themselves.
      dir={directionOf(language)}
      aria-label={t('changes.label')}
      data-testid="run-changes"
      data-run-id={changes.run_id}
    >
      <header className="run-changes-head">
        <span className="run-changes-title" data-testid="run-changes-title">
          {t(`changes.summary.${pluralOf(language, count)}`, { count })}
        </span>
        <Counts additions={changes.additions} deletions={changes.deletions} />
      </header>
      <ul className="run-changes-list">
        {shown.map((file) => (
          <li key={file.path}>
            <FileRow
              file={file}
              onOpen={open ? () => open(changes.run_id, file.path) : null}
              kindLabel={t(`changes.kind.${file.change}`)}
              openLabel={t('changes.open_diff', { name: file.path })}
              binaryLabel={t('changes.binary')}
            />
          </li>
        ))}
      </ul>
      {(hidden > 0 || expanded) && changes.files.length > CARD_FILES && (
        <button
          type="button"
          className="run-changes-more"
          onClick={() => setExpanded((on) => !on)}
          aria-expanded={expanded}
          data-testid="run-changes-more"
        >
          {expanded
            ? t('changes.show_less')
            : t('changes.show_all', { count: changes.files.length })}
        </button>
      )}
      {unlisted > 0 && (
        <p className="run-changes-note">{t('changes.unlisted', { count: unlisted })}</p>
      )}
      {!changes.complete && <p className="run-changes-note">{t('changes.incomplete')}</p>}
    </section>
  );
}

function FileRow({
  file,
  onOpen,
  kindLabel,
  openLabel,
  binaryLabel,
}: {
  file: RunFileChange;
  onOpen: (() => void) | null;
  kindLabel: string;
  openLabel: string;
  binaryLabel: string;
}) {
  const body = (
    <>
      <span className="run-change-kind" data-change={file.change}>
        {kindLabel}
      </span>
      <bdi className="run-change-path" dir="ltr">
        {file.old_path ? `${file.old_path} → ${file.path}` : file.path}
      </bdi>
      {file.binary ? (
        <span className="run-change-binary">{binaryLabel}</span>
      ) : (
        <Counts additions={file.additions} deletions={file.deletions} />
      )}
    </>
  );
  return onOpen ? (
    <button
      type="button"
      className="run-change"
      onClick={onOpen}
      aria-label={openLabel}
      data-testid="run-change-file"
      data-path={file.path}
    >
      {body}
    </button>
  ) : (
    <div className="run-change" data-testid="run-change-file" data-path={file.path}>
      {body}
    </div>
  );
}

/** `+a −b`, left to right in every language; nothing when the hub could not count. */
export function Counts({
  additions,
  deletions,
}: {
  additions: number | null;
  deletions: number | null;
}) {
  if (additions === null && deletions === null) return null;
  return (
    <span className="run-change-counts" dir="ltr" data-testid="run-change-counts">
      <span className="run-change-add">+{additions ?? 0}</span>
      <span className="run-change-del">−{deletions ?? 0}</span>
    </span>
  );
}
