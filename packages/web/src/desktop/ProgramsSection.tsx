/**
 * Programs on this computer (ADR 0025) — a part of This device, not a page of its own (owner,
 * 2026-09-26: «برامج هذا الجهاز ما يفتح صفحة جديدة، يكون كأنه سكشن داخل صفحة هذا الجهاز»).
 *
 * The MCP servers other assistants registered on this computer, each off until the person picks
 * the profiles it serves. A program whose registration needs a setting only the person has (an
 * API key) says so and takes it here; the app keeps it sealed. DaVinci Resolve's integration has
 * a readiness check with the steps that fix what is missing.
 */
import { useEffect, useState } from 'react';
import { useProfiles } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { Badge, Button, Checkbox, Input, Notice, type BadgeTone } from '../ui/index.js';
import type {
  DesktopBridge,
  DesktopProgram,
  DesktopProgramsState,
  DesktopResolveReadiness,
} from './bridge-types.js';
import { Fold } from './HelperSection.js';

/** Where people install Resolve's AI integration and Resolve itself. */
export const RESOLVE_SUPPORT =
  'https://www.blackmagicdesign.com/support/family/davinci-resolve-and-fusion';

const STATUS_TONE: Record<DesktopProgram['status'], BadgeTone> = {
  ready: 'success',
  needs_setup: 'warning',
  remote: 'neutral',
  invalid: 'danger',
};

function FieldRow({
  program,
  field,
  onSave,
}: {
  program: DesktopProgram;
  field: DesktopProgram['fields'][number];
  onSave(value: string | null): void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(field.value ?? '');
  const id = `program-${program.id}-${field.key}`;
  return (
    <div className="flex flex-col gap-1" data-testid={`program-field-${field.key}`}>
      <label htmlFor={id} className="text-sm">
        <span dir="auto">{field.title}</span>
        {field.required && <span className="text-muted"> *</span>}
      </label>
      {field.description && (
        <p className="text-xs text-muted" dir="auto">
          {field.description}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={id}
          dir="ltr"
          type={field.sensitive ? 'password' : 'text'}
          autoComplete="off"
          value={value}
          placeholder={field.set && field.sensitive ? t('programs.saved_secret') : ''}
          onChange={(event) => setValue(event.target.value)}
          className="max-w-md"
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={value.trim() === ''}
          onClick={() => {
            onSave(value);
            if (field.sensitive) setValue('');
          }}
        >
          {t('programs.save')}
        </Button>
        {field.set && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onSave(null);
              setValue('');
            }}
          >
            {t('programs.clear')}
          </Button>
        )}
      </div>
    </div>
  );
}

