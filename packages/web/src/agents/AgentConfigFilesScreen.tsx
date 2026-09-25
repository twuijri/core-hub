/**
 * A coding agent's own config files (contract decision §77): its instructions file
 * (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md` …) and its settings file (`settings.json`,
 * `config.toml`), edited here by an owner or an admin.
 *
 * **One set for every profile**, and the page says so first: a coding agent reads these from
 * the home of the user the hub runs as, whichever profile a conversation is in. The profile
 * chip changes nothing here.
 *
 * One tab per file; the editor is the Files page's (`CodeEditor`): Markdown in the reading
 * font with each line's direction its own, JSON and TOML left to right in the monospace one.
 * Save sends the revision that was read, so a file changed since (by hand, or by the agent)
 * is not written over: the page says so and offers to load the current one. Revert throws
 * the unsaved edit away. A JSON file that does not parse is refused with the parser's words.
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { HubApiError } from '@corehub/contracts';
import { describeError } from '../auth/client.js';
import { useAgents } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { AppShell } from '../shell/AppShell.js';
import { Badge, Button, Notice, Skeleton, SkeletonGroup, TabPanel, Tabs } from '../ui/index.js';
import { CodeEditor } from '../workspace-files/CodeEditor.js';
import {
  useConfigFile,
  useConfigFiles,
  useSaveConfigFile,
  type ConfigFile,
} from './configFiles.js';

type T = (key: string, p?: Record<string, string | number>) => string;

/** The hub's refusal in the page's words; the JSON parser's own sentence where it gave one. */
export function describeConfigError(error: unknown, t: T): string {
  if (error instanceof HubApiError) {
    const details = (error.body as { details?: Record<string, unknown> } | undefined)?.details;
    const reason = typeof details?.reason === 'string' ? details.reason : null;
    if (reason === 'invalid_json') {
      return t('config_files.invalid_json', { message: String(details?.message ?? '') });
    }
    if (reason === 'changed') return t('config_files.changed');
    if (reason === 'symlink_outside') return t('config_files.symlink_outside');
    if (reason === 'not_utf8' || error.status === 415) return t('config_files.not_text');
    if (error.status === 413) return t('config_files.too_large');
  }
  return describeError(error, t);
}

export function AgentConfigFilesScreen() {
  const { t } = useI18n();
  const { agentId } = useParams<{ agentId: string }>();
  const agents = useAgents();
  const files = useConfigFiles(agentId);
  const [tab, setTab] = useState<string | null>(null);

  const agent = agents.data?.find((entry) => entry.id === agentId);
  const title = agent ? t('config_files.title_of', { name: agent.name }) : t('nav.config_files');
  const items = files.data?.items ?? [];
  const current = tab ?? items[0]?.key ?? null;

  return (
    <AppShell title={title}>
      <div className="flex flex-col gap-4" data-testid="config-files">
        <h1 className="text-lg font-semibold">{title}</h1>
        <div data-testid="config-files-shared">
          <Notice tone="info">{t('config_files.shared')}</Notice>
        </div>

        {files.isPending && (
          <SkeletonGroup label={t('common.loading')}>
            <Skeleton height="2.5rem" radius="md" />
            <Skeleton height="16rem" radius="md" />
          </SkeletonGroup>
        )}
        {files.isError && <Notice tone="danger">{describeConfigError(files.error, t)}</Notice>}
        {files.data && items.length === 0 && (
          <Notice tone="warning">{t('config_files.none')}</Notice>
        )}
        {current && items.length > 0 && (
          <Tabs
            label={title}
            value={current}
            onValueChange={setTab}
            testId="config-files-tabs"
            items={items.map((file) => ({ value: file.key, label: labelOf(file, t) }))}
          >
            {items.map((file) => (
              <TabPanel key={file.key} value={file.key}>
                {file.key === current && <FileEditor agentId={agentId} listed={file} />}
              </TabPanel>
            ))}
          </Tabs>
        )}
      </div>
    </AppShell>
  );
}

function labelOf(file: ConfigFile, t: T): string {
  const key = `config_files.file_${file.key}`;
  const text = t(key);
  return text === key ? file.key : text;
}

function FileEditor({ agentId, listed }: { agentId: string | undefined; listed: ConfigFile }) {
  const { t } = useI18n();
  const file = useConfigFile(agentId, listed.key);
  const save = useSaveConfigFile(agentId);
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // A new file read (after a save or a reload) starts a clean edit.
  const revision = file.data?.revision ?? null;
  useEffect(() => {
    setDraft(null);
  }, [revision, listed.key]);

  if (file.isPending)
    return (
      <SkeletonGroup label={t('common.loading')}>
        <Skeleton height="16rem" radius="md" />
      </SkeletonGroup>
    );
  if (file.isError) return <Notice tone="danger">{describeConfigError(file.error, t)}</Notice>;

  const stored = file.data.content ?? '';
  const content = draft ?? stored;
  const dirty = draft !== null && draft !== stored;
  const name = file.data.path.split('/').pop() ?? file.data.path;
  const changedElsewhere =
    save.error instanceof HubApiError &&
    (save.error.body as { details?: { reason?: string } } | undefined)?.details?.reason ===
      'changed';

  const onSave = () => {
    if (!dirty || save.isPending) return;
    setSaved(false);
    save.mutate(
      { key: listed.key, content, revision: file.data.revision },
      { onSuccess: () => setSaved(true) },
    );
  };

  return (
    <div className="flex flex-col gap-3" data-testid={`config-file-${listed.key}`}>
      <div className="flex flex-wrap items-center gap-2">
        <code className="text-sm" dir="ltr" data-testid="config-file-path">
          {file.data.path}
        </code>
        {!file.data.exists && <Badge tone="neutral">{t('config_files.not_yet')}</Badge>}
        {dirty && <Badge tone="accent">{t('config_files.unsaved')}</Badge>}
      </div>
      <p className="text-xs text-muted">{t(`config_files.about_${listed.key}`)}</p>
      <CodeEditor
        value={content}
        onChange={(next) => {
          setSaved(false);
          setDraft(next);
        }}
        fileName={name}
        label={labelOf(listed, t)}
        onSave={onSave}
        testId="config-file-editor"
      />
      {save.isError && (
        <div data-testid="config-file-error">
          <Notice tone="danger">
            {describeConfigError(save.error, t)}
            {changedElsewhere && (
              <Button
                variant="ghost"
                size="sm"
                className="ms-2"
                onClick={() => {
                  save.reset();
                  setDraft(null);
                  void file.refetch();
                }}
                data-testid="config-file-reload"
              >
                {t('config_files.reload')}
              </Button>
            )}
          </Notice>
        </div>
      )}
      {saved && !dirty && (
        <div data-testid="config-file-saved">
          <Notice tone="success">{t('config_files.saved')}</Notice>
        </div>
      )}
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={!dirty}
          loading={save.isPending}
          onClick={onSave}
          data-testid="config-file-save"
        >
          {t('common.save')}
        </Button>
        <Button
          variant="ghost"
          disabled={!dirty || save.isPending}
          onClick={() => {
            save.reset();
            setDraft(null);
          }}
          data-testid="config-file-revert"
        >
          {t('config_files.revert')}
        </Button>
      </div>
    </div>
  );
}
