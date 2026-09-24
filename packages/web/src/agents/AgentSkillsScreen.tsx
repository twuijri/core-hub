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
} from '../ui/index.js';
import { IconPin, IconSearch, IconSpark, IconTrash } from '../ui/icons.js';
import {
  useDeleteSkill,
  useImportSkills,
  usePatchSkill,
  useSaveSkill,
  useSkill,
  useSkills,
  type Skill,
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
                <section key={category.key} className="flex flex-col gap-2">
                  <h2 className="text-sm font-semibold text-muted">
                    {category.key === 'user' ? t('skills.category_user') : category.name}
                  </h2>
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
  const { ask, dialog } = useConfirm();
  // The server marks an unreadable file by putting the reason where the description goes.
  const broken = (skill.description ?? '').startsWith('[');

  return (
    <div className="skill-row" data-enabled={skill.enabled || undefined}>
      <Switch
        checked={skill.enabled}
        label={t('skills.enabled')}
        labelHidden
        testId={`skill-toggle-${skill.key}`}
        onChange={(next) => patch.mutate({ key: skill.key, enabled: next })}
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
        </span>
        {skill.description && !broken && (
          <span className="skill-description" dir="auto">
            {skill.description}
          </span>
        )}
      </button>
      <span className="flex items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          aria-label={t(skill.pinned ? 'skills.unpin' : 'skills.pin')}
          data-testid={`skill-pin-${skill.key}`}
          onClick={() => patch.mutate({ key: skill.key, pinned: !skill.pinned })}
        >
          <IconPin size={14} />
        </Button>
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
      </span>
      {dialog}
    </div>
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
  const badKey = key !== '' && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key);

  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(open) => !open && onClose()}
      title={creating ? t('skills.new') : skillKey}
      description={t('skills.editor_note')}
      closeLabel={t('common.cancel')}
      testId="skill-editor"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={key === '' || badKey || save.isPending}
            data-testid="save-skill"
            onClick={() => save.mutate({ key, content }, { onSuccess: onClose })}
          >
            {t('common.save')}
          </Button>
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
          value={content}
          onChange={(event) => setDraft(event.target.value)}
          data-testid="skill-content"
        />
        {save.isError && <Notice tone="danger">{describeError(save.error, t)}</Notice>}
      </div>
    </Dialog>
  );
}