function ResolveReadiness({
  readiness,
  onCheck,
  busy,
}: {
  readiness: DesktopResolveReadiness | null;
  onCheck(): void;
  busy: boolean;
}) {
  const { t } = useI18n();
  return (
    <div
      className="ch-card ch-card-flat ch-card-pad-sm flex flex-col gap-2"
      data-testid="resolve-readiness"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{t('programs.resolve.title')}</span>
        {readiness && (
          <Badge tone={readiness.steps.length === 0 ? 'success' : 'warning'} dot>
            {t(
              readiness.steps.length === 0
                ? 'programs.resolve.ready'
                : 'programs.resolve.not_ready',
            )}
          </Badge>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={onCheck}
          data-testid="resolve-check"
        >
          {t('programs.resolve.check')}
        </Button>
      </div>
      {!readiness ? (
        <p className="text-xs text-muted">{t('programs.resolve.intro')}</p>
      ) : (
        <>
          <ul className="flex flex-col gap-1 text-sm">
            <li>
              {t('programs.resolve.integration')}:{' '}
              {t(`programs.resolve.integration_${readiness.integration}`)}
            </li>
            <li>
              {t('programs.resolve.running')}:{' '}
              {t(
                readiness.running === null
                  ? 'programs.resolve.unknown'
                  : readiness.running
                    ? 'programs.resolve.yes'
                    : 'programs.resolve.no',
              )}
            </li>
            <li>
              {t('programs.resolve.scripting')}:{' '}
              {t(`programs.resolve.scripting_${readiness.scripting}`)}
            </li>
            {readiness.product && (
              <li>
                {t('programs.resolve.edition')}:{' '}
                <span dir="ltr">
                  {readiness.product} {readiness.version ?? ''}
                </span>
              </li>
            )}
          </ul>
          {readiness.steps.length > 0 && (
            <ol
              className="flex list-decimal flex-col gap-1 ps-5 text-sm"
              data-testid="resolve-steps"
            >
              {readiness.steps.map((step) => (
                <li key={step} data-step={step}>
                  {t(`programs.resolve.step_${step}`)}
                </li>
              ))}
            </ol>
          )}
          {readiness.steps.includes('install_integration') && (
            <a
              className="text-sm text-link"
              href={RESOLVE_SUPPORT}
              target="_blank"
              rel="noreferrer"
            >
              {t('programs.resolve.support')}
            </a>
          )}
        </>
      )}
    </div>
  );
}

export function ProgramsSection({ bridge }: { bridge: DesktopBridge }) {
  const { t } = useI18n();
  const profiles = useProfiles();
  const [state, setState] = useState<DesktopProgramsState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    bridge.programs
      .get()
      .then((next) => live && setState(next))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [bridge]);

  const apply = (next: Promise<DesktopProgramsState>) => {
    setBusy(true);
    void next.then(setState).finally(() => setBusy(false));
  };
  if (!state) return null;
  const on = state.programs.filter((p) => p.profiles.length > 0).length;
  const showResolve = state.programs.some((p) => p.resolve) || state.resolve !== null;
  const all = profiles.data ?? [];

  return (
    <Fold
      title={t('programs.title')}
      badge={
        state.programs.length > 0 ? (
          <Badge tone={on > 0 ? 'accent' : 'neutral'}>
            {t('programs.count', { on: String(on), all: String(state.programs.length) })}
          </Badge>
        ) : undefined
      }
      testId="programs"
    >
      <p className="text-sm text-muted">{t('programs.intro')}</p>
      <div>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => apply(bridge.programs.rescan())}
          data-testid="programs-rescan"
        >
          {t('programs.rescan')}
        </Button>
      </div>
      {state.programs.length === 0 ? (
        <p className="text-sm text-muted" data-testid="programs-empty">
          {t('programs.empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="programs-list">
          {state.programs.map((program) => (
            <li key={program.id} data-program={program.id}>
              <Fold
                title={program.name}
                badge={
                  <>
                    <Badge tone="neutral">{t(`programs.source.${program.source}`)}</Badge>
                    <Badge
                      tone={STATUS_TONE[program.status]}
                      dot
                      testId={`program-status-${program.id}`}
                    >
                      {t(`programs.status.${program.status}`)}
                    </Badge>
                    {program.profiles.length > 0 && (
                      <Badge tone="accent">
                        {t('programs.on_for', { count: String(program.profiles.length) })}
                      </Badge>
                    )}
                  </>
                }
                testId={`program-${program.id}`}
              >
                {program.description && (
                  <p className="text-sm" dir="auto">
                    {program.description}
                  </p>
                )}
                <p className="text-xs text-muted">
                  {t('programs.found_in')}{' '}
                  <span dir="ltr" className="font-mono break-all">
                    {program.origin}
                  </span>
                </p>
                {program.status === 'remote' && <Notice>{t('programs.remote_note')}</Notice>}
                {program.status === 'invalid' && (
                  <Notice tone="warning">{t('programs.invalid_note')}</Notice>
                )}
                {program.fields.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <h4 className="text-sm font-semibold">{t('programs.settings')}</h4>
                    {program.status === 'needs_setup' && (
                      <p className="text-xs text-muted">{t('programs.needs_setup_hint')}</p>
                    )}
                    {program.fields.map((field) => (
                      <FieldRow
                        key={field.key}
                        program={program}
                        field={field}
                        onSave={(value) =>
                          apply(bridge.programs.setField(program.id, field.key, value))
                        }
                      />
                    ))}
                  </div>
                )}
                {program.status === 'ready' && (
                  <div className="flex flex-col gap-1">
                    <h4 className="text-sm font-semibold">{t('programs.profiles')}</h4>
                    <p className="text-xs text-muted">{t('programs.profiles_hint')}</p>
                    <ul
                      className="flex flex-col gap-1"
                      data-testid={`program-profiles-${program.id}`}
                    >
                      {all.map((profile) => (
                        <li key={profile.slug}>
                          <Checkbox
                            checked={program.profiles.includes(profile.slug)}
                            label={profile.name}
                            disabled={busy}
                            testId={`program-${program.id}-profile-${profile.slug}`}
                            onChange={(checked) =>
                              apply(
                                bridge.programs.setProfiles(
                                  program.id,
                                  checked
                                    ? [...new Set([...program.profiles, profile.slug])]
                                    : program.profiles.filter((slug) => slug !== profile.slug),
                                ),
                              )
                            }
                          />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {program.error && (
                  <Notice tone="danger">{t('programs.failed', { message: program.error })}</Notice>
                )}
                {program.tools.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <h4 className="text-sm font-semibold">{t('programs.tools')}</h4>
                    <ul
                      className="flex flex-col gap-1 text-sm"
                      data-testid={`program-tools-${program.id}`}
                    >
                      {program.tools.map((tool) => (
                        <li key={tool.name}>
                          <span dir="ltr" className="font-mono text-xs">
                            {tool.name}
                          </span>{' '}
                          <span className="text-muted" dir="auto">
                            {tool.description}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Fold>
            </li>
          ))}
        </ul>
      )}
      {showResolve || state.programs.length === 0 ? (
        <ResolveReadiness
          readiness={state.resolve}
          busy={busy}
          onCheck={() => apply(bridge.programs.checkResolve())}
        />
      ) : null}
      <p className="text-xs text-muted">{t('programs.consent_note')}</p>
    </Fold>
  );
}
