/**
 * An agent's skills: what it knows how to do, and which of those are switched on.
 *
 * **The list is the folder.** These are files in the agent's own home, put there by the
 * person or by a pack, and this screen is a window onto that folder — so a skill it does
 * not understand is still listed, marked, and editable, rather than hidden.
 *
 * **Editing means editing the document.** `SKILL.md` is what the agent reads, front
 * matter and all, so that is what the editor holds. A form of four fields would have to
 * rewrite the file to save, and rewriting is how a pack's licence and prerequisites get
 * lost.
 *
 * **Off is not gone.** Turning a skill off takes it out of the agent's reach and leaves
 * every byte where it was, which is why it is a switch and deleting is a menu item.
 *
 * **Hermes's own skills are shown, not edited.** Hermes keeps its built-in skills in category
 * folders and updates them from its bundle; the page lists them under their category, opens
 * them to read, lets them be pinned — and offers no switch, save or delete for them, because
 * the hub rewriting one would quietly fork Hermes's copy.
 *
 * **Core Hub's own library is theirs to adapt** (decision §71). The skills the hub ships sit in
 * the `core-hub` category with a «Core Hub library» badge. They are ordinary skills — opened,
 * edited, switched, deleted — and the hub keeps them up to date only while they are as it wrote
 * them: an edited one says so and offers Restore. The library itself is switched off or on per
 * profile from the card above the list.
 *
 * **Import takes a pack as it is.** A `SKILL.md`, or a zip of one skill or several, lands in
 * this profile's folder byte for byte; a pack Hermes could not read is refused whole, with
 * the skill and the file named, and nothing half-installed.
 */
import { useRef, useState } from 'react';
import { useParams } from 'react-router';
import { describeError } from '../auth/client.js';
import { useAgents } from '../hub/queries.js';
import { useI18n } from '../i18n/context.js';
import { AppShell } from '../shell/AppShell.js';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  EmptyState,
  Input,
  Notice,
  Skeleton,
  SkeletonGroup,
  Switch,
  Textarea,
  Tooltip,
  useConfirm,
  useToast,
} from '../ui/index.js';
import { IconPin, IconSearch, IconSpark, IconTrash } from '../ui/icons.js';
import {
  LIBRARY_CATEGORY,
  useDeleteSkill,
  useImportSkills,
  usePatchSkill,
  useRestoreSkill,
  useSaveSkill,
  useSetSkillLibrary,
  useSkill,
  useSkills,
  type Skill,
  type SkillLibrary,
} from './skills.js';
import { describeToolError } from './toolErrors.js';

