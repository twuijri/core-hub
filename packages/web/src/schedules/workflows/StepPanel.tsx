/**
 * The side panel: the selected step's form while editing, the selected connection's route,
 * or — on a run — what the step did.
 *
 * Each form offers exactly what the engine does with the step (`workflow-engine.ts` on the
 * hub): an agent step's agent, its own model and its prompt; a condition's one comparison
 * from the operators the engine reads; a delay in seconds up to an hour; a notice's words,
 * which reach the inbox of whoever runs it; an approval's question, answered by anyone who
 * answers approvals in the profile, with no time limit. Where the engine has no such thing
 * (a notice's recipients, an approval's timeout, attachments), the form says so instead of
 * offering a control that would do nothing.
 */
import { useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../i18n/context.js';
import {
  Badge,
  Button,
  Field,
  Input,
  Menu,
  MenuItem,
  MenuNote,
  Notice,
  Select,
  Switch,
  Textarea,
  type BadgeTone,
} from '../../ui/index.js';
import { Combobox } from '../../ui/Combobox.js';
import { chatModels } from '../../models/queries.js';
import { modelOption } from '../../models/useModelPicker.js';
import type { Agent, Model } from '../../types.js';
import {
  MAX_DELAY_SECONDS,
  OPERATORS,
  UNARY,
  insertAt,
  joinCondition,
  splitCondition,
  upstreamOf,
  type Action,
  type Draft,
  type NodeRunState,
  type Operator,
  type Route,
  type RunStep,
  type WfEdge,
  type WfNode,
  type WorkflowIssue,
} from './model.js';

const OPERATOR_KEY: Record<Operator, string> = {
  '==': 'eq',
  '!=': 'ne',
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
  contains: 'contains',
  matches: 'matches',
  exists: 'exists',
  empty: 'empty',
};

const STATE_TONE: Record<NodeRunState, BadgeTone> = {
  idle: 'neutral',
  waiting: 'warning',
  running: 'info',
  done: 'success',
  failed: 'danger',
  skipped: 'neutral',
};

type Translate = ReturnType<typeof useI18n>['t'];

/** A finding in the person's language; a code this client does not know, in the hub's words. */
export function describeIssue(issue: WorkflowIssue, t: Translate): string {
  const key = `workflows.issues.${issue.code}`;
  const text = t(key, { detail: issue.detail ?? '' });
  return text === key ? issue.message : text;
}

export function IssueList({
  issues,
  problems,
  t,
  onPick,
}: {
  issues: readonly WorkflowIssue[];
  problems: readonly WorkflowIssue[];
  t: Translate;
  onPick?: (issue: WorkflowIssue) => void;
}) {
  if (issues.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1" data-testid="workflow-issues">
      {issues.map((issue, index) => {
        const bad = problems.includes(issue);
        const text = describeIssue(issue, t);
        return (
          <li
            key={`${issue.code}-${issue.node_id ?? issue.edge_id ?? ''}-${index}`}
            className={`rounded-md px-2 py-1 text-xs ${bad ? 'bg-danger-soft text-danger-soft-text' : 'bg-warning-soft text-warning-soft-text'}`}
            data-testid="workflow-issue"
            data-code={issue.code}
            data-severity={bad ? 'problem' : 'warning'}
          >
            {onPick && (issue.node_id || issue.edge_id) ? (
              <button
                type="button"
                className="text-start underline-offset-2 hover:underline"
                onClick={() => onPick(issue)}
              >
                {text}
              </button>
            ) : (
              text
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function StepPanel({
  draft,
  node,
  edge,
  dispatch,
  agents,
  models,
  issues,
  problems,
  onRunFrom,
  runFromBusy,
}: {
  draft: Draft;
  node: WfNode | null;
  edge: WfEdge | null;
  dispatch: (action: Action) => void;
  agents: readonly Agent[];
  models: readonly Model[];
  issues: readonly WorkflowIssue[];
  problems: readonly WorkflowIssue[];
  onRunFrom: (nodeId: string) => void;
  runFromBusy: boolean;
}) {
  const { t } = useI18n();
  if (edge)
    return (
      <EdgeForm draft={draft} edge={edge} dispatch={dispatch} issues={issues} problems={problems} />
    );
  if (!node) {
    return (
      <p className="text-sm text-muted" data-testid="workflow-panel-empty">
        {t('workflows.editor.no_selection')}
      </p>
    );
  }
  const update = (patch: Partial<Omit<WfNode, 'id' | 'kind'>>) =>
    dispatch({ type: 'update', id: node.id, patch });

  return (
    <div className="flex flex-col gap-3" data-testid="workflow-panel" data-node-id={node.id}>
      <div className="flex items-center gap-2">
        <Badge tone="accent">{t(`workflows.kinds.${node.kind}`)}</Badge>
        <span className="text-xs text-muted">{t(`workflows.kind_hints.${node.kind}`)}</span>
      </div>
      <IssueList issues={issues} problems={problems} t={t} />
      <Field label={t('workflows.form.title')}>
        {(props) => (
          <Input
            {...props}
            value={node.title}
            onChange={(event) => update({ title: event.target.value })}
            dir="auto"
            data-testid="workflow-step-title"
          />
        )}
      </Field>
      <p className="text-xs text-muted">
        {t('workflows.form.id')}: <code dir="ltr">{node.id}</code> —{' '}
        {t('workflows.form.id_hint', { path: `{{steps.${node.id}.output}}` })}
      </p>

      {node.kind === 'agent' && (
        <AgentForm draft={draft} node={node} update={update} agents={agents} models={models} />
      )}
      {node.kind === 'condition' && <ConditionForm draft={draft} node={node} update={update} />}
      {node.kind === 'delay' && <DelayForm node={node} update={update} />}
      {node.kind === 'notify' && (
        <>
          <TemplateField
            draft={draft}
            node={node}
            label={t('workflows.form.notify_text')}
            update={update}
            testId="workflow-step-text"
          />
          <p className="text-xs text-muted">{t('workflows.form.notify_to')}</p>
        </>
      )}
      {node.kind === 'approval' && (
        <>
          <TemplateField
            draft={draft}
            node={node}
            label={t('workflows.form.approval_question')}
            update={update}
            testId="workflow-step-question"
          />
          <p className="text-xs text-muted">{t('workflows.form.approval_who')}</p>
          <p className="text-xs text-muted">{t('workflows.form.approval_timeout')}</p>
        </>
      )}
      {node.kind !== 'approval' && (
        <Switch
          checked={node.approval_required}
          onChange={(next) => update({ approval_required: next })}
          label={t('workflows.form.approval_required')}
          testId="workflow-step-gate"
        />
      )}

      <Connections draft={draft} node={node} dispatch={dispatch} />

      <div className="flex flex-wrap gap-2 border-t border-line pt-3">
        <Button
          size="sm"
          variant="secondary"
          loading={runFromBusy}
          onClick={() => onRunFrom(node.id)}
          data-testid="workflow-run-from"
        >
          {t('workflows.editor.run_from_here')}
        </Button>
        <Button
          size="sm"
          variant="danger-quiet"
          className="ms-auto"
          onClick={() => dispatch({ type: 'remove_node', id: node.id })}
          data-testid="workflow-step-delete"
        >
          {t('workflows.editor.delete_step')}
        </Button>
      </div>
    </div>
  );
}

function AgentForm({
  draft,
  node,
  update,
  agents,
  models,
}: {
  draft: Draft;
  node: WfNode;
  update: (patch: Partial<WfNode>) => void;
  agents: readonly Agent[];
  models: readonly Model[];
}) {
  const { t } = useI18n();
  const modelOptions = chatModels(models)
    .filter((model) => model.visible && !model.disabled)
    .map((model) => modelOption(model, model.key));
  return (
    <>
      <Field label={t('workflows.form.agent')}>
        {() => (
          <Select
            value={node.agent_id}
            onValueChange={(value) => update({ agent_id: value })}
            options={agents.map((agent) => ({ value: agent.id, label: agent.name }))}
            label={t('workflows.form.agent')}
            placeholder={t('workflows.form.agent_none')}
            testId="workflow-step-agent"
          />
        )}
      </Field>
      <Field label={t('workflows.form.model')}>
        {() => (
          <Combobox
            value={node.model}
            onChange={(value) => update({ model: value, provider: null })}
            options={modelOptions}
            label={t('workflows.form.model')}
            placeholder={t('workflows.form.model_default')}
            testId="workflow-step-model"
          />
        )}
      </Field>
      <TemplateField
        draft={draft}
        node={node}
        label={t('workflows.form.prompt')}
        update={update}
        testId="workflow-step-prompt"
        rows={5}
      />
      <p className="text-xs text-muted">{t('workflows.form.attachments_note')}</p>
    </>
  );
}

/** A text the engine renders, with the values a step can read offered for insertion. */
function TemplateField({
  draft,
  node,
  label,
  update,
  testId,
  rows = 3,
}: {
  draft: Draft;
  node: WfNode;
  label: string;
  update: (patch: Partial<WfNode>) => void;
  testId: string;
  rows?: number;
}) {
  const { t } = useI18n();
  const area = useRef<HTMLTextAreaElement | null>(null);
  const earlier = upstreamOf(draft, node.id);
  const insert = (text: string) => {
    const element = area.current;
    const next = insertAt(
      node.input ?? '',
      text,
      element?.selectionStart ?? null,
      element?.selectionEnd ?? null,
    );
    update({ input: next.value });
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(next.caret, next.caret);
    });
  };
  return (
    <Field label={label}>
      {(props) => (
        <div className="flex flex-col gap-1.5">
          <Textarea
            {...props}
            ref={area}
            rows={rows}
            value={node.input ?? ''}
            onChange={(event) => update({ input: event.target.value })}
            dir="auto"
            data-testid={testId}
          />
          <Menu
            trigger={
              <Button
                size="sm"
                variant="ghost"
                className="self-start"
                data-testid="workflow-insert"
              >
                {t('workflows.form.insert')}
              </Button>
            }
            testId="workflow-insert-menu"
          >
            <MenuItem onSelect={() => insert('{{input}}')}>
              {t('workflows.form.insert_input')} <code dir="ltr">{'{{input}}'}</code>
            </MenuItem>
            {earlier.map((step) => (
              <MenuItem key={step.id} onSelect={() => insert(`{{steps.${step.id}.output}}`)}>
                {t('workflows.form.insert_step', { name: step.title || step.id })}
              </MenuItem>
            ))}
            {earlier.length === 0 && <MenuNote>{t('workflows.form.insert_none')}</MenuNote>}
          </Menu>
        </div>
      )}
    </Field>
  );
}

function ConditionForm({
  draft,
  node,
  update,
}: {
  draft: Draft;
  node: WfNode;
  update: (patch: Partial<WfNode>) => void;
}) {
  const { t } = useI18n();
  const parts = splitCondition(node.input ?? '');
  const [raw, setRaw] = useState(parts === null);
  const earlier = upstreamOf(draft, node.id);
  if (raw || !parts) {
    return (
      <>
        <Field
          label={t('workflows.form.condition_text')}
          hint={t('workflows.form.condition_raw_hint')}
        >
          {(props) => (
            <Input
              {...props}
              value={node.input ?? ''}
              onChange={(event) => {
                update({ input: event.target.value });
                if (splitCondition(event.target.value)) setRaw(false);
              }}
              dir="ltr"
              data-testid="workflow-condition-text"
            />
          )}
        </Field>
        <p className="text-xs text-muted">{t('workflows.form.condition_routes_hint')}</p>
      </>
    );
  }
  const set = (patch: Partial<typeof parts>) =>
    update({ input: joinCondition({ ...parts, ...patch }) });
  const suggestions = ['input', ...earlier.map((step) => `steps.${step.id}.output`)];
  return (
    <>
      <Field
        label={t('workflows.form.condition_path')}
        hint={t('workflows.form.condition_path_hint')}
      >
        {(props) => (
          <>
            <Input
              {...props}
              value={parts.path}
              onChange={(event) => set({ path: event.target.value })}
              dir="ltr"
              data-testid="workflow-condition-path"
            />
            <span className="flex flex-wrap gap-1">
              {suggestions.map((path) => (
                <Button
                  key={path}
                  size="sm"
                  variant="subtle"
                  onClick={() => set({ path })}
                  data-testid="workflow-condition-suggestion"
                >
                  <code dir="ltr">{path}</code>
                </Button>
              ))}
            </span>
          </>
        )}
      </Field>
      <Field label={t('workflows.form.condition_operator')}>
        {() => (
          <Select
            value={parts.operator}
            onValueChange={(value) => set({ operator: (value ?? '==') as Operator })}
            options={OPERATORS.map((operator) => ({
              value: operator,
              label: t(`workflows.form.operators.${OPERATOR_KEY[operator]}`),
            }))}
            label={t('workflows.form.condition_operator')}
            testId="workflow-condition-operator"
          />
        )}
      </Field>
      {!UNARY.has(parts.operator) && (
        <Field label={t('workflows.form.condition_value')}>
          {(props) => (
            <Input
              {...props}
              value={parts.value}
              onChange={(event) => set({ value: event.target.value })}
              dir="auto"
              data-testid="workflow-condition-value"
            />
          )}
        </Field>
      )}
      <p className="text-xs text-muted">
        <code dir="ltr">{node.input}</code> — {t('workflows.form.condition_routes_hint')}
      </p>
    </>
  );
}

function DelayForm({ node, update }: { node: WfNode; update: (patch: Partial<WfNode>) => void }) {
  const { t } = useI18n();
  const text = (node.input ?? '').trim();
  const templated = /\{\{/.test(text);
  const seconds = Number(text);
  const [unit, setUnit] = useState<'seconds' | 'minutes'>(
    Number.isFinite(seconds) && seconds >= 60 && seconds % 60 === 0 ? 'minutes' : 'seconds',
  );
  if (templated) {
    return (
      <Field
        label={t('workflows.form.delay_amount')}
        hint={t('workflows.form.delay_template', { value: text })}
      >
        {(props) => (
          <Input
            {...props}
            value={node.input ?? ''}
            onChange={(event) => update({ input: event.target.value })}
            dir="ltr"
            data-testid="workflow-delay-text"
          />
        )}
      </Field>
    );
  }
  const shown = Number.isFinite(seconds) ? (unit === 'minutes' ? seconds / 60 : seconds) : '';
  const factor = unit === 'minutes' ? 60 : 1;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <Field label={t('workflows.form.delay_amount')} className="flex-1">
          {(props) => (
            <Input
              {...props}
              type="number"
              min={0}
              max={MAX_DELAY_SECONDS / factor}
              value={String(shown)}
              onChange={(event) => {
                const value = event.target.value;
                update({ input: value === '' ? '' : String(Math.round(Number(value) * factor)) });
              }}
              dir="ltr"
              data-testid="workflow-delay-amount"
            />
          )}
        </Field>
        <Field label={t('workflows.form.delay_unit')} className="w-32">
          {() => (
            <Select
              value={unit}
              onValueChange={(value) => setUnit(value === 'minutes' ? 'minutes' : 'seconds')}
              options={[
                { value: 'seconds', label: t('workflows.form.seconds') },
                { value: 'minutes', label: t('workflows.form.minutes') },
              ]}
              label={t('workflows.form.delay_unit')}
              testId="workflow-delay-unit"
            />
          )}
        </Field>
      </div>
      <p className="text-xs text-muted">{t('workflows.form.delay_hint')}</p>
    </div>
  );
}

/** The step's outgoing connections, and a way to add one without a pointer. */
function Connections({
  draft,
  node,
  dispatch,
}: {
  draft: Draft;
  node: WfNode;
  dispatch: (action: Action) => void;
}) {
  const { t } = useI18n();
  const others = draft.nodes.filter((other) => other.id !== node.id);
  const [target, setTarget] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>('success');
  const outgoing = draft.edges.filter((edge) => edge.from === node.id);
  const nameOf = (id: string) => {
    const found = draft.nodes.find((other) => other.id === id);
    return found?.title || id;
  };
  const routeName = (value: Route) =>
    node.kind === 'condition'
      ? t(`workflows.condition_routes.${value}`)
      : t(`workflows.routes.${value}`);
  const chosen = target && others.some((other) => other.id === target) ? target : null;
  return (
    <fieldset className="flex flex-col gap-2 rounded-md border border-line p-2">
      <legend className="px-1 text-xs font-medium">{t('workflows.editor.connections')}</legend>
      {outgoing.length === 0 ? (
        <p className="text-xs text-muted">{t('workflows.editor.no_connections')}</p>
      ) : (
        <ul className="flex flex-col gap-1" data-testid="workflow-connections">
          {outgoing.map((edge) => (
            <li key={edge.id} className="flex items-center gap-2 text-xs">
              <span dir="auto" className="truncate">
                {nameOf(edge.to)}
              </span>
              <Badge
                tone={
                  edge.route === 'failure'
                    ? 'danger'
                    : edge.route === 'success'
                      ? 'success'
                      : 'neutral'
                }
              >
                {routeName(edge.route)}
              </Badge>
              <Button
                size="sm"
                variant="ghost"
                className="ms-auto"
                onClick={() => dispatch({ type: 'remove_edge', id: edge.id })}
                aria-label={`${t('workflows.editor.delete_edge')}: ${nameOf(edge.to)}`}
              >
                ✕
              </Button>
            </li>
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-32 flex-1">
            <Select
              value={chosen}
              onValueChange={setTarget}
              options={others.map((other) => ({ value: other.id, label: other.title || other.id }))}
              label={t('workflows.editor.connect_target')}
              placeholder={t('workflows.editor.connect_target')}
              testId="workflow-connect-target"
            />
          </div>
          <div className="w-32">
            <Select
              value={route}
              onValueChange={(value) => setRoute((value ?? 'success') as Route)}
              options={(['success', 'failure', 'always'] as const).map((value) => ({
                value,
                label: routeName(value),
              }))}
              label={t('workflows.editor.connect_route')}
              testId="workflow-connect-route"
            />
          </div>
          <Button
            size="sm"
            disabled={!chosen}
            onClick={() => {
              if (chosen) dispatch({ type: 'connect', from: node.id, to: chosen, route });
              setTarget(null);
            }}
            data-testid="workflow-connect"
          >
            {t('workflows.editor.connect_add')}
          </Button>
        </div>
      )}
    </fieldset>
  );
}

function EdgeForm({
  draft,
  edge,
  dispatch,
  issues,
  problems,
}: {
  draft: Draft;
  edge: WfEdge;
  dispatch: (action: Action) => void;
  issues: readonly WorkflowIssue[];
  problems: readonly WorkflowIssue[];
}) {
  const { t } = useI18n();
  const from = draft.nodes.find((node) => node.id === edge.from);
  const to = draft.nodes.find((node) => node.id === edge.to);
  const routeName = (value: Route) =>
    from?.kind === 'condition'
      ? t(`workflows.condition_routes.${value}`)
      : t(`workflows.routes.${value}`);
  return (
    <div className="flex flex-col gap-3" data-testid="workflow-edge-panel" data-edge-id={edge.id}>
      <p className="text-sm font-medium">{t('workflows.editor.edge_title')}</p>
      <p className="text-sm" dir="auto">
        {t('workflows.editor.edge_label', {
          from: from?.title || edge.from,
          to: to?.title || edge.to,
          route: routeName(edge.route),
        })}
      </p>
      <IssueList issues={issues} problems={problems} t={t} />
      <Field label={t('workflows.editor.connect_route')}>
        {() => (
          <Select
            value={edge.route}
            onValueChange={(value) =>
              dispatch({ type: 'set_route', id: edge.id, route: (value ?? 'success') as Route })
            }
            options={(['success', 'failure', 'always'] as const).map((value) => ({
              value,
              label: routeName(value),
            }))}
            label={t('workflows.editor.connect_route')}
            testId="workflow-edge-route"
          />
        )}
      </Field>
      <Button
        size="sm"
        variant="danger-quiet"
        className="self-start"
        onClick={() => dispatch({ type: 'remove_edge', id: edge.id })}
        data-testid="workflow-edge-delete"
      >
        {t('workflows.editor.delete_edge')}
      </Button>
    </div>
  );
}

/** On a run: what the selected step did. */
export function StepRunPanel({
  node,
  step,
  state,
  gate,
  onRerunFrom,
  rerunBusy,
}: {
  node: WfNode | null;
  step: RunStep | null;
  state: NodeRunState | null;
  /** The approval gate of a step waiting for a person. */
  gate: ReactNode;
  onRerunFrom: ((nodeId: string) => void) | null;
  rerunBusy: boolean;
}) {
  const { t } = useI18n();
  if (!node) {
    return <p className="text-sm text-muted">{t('workflows.editor.no_selection')}</p>;
  }
  const output = step?.output ?? null;
  const long = (output?.length ?? 0) > 280 || (output ?? '').split('\n').length > 6;
  return (
    <div className="flex flex-col gap-3" data-testid="workflow-step-run" data-node-id={node.id}>
      <div className="flex items-center gap-2">
        <Badge tone="accent">{t(`workflows.kinds.${node.kind}`)}</Badge>
        <span className="truncate text-sm font-medium" dir="auto">
          {node.title || node.id}
        </span>
        {state && (
          <Badge tone={STATE_TONE[state]} dot testId="workflow-step-run-state">
            {t(`workflows.states.${state}`)}
          </Badge>
        )}
      </div>
      {!step && <p className="text-xs text-muted">{t('workflows.editor.step_not_reached')}</p>}
      {gate}
      {step?.error && (
        <Notice tone="danger">
          <span className="text-xs" dir="auto">
            {t('workflows.editor.step_error')}: {step.error}
          </span>
        </Notice>
      )}
      {output !== null && output !== '' && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted">
            {t('workflows.editor.step_output')}
          </span>
          {long ? (
            <details
              className="rounded-md border border-line p-2"
              data-testid="workflow-step-output"
            >
              <summary className="cursor-pointer text-xs">
                <span className="line-clamp-2 whitespace-pre-wrap" dir="auto">
                  {output.slice(0, 200)}
                </span>
                <span className="text-accent">{t('workflows.editor.step_output_show')}</span>
              </summary>
              <div className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-xs" dir="auto">
                {output}
              </div>
            </details>
          ) : (
            <div
              className="whitespace-pre-wrap rounded-md border border-line p-2 text-xs"
              dir="auto"
              data-testid="workflow-step-output"
            >
              {output}
            </div>
          )}
        </div>
      )}
      {onRerunFrom && (
        <div className="flex flex-col gap-1 border-t border-line pt-3">
          <Button
            size="sm"
            variant="secondary"
            className="self-start"
            loading={rerunBusy}
            onClick={() => onRerunFrom(node.id)}
            data-testid="workflow-rerun-from"
          >
            {t('workflows.editor.rerun_from_here')}
          </Button>
          <p className="text-xs text-muted">{t('workflows.editor.rerun_hint')}</p>
        </div>
      )}
    </div>
  );
}
