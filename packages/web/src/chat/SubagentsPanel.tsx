/**
 * The Subagents panel of a conversation (contract decision §56; owner, 2026-09-25: «مثل كلود
 * يبين الوكلاء الفرعيين الي يشتغلون»). Above the composer, only once the agent has delegated:
 * each running subagent — nested ones under the one that started them — with its goal, model,
 * time, tool count and last tool; Stop, Steer and View where the agent allows them
 * (`SubagentList.support`); the finished ones folded into "Finished (n)".
 */
import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { describeError } from '../auth/client.js';
import { useI18n } from '../i18n/context.js';
import { useSubagentTail, useSubagents } from '../subagents/queries.js';
import { clock, elapsedMs, splitSubagents } from '../subagents/subagents.js';
import type { Subagent, SubagentSupport } from '../types.js';
import { Badge, Button, Input, Notice, Sheet } from '../ui/index.js';
import { IconAgents, IconChevron, IconSteer, IconStop } from '../ui/icons.js';

const STATUS_TONE = {
  running: 'info',
  completed: 'success',
  failed: 'danger',
  interrupted: 'warning',
} as const;

/** The clock of running rows ticks this often. */
const TICK_MS = 1000;

export function SubagentsPanel({
  sessionId,
  onOpenTrajectory,
}: {
  sessionId: string;
  /** Opens the conversation's Trajectory tab at this subagent's step. */
  onOpenTrajectory(stepId: string): void;
}) {
  const { t } = useI18n();
  const { query, stop, steer } = useSubagents(sessionId);
  const [open, setOpen] = useState(true);
  const [showFinished, setShowFinished] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [steering, setSteering] = useState<string | null>(null);
  const items = query.data?.items ?? [];
  const support: SubagentSupport = query.data?.support ?? 'none';
  const { running, finished } = splitSubagents(items);

  const [now, setNow] = useState(() => Date.now());
  const ticking = running.length > 0;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [ticking]);

  if (items.length === 0) return null;
  const full = support === 'full';
  const viewed = items.find((item) => item.id === viewing) ?? null;

  return (
    <section
      className="subagents"
      data-testid="subagents-panel"
      data-support={support}
      aria-label={t('subagents.title')}
    >
      <button
        type="button"
        className="subagents-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        data-testid="subagents-toggle"
      >
        <IconAgents size={16} />
        <span className="font-medium">{t('subagents.title')}</span>
        {running.length > 0 && (
          <Badge tone="info" dot testId="subagents-running-count">
            {t('subagents.running_count', { count: String(running.length) })}
          </Badge>
        )}
        <span className="flex-1" />
        <IconChevron size={14} className="subagents-chevron" data-open={open} />
      </button>
      {open && (
        <div className="subagents-body">
          {support === 'observe' && (
            <p className="subagents-note" data-testid="subagents-observe">
              {t('subagents.observe_note')}
            </p>
          )}
          {stop.isError && (
            <Notice tone="danger" className="mb-2" role="alert">
              {describeError(stop.error, t)}
            </Notice>
          )}
          {running.length > 0 && (
            <ul className="subagents-list" data-testid="subagents-running">
              {running.map(({ subagent, indent }) => (
                <li
                  key={subagent.id}
                  className="subagent-row"
                  data-testid="subagent-row"
                  data-subagent-id={subagent.id}
                  data-status={subagent.status}
                  style={{ '--indent': indent } as CSSProperties}
                >
                  <SubagentLine subagent={subagent} now={now} />
                  <div className="subagent-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setViewing(subagent.id)}
                      data-testid="subagent-view"
                    >
                      {t('subagents.view')}
                    </Button>
                    {full && subagent.accepting_steer && (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<IconSteer size={14} />}
                        aria-expanded={steering === subagent.id}
                        onClick={() =>
                          setSteering((current) => (current === subagent.id ? null : subagent.id))
                        }
                        data-testid="subagent-steer"
                      >
                        {t('subagents.steer')}
                      </Button>
                    )}
                    {full && (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<IconStop size={12} />}
                        loading={stop.isPending && stop.variables === subagent.id}
                        onClick={() => stop.mutate(subagent.id)}
                        data-testid="subagent-stop"
                      >
                        {t('subagents.stop')}
                      </Button>
                    )}
                  </div>
                  {steering === subagent.id && (
                    <SteerForm
                      pending={steer.isPending}
                      result={
                        steer.variables?.id === subagent.id
                          ? steer.isError
                            ? { error: steer.error }
                            : steer.data
                              ? { status: steer.data.status }
                              : null
                          : null
                      }
                      onSend={(text) => steer.mutate({ id: subagent.id, text })}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          {finished.length > 0 && (
            <div className="subagents-finished">
              <button
                type="button"
                className="subagents-finished-toggle"
                aria-expanded={showFinished}
                onClick={() => setShowFinished((value) => !value)}
                data-testid="subagents-finished-toggle"
              >
                <IconChevron size={12} className="subagents-chevron" data-open={showFinished} />
                {t('subagents.finished', { count: String(finished.length) })}
              </button>
              {showFinished && (
                <ul className="subagents-list" data-testid="subagents-finished">
                  {finished.map((subagent) => (
                    <li
                      key={subagent.id}
                      className="subagent-row"
                      data-testid="subagent-finished-row"
                      data-subagent-id={subagent.id}
                      data-status={subagent.status}
                    >
                      <SubagentLine subagent={subagent} now={now} />
                      <div className="subagent-actions">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setViewing(subagent.id)}
                          data-testid="subagent-view"
                        >
                          {t('subagents.view')}
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
      <SubagentSheet
        sessionId={sessionId}
        subagent={viewed}
        support={support}
        now={now}
        onClose={() => setViewing(null)}
        onOpenTrajectory={(stepId) => {
          setViewing(null);
          onOpenTrajectory(stepId);
        }}
      />
    </section>
  );
}

/** Goal, then model · time · tools · last tool, and the status. */
function SubagentLine({ subagent, now }: { subagent: Subagent; now: number }) {
  const { t } = useI18n();
  const ms = elapsedMs(subagent, now);
  const facts = [
    subagent.model,
    ms === null ? null : clock(ms),
    subagent.tool_count === null
      ? null
      : t('subagents.tools', { count: String(subagent.tool_count) }),
    subagent.last_tool ? t('subagents.last_tool', { tool: subagent.last_tool }) : null,
  ].filter((fact): fact is string => !!fact);
  return (
    <div className="subagent-line">
      <span className="subagent-goal" dir="auto" data-testid="subagent-goal">
        {subagent.goal || subagent.id}
      </span>
      <span className="subagent-facts">
        <Badge tone={STATUS_TONE[subagent.status]} dot={subagent.status === 'running'}>
          {t(`subagents.status.${subagent.status}`)}
        </Badge>
        {facts.map((fact) => (
          <span key={fact} dir="auto">
            {fact}
          </span>
        ))}
      </span>
    </div>
  );
}

function SteerForm({
  pending,
  result,
  onSend,
}: {
  pending: boolean;
  result: { status: 'queued' | 'rejected' } | { error: unknown } | null;
  onSend(text: string): void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    onSend(value);
    setText('');
  };
  return (
    <form className="subagent-steer" onSubmit={submit} data-testid="subagent-steer-form">
      <Input
        inputSize="sm"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={t('subagents.steer_placeholder')}
        aria-label={t('subagents.steer_placeholder')}
        maxLength={4000}
        dir="auto"
        data-testid="subagent-steer-input"
      />
      <Button
        type="submit"
        size="sm"
        loading={pending}
        disabled={text.trim() === ''}
        data-testid="subagent-steer-send"
      >
        {t('subagents.steer_send')}
      </Button>
      {result && (
        <p className="subagent-steer-result" role="status" data-testid="subagent-steer-result">
          {'error' in result
            ? describeError(result.error, t)
            : result.status === 'queued'
              ? t('subagents.steer_queued')
              : t('subagents.steer_rejected')}
        </p>
      )}
    </form>
  );
}

/** One subagent in full: what it was asked, where it is, its last words, its live output. */
function SubagentSheet({
  sessionId,
  subagent,
  support,
  now,
  onClose,
  onOpenTrajectory,
}: {
  sessionId: string;
  subagent: Subagent | null;
  support: SubagentSupport;
  now: number;
  onClose(): void;
  onOpenTrajectory(stepId: string): void;
}) {
  const { t } = useI18n();
  const running = subagent?.status === 'running';
  const tail = useSubagentTail(
    sessionId,
    subagent && support === 'full' && running ? subagent.id : null,
    running,
  );
  const ms = subagent ? elapsedMs(subagent, now) : null;
  return (
    <Sheet
      open={subagent !== null}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
      title={t('subagents.sheet_title')}
      closeLabel={t('subagents.close')}
      testId="subagent-sheet"
      footer={
        subagent && (
          <Button
            variant="secondary"
            onClick={() => onOpenTrajectory(`subagent:${subagent.id}`)}
            data-testid="subagent-open-trajectory"
          >
            {t('subagents.open_trajectory')}
          </Button>
        )
      }
    >
      {subagent && (
        <div className="subagent-sheet" data-subagent-id={subagent.id}>
          <p className="subagent-sheet-goal" dir="auto" data-testid="subagent-sheet-goal">
            {subagent.goal || subagent.id}
          </p>
          <dl className="subagent-sheet-facts">
            <div>
              <dt>{t('subagents.status_label')}</dt>
              <dd>
                <Badge tone={STATUS_TONE[subagent.status]} dot={running}>
                  {t(`subagents.status.${subagent.status}`)}
                </Badge>
              </dd>
            </div>
            {subagent.model && (
              <div>
                <dt>{t('subagents.model')}</dt>
                <dd dir="auto">{subagent.model}</dd>
              </div>
            )}
            {ms !== null && (
              <div>
                <dt>{t('subagents.elapsed')}</dt>
                <dd>{clock(ms)}</dd>
              </div>
            )}
            {subagent.tool_count !== null && (
              <div>
                <dt>{t('subagents.tool_count')}</dt>
                <dd>{subagent.tool_count}</dd>
              </div>
            )}
          </dl>
          {subagent.summary && (
            <section>
              <h3 className="subagent-sheet-heading">{t('subagents.summary')}</h3>
              <p className="subagent-sheet-text" dir="auto" data-testid="subagent-summary">
                {subagent.summary}
              </p>
            </section>
          )}
          {subagent.tools.length > 0 && (
            <section>
              <h3 className="subagent-sheet-heading">{t('subagents.recent_tools')}</h3>
              <ol className="subagent-sheet-tools">
                {subagent.tools.map((tool, index) => (
                  <li key={`${tool.at}-${index}`}>
                    <span className="font-medium" dir="ltr">
                      {tool.name}
                    </span>
                    {tool.preview && (
                      <span className="text-muted" dir="auto">
                        {' '}
                        {tool.preview}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          )}
          {support === 'full' && running && (
            <section>
              <h3 className="subagent-sheet-heading">{t('subagents.output')}</h3>
              {tail.data?.available ? (
                <>
                  {tail.data.truncated && (
                    <p className="text-xs text-muted">{t('subagents.output_truncated')}</p>
                  )}
                  <pre className="subagent-sheet-output" dir="auto" data-testid="subagent-output">
                    {tail.data.text}
                  </pre>
                </>
              ) : (
                <p className="text-sm text-muted" data-testid="subagent-no-output">
                  {t('subagents.no_output')}
                </p>
              )}
            </section>
          )}
        </div>
      )}
    </Sheet>
  );
}