export function AgentSkillsScreen() {
  const { t } = useI18n();
  const { agentId } = useParams<{ agentId: string }>();
  const agents = useAgents();
  const skills = useSkills(agentId);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const importer = useImportSkills(agentId);
  const picker = useRef<HTMLInputElement>(null);

  const agent = agents.data?.find((entry) => entry.id === agentId);
  const title = agent ? t('skills.title_of', { name: agent.name }) : t('nav.agent_skills');
  const needle = search.trim().toLowerCase();
  const categories = (skills.data?.categories ?? [])
    .map((category) => ({
      ...category,
      skills: category.skills.filter(
        (skill) =>
          needle === '' ||
          skill.name.toLowerCase().includes(needle) ||
          (skill.description ?? '').toLowerCase().includes(needle),
      ),
    }))
    .filter((category) => category.skills.length > 0);
  const total = (skills.data?.categories ?? []).reduce(
    (sum, category) => sum + category.skills.length,
    0,
  );

  return (
    <AppShell title={title}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{title}</h1>
          {total > 0 && <Badge>{String(total)}</Badge>}
          <Input
            className="ms-auto max-w-64"
            inputSize="sm"
            icon={<IconSearch size={14} />}
            placeholder={t('skills.search')}
            aria-label={t('skills.search')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            data-testid="skill-search"
          />
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            accept=".md,.markdown,.zip,.skill"
            data-testid="import-skills-file"
            onChange={(event) => {
              const files = event.target.files ? [...event.target.files] : [];
              event.target.value = '';
              if (files.length > 0) importer.mutate(files);
            }}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={importer.isPending}
            onClick={() => picker.current?.click()}
            data-testid="import-skills"
          >
            {importer.isPending ? t('skills.import.running') : t('skills.import.button')}
          </Button>
          <Button size="sm" onClick={() => setEditing('')} data-testid="new-skill">
            {t('skills.new')}
          </Button>
        </div>
        {importer.isError && (
          <div data-testid="import-skills-result" data-ok="false">
            <Notice tone="danger">{describeToolError(importer.error, t)}</Notice>
          </div>
        )}
        {importer.data && (
          <div data-testid="import-skills-result" data-ok="true">
            <Notice tone="success">
              {t('skills.import.done', {
                count: String(importer.data.items.length),
                names: importer.data.items.map((skill) => skill.name).join(', '),
              })}
            </Notice>
          </div>
        )}

        {skills.data?.library && (
          <SkillLibraryCard agentId={agentId} library={skills.data.library} />
        )}

        {skills.isPending && (
          <SkeletonGroup label={t('common.loading')}>
            <Skeleton height="4rem" radius="md" />
            <Skeleton height="4rem" radius="md" />
          </SkeletonGroup>
        )}
        {skills.isError && <Notice tone="danger">{describeToolError(skills.error, t)}</Notice>}
        {skills.data &&
          (total === 0 ? (
            <EmptyState
              icon={<IconSpark size={20} />}
              title={t('skills.none')}
              body={
                <>
                  {t('skills.none_body')}
                  {skills.data.home && (
                    <>
                      {' '}
                      <code dir="ltr">{skills.data.home}</code>
                    </>
                  )}
                </>
              }
            />
          ) : categories.length === 0 ? (
            <EmptyState size="sm" title={t('skills.no_match')} body={t('skills.no_match_body')} />
          ) : (
            <div className="flex flex-col gap-5" data-testid="skill-categories">
              {categories.map((category) => (
                <section
                  key={category.key}
                  className="flex flex-col gap-2"
                  data-testid="skill-category"
                  data-category={category.key}
                >
                  <h2 className="text-sm font-semibold text-muted">
                    {category.key === 'user'
                      ? t('skills.category_user')
                      : category.key === LIBRARY_CATEGORY
                        ? t('skills.library.title')
                        : category.name}
                  </h2>
                  {category.description && (
                    <p className="text-xs text-muted" dir="auto">
                      {category.description}
                    </p>
                  )}
                  <ul className="flex flex-col gap-2">
                    {category.skills.map((skill) => (
                      <li key={skill.key}>
                        <SkillRow
                          agentId={agentId}
                          skill={skill}
                          onEdit={() => setEditing(skill.key)}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ))}
      </div>
      {editing !== null && (
        <SkillEditor agentId={agentId} skillKey={editing} onClose={() => setEditing(null)} />
      )}
    </AppShell>
  );
}

function SkillRow({
  agentId,
  skill,
  onEdit,
}: {
  agentId: string | undefined;
  skill: Skill;
  onEdit: () => void;
}) {
  const { t } = useI18n();
  const patch = usePatchSkill(agentId);
  const remove = useDeleteSkill(agentId);
  const restore = useRestoreSkill(agentId);
  const toast = useToast();
  const { ask, dialog } = useConfirm();
  // The server marks an unreadable file by putting the reason where the description goes.
  const broken = (skill.description ?? '').startsWith('[');
  // Hermes's own: readable, pinnable and switchable — the switch is Hermes's own list, which
  // leaves its files alone (§103) — never rewritten or deleted from here.
  const builtin = skill.source === 'builtin';
  // Core Hub's own: kept up to date by the hub until the person edits it.
  const library = skill.source === 'library';
  const edited = library && skill.library === 'edited';

  return (
    <div
      className="skill-row"
      data-enabled={skill.enabled || undefined}
      data-testid="skill-row"
      data-skill={skill.key}
      data-source={skill.source}
      data-library={skill.library ?? undefined}
    >
      <Switch
        checked={skill.enabled}
        disabled={patch.isPending}
        label={t('skills.enabled')}
        labelHidden
        testId={`skill-toggle-${skill.key}`}
        onChange={(next) =>
          patch.mutate(
            { key: skill.key, enabled: next },
            { onError: (error) => toast({ title: describeToolError(error, t), tone: 'danger' }) },
          )
        }
      />
      <button type="button" className="skill-open" onClick={onEdit}>
        <span className="flex items-center gap-2">
          <span className="font-medium" dir="auto">
            {skill.name}
          </span>
          {skill.pinned && (
            <Tooltip label={t('skills.pinned')}>
              <span>
                <IconPin size={14} />
              </span>
            </Tooltip>
          )}
          {broken && <Badge tone="warning">{t('skills.broken')}</Badge>}
          {builtin && (
            <Tooltip label={t('skills.builtin_hint')}>
              <span>
                <Badge>{t('skills.builtin')}</Badge>
              </span>
            </Tooltip>
          )}
          {library && (
            <Tooltip label={t('skills.library.hint')}>
              <span>
                <Badge tone="accent" testId={`skill-library-${skill.key}`}>
                  {t('skills.library.title')}
                </Badge>
              </span>
            </Tooltip>
          )}
          {edited && (
            <Tooltip label={t('skills.library.edited_hint')}>
              <span>
                <Badge tone="warning">{t('skills.library.edited')}</Badge>
              </span>
            </Tooltip>
          )}
        </span>
        {skill.description && !broken && (
          <span className="skill-description" dir="auto">
            {skill.description}
          </span>
        )}
      </button>
      <span className="flex items-center gap-1">
        {edited && (
          <Button
            size="sm"
            variant="ghost"
            disabled={restore.isPending}
            data-testid={`skill-restore-${skill.key}`}
            onClick={() => {
              void ask({
                title: t('skills.library.restore_title', { name: skill.name }),
                body: t('skills.library.restore_body'),
                confirmLabel: t('skills.library.restore'),
              }).then((yes) => {
                if (!yes) return;
                restore.mutate(skill.key, {
                  onSuccess: () =>
                    toast({
                      title: t('skills.library.restored', { name: skill.name }),
                      tone: 'success',
                    }),
                  onError: (error) => toast({ title: describeToolError(error, t), tone: 'danger' }),
                });
              });
            }}
          >
            {t('skills.library.restore')}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-label={t(skill.pinned ? 'skills.unpin' : 'skills.pin')}
          data-testid={`skill-pin-${skill.key}`}
          onClick={() => patch.mutate({ key: skill.key, pinned: !skill.pinned })}
        >
          <IconPin size={14} />
        </Button>
        {!builtin && (
          <Button
            size="sm"
            variant="ghost"
            aria-label={t('common.delete')}
            data-testid={`skill-delete-${skill.key}`}
            onClick={() => {
              void ask({
                title: t('skills.delete_title', { name: skill.name }),
                // The whole folder goes, because a skill is a folder.
                body: t('skills.delete_body'),
                confirmLabel: t('common.delete'),
              }).then((yes) => {
                if (yes) remove.mutate(skill.key);
              });
            }}
          >
            <IconTrash size={14} />
          </Button>
        )}
      </span>
      {dialog}
    </div>
  );
}

/**
 * Core Hub's library in this profile: how many of its skills are here, how many the person
 * edited, and the switch. Off removes the untouched ones (after asking) and leaves the edited
 * ones as the person's; on installs the whole library. A profile the hub never installed it in
 * (a Hermes it does not run itself) offers to install it.
 */
function SkillLibraryCard({
  agentId,
  library,
}: {
  agentId: string | undefined;
  library: SkillLibrary;
}) {
  const { t } = useI18n();
  const set = useSetSkillLibrary(agentId);
  const { ask, dialog } = useConfirm();
  const missing = library.enabled && library.installed < library.available;

  return (
    <Card
      padding="sm"
      testId="skill-library"
      data-enabled={library.enabled || undefined}
      as="section"
    >
      <CardHeader
        media={<IconSpark size={18} />}
        title={t('skills.library.title')}
        subtitle={
          library.enabled && library.installed === 0
            ? t('skills.library.summary_none', { available: String(library.available) })
            : library.enabled
              ? t('skills.library.summary_on', {
                  installed: String(library.installed),
                  available: String(library.available),
                })
              : t('skills.library.summary_off')
        }
        actions={
          <span className="flex items-center gap-2">
            {library.edited > 0 && (
              <Badge tone="warning">
                {t('skills.library.edited_count', { count: String(library.edited) })}
              </Badge>
            )}
            {missing && (
              <Button
                size="sm"
                variant="secondary"
                disabled={set.isPending}
                data-testid="skill-library-install"
                onClick={() => set.mutate(true)}
              >
                {t('skills.library.install')}
              </Button>
            )}
            <Switch
              checked={library.enabled}
              disabled={set.isPending}
              label={t('skills.library.switch')}
              labelHidden
              testId="skill-library-toggle"
              onChange={(next) => {
                if (next) {
                  set.mutate(true);
                  return;
                }
                void ask({
                  title: t('skills.library.off_title'),
                  body: t('skills.library.off_body'),
                  confirmLabel: t('skills.library.off_confirm'),
                }).then((yes) => {
                  if (yes) set.mutate(false);
                });
              }}
            />
          </span>
        }
      />
      {set.isError && <Notice tone="danger">{describeToolError(set.error, t)}</Notice>}
      {dialog}
    </Card>
  );
}

const TEMPLATE = `---
name: 
description: 
---

`;

function SkillEditor({
  agentId,
  skillKey,
  onClose,
}: {
  agentId: string | undefined;
  skillKey: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const existing = useSkill(agentId, skillKey === '' ? null : skillKey);
  const save = useSaveSkill(agentId);
  const [key, setKey] = useState(skillKey);
  const [draft, setDraft] = useState<string | null>(null);
  const content = draft ?? existing.data?.content ?? (skillKey === '' ? TEMPLATE : '');
  const creating = skillKey === '';
  const readOnly = existing.data?.source === 'builtin';
  const fromLibrary = existing.data?.source === 'library';
  const badKey = key !== '' && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key);

  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(open) => !open && onClose()}
      title={creating ? t('skills.new') : skillKey}
      description={
        readOnly
          ? t('skills.builtin_hint')
          : fromLibrary
            ? t('skills.library.editor_note')
            : t('skills.editor_note')
      }
      closeLabel={t('common.cancel')}
      testId="skill-editor"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {readOnly ? t('skills.close') : t('common.cancel')}
          </Button>
          {!readOnly && (
            <Button
              disabled={key === '' || badKey || save.isPending}
              data-testid="save-skill"
              onClick={() => save.mutate({ key, content }, { onSuccess: onClose })}
            >
              {t('common.save')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {creating && (
          <Input
            dir="ltr"
            placeholder="my-skill"
            aria-label={t('skills.key')}
            value={key}
            invalid={badKey}
            onChange={(event) => setKey(event.target.value)}
            data-testid="skill-key"
          />
        )}
        <Textarea
          rows={18}
          dir="ltr"
          className="skill-editor"
          aria-label={t('skills.document')}
          readOnly={readOnly}
          value={content}
          onChange={(event) => setDraft(event.target.value)}
          data-testid="skill-content"
        />
        {save.isError && <Notice tone="danger">{describeError(save.error, t)}</Notice>}
      </div>
    </Dialog>
  );
}
