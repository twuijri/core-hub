/**
 * The people on this hub: who they are, what they may do, and the doors that locked.
 *
 * **Every row offers only what the hub will accept.** The owner's role, status and
 * password are immutable and the account cannot be deleted; nobody may disable or delete
 * themselves. Those are the server's rules (`auth/users.ts`), asked here as questions
 * rather than discovered as a red banner after the click.
 *
 * **A password is set, never shown.** It is typed once into a field that is emptied the
 * moment it is sent, and no response ever carries it back.
 */
import { useState } from 'react';
import { describeError } from '../auth/client.js';
import { useAuth } from '../auth/context.js';
import { useI18n } from '../i18n/context.js';
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Field,
  Input,
  Menu,
  MenuItem,
  MenuSeparator,
  Notice,
  Select,
  Skeleton,
  SkeletonGroup,
  Table,
  useConfirm,
  type Column,
} from '../ui/index.js';
import { IconMore, IconTrash, IconShield } from '../ui/icons.js';
import {
  isOwner,
  isSelf,
  useClearLockouts,
  useCreateUser,
  useDeleteUser,
  useLockouts,
  useUpdateUser,
  useUsers,
  useWorkspaces,
  type HubUser,
  type Workspace,
} from './queries.js';

export function UsersTab() {
  const { t } = useI18n();
  const users = useUsers();
  const [adding, setAdding] = useState(false);

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3" aria-labelledby="users-heading">
        <div className="flex items-center gap-2">
          <h3 id="users-heading" className="text-sm font-semibold">
            {t('people.title')}
          </h3>
          <Button
            className="ms-auto"
            size="sm"
            onClick={() => setAdding(true)}
            data-testid="add-user"
          >
            {t('people.add')}
          </Button>
        </div>
        {users.isPending && (
          <SkeletonGroup label={t('common.loading')}>
            <Skeleton height="8rem" radius="md" />
          </SkeletonGroup>
        )}
        {users.isError && <Notice tone="danger">{describeError(users.error, t)}</Notice>}
        {users.data && <UserTable users={users.data.items} />}
      </section>
      <Lockouts />
      {adding && <AddUser onClose={() => setAdding(false)} />}
    </div>
  );
}

function UserTable({ users }: { users: HubUser[] }) {
  const { t } = useI18n();
  const columns: Array<Column<HubUser>> = [
    {
      key: 'who',
      header: t('people.person'),
      cell: (user) => (
        <span className="flex items-center gap-2">
          <Avatar name={user.display_name || user.username} size="sm" />
          <span className="flex flex-col">
            <span dir="auto">{user.display_name || user.username}</span>
            <span className="text-xs text-muted" dir="ltr">
              {user.username}
            </span>
          </span>
        </span>
      ),
    },
    {
      key: 'role',
      header: t('people.role'),
      cell: (user) => (
        <Badge tone={user.role === 'owner' ? 'accent' : 'neutral'}>{t(`roles.${user.role}`)}</Badge>
      ),
    },
    {
      key: 'status',
      header: t('people.status'),
      cell: (user) => (
        <Badge tone={user.status === 'active' ? 'success' : 'warning'}>
          {t(`people.status_${user.status}`)}
        </Badge>
      ),
    },
    {
      key: 'workspaces',
      header: t('people.workspaces'),
      // Owners and admins enter every workspace whatever the list says; a member enters
      // the ones listed (the hub's rule, `auth/workspace.ts` canEnter).
      cell: (user) =>
        user.role !== 'member' || user.profiles.length === 0
          ? t('people.all_workspaces')
          : user.profiles.join('، '),
    },
    { key: 'menu', header: '', cell: (user) => <UserMenu user={user} /> },
  ];
  return (
    <Table
      caption={t('people.title')}
      testId="user-table"
      columns={columns}
      rows={users}
      rowKey={(user) => user.id}
    />
  );
}

function UserMenu({ user }: { user: HubUser }) {
  const { t } = useI18n();
  const { session } = useAuth();
  const update = useUpdateUser();
  const remove = useDeleteUser();
  const { ask, dialog } = useConfirm();
  const [resetting, setResetting] = useState(false);
  const [placing, setPlacing] = useState(false);
  const owner = isOwner(user);
  const self = isSelf(user, session?.user.id);

  // Nothing at all may be done to the owner's account from here, so the menu says that
  // once instead of showing four disabled rows.
  if (owner)
    return (
      <span className="text-xs text-muted" data-testid="owner-note">
        {t('people.owner_note')}
      </span>
    );

  const confirmDelete = () => {
    void ask({
      title: t('people.delete_title', { name: user.display_name || user.username }),
      body: t('people.delete_body'),
      confirmLabel: t('common.delete'),
    }).then((yes) => {
      if (yes) remove.mutate(user.id);
    });
  };

  // The two things people come here for are buttons on the row, not entries hidden behind
  // "⋯" (owner, 2026-09-23: «اليوزر ما فيه حذف له او تعديل الباسوورد حقه؟»).
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setResetting(true)}
          data-testid="user-password"
        >
          {t('people.lock_password')}
        </Button>
        {!self && (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            icon={<IconTrash size={16} />}
            aria-label={t('common.delete')}
            tooltip={t('common.delete')}
            onClick={confirmDelete}
            data-testid="user-delete"
          />
        )}
        <Menu
          trigger={
            <Button variant="ghost" size="sm" aria-label={t('common.more')} data-testid="user-menu">
              <IconMore size={16} />
            </Button>
          }
        >
          <MenuItem
            onSelect={() =>
              update.mutate({
                id: user.id,
                patch: { role: user.role === 'admin' ? 'member' : 'admin' },
              })
            }
          >
            {t(user.role === 'admin' ? 'people.make_member' : 'people.make_admin')}
          </MenuItem>
          {/* Only a member is held to a list; an admin enters every workspace regardless. */}
          {user.role === 'member' && (
            <MenuItem onSelect={() => setPlacing(true)}>{t('people.edit_workspaces')}</MenuItem>
          )}
          {/* Disabling or deleting yourself is refused by the hub, so it is not offered:
            a greyed row that explains nothing is worse than a row that is not there. */}
          {!self && (
            <>
              <MenuSeparator />
              <MenuItem
                onSelect={() =>
                  update.mutate({
                    id: user.id,
                    patch: { status: user.status === 'active' ? 'disabled' : 'active' },
                  })
                }
              >
                {t(user.status === 'active' ? 'people.disable' : 'people.enable')}
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
      {dialog}
      {resetting && <SetPassword user={user} onClose={() => setResetting(false)} />}
      {placing && <EditWorkspaces user={user} onClose={() => setPlacing(false)} />}
      {(update.isError || remove.isError) && (
        <Notice tone="danger">{describeError(update.error ?? remove.error, t)}</Notice>
      )}
    </div>
  );
}

function SetPassword({ user, onClose }: { user: HubUser; onClose: () => void }) {
  const { t } = useI18n();
  const update = useUpdateUser();
  const [password, setPassword] = useState('');
  const short = password.length > 0 && password.length < 8;

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('people.set_password_for', { name: user.display_name || user.username })}
      description={t('people.password_note')}
      closeLabel={t('common.cancel')}
      testId="set-password"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={password.length < 8 || update.isPending}
            onClick={() => {
              update.mutate(
                { id: user.id, patch: { password } },
                {
                  onSuccess: () => {
                    // Emptied the moment it is sent: nothing keeps it after that.
                    setPassword('');
                    onClose();
                  },
                },
              );
            }}
            data-testid="save-password"
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Field
        label={t('people.new_password')}
        {...(short ? { error: t('people.password_short') } : {})}
      >
        {(props) => (
          <Input
            {...props}
            type="password"
            autoComplete="new-password"
            value={password}
            invalid={short}
            onChange={(event) => setPassword(event.target.value)}
          />
        )}
      </Field>
      {update.isError && <Notice tone="danger">{describeError(update.error, t)}</Notice>}
    </Dialog>
  );
}

function AddUser({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const create = useCreateUser();
  const workspaces = useWorkspaces();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [chosen, setChosen] = useState<string[]>([]);
  // The contract's pattern, checked here so the field says so before the hub does.
  const badName = username.length > 0 && !/^[a-z0-9._-]{2,40}$/.test(username);
  // A member with no workspace would enter all of them (the hub reads an empty list as
  // "unrestricted"), so a member is not added until at least one is chosen.
  const placed = role === 'admin' || chosen.length > 0;
  const ready = !badName && username.length >= 2 && password.length >= 8 && placed;
  const shortPassword = password.length > 0 && password.length < 8;

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('people.add')}
      closeLabel={t('common.cancel')}
      testId="add-user-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!ready || create.isPending}
            data-testid="save-user"
            onClick={() =>
              create.mutate(
                {
                  username,
                  password,
                  role,
                  ...(role === 'member' ? { profiles: chosen } : {}),
                  ...(displayName ? { display_name: displayName } : {}),
                },
                {
                  onSuccess: () => {
                    setPassword('');
                    onClose();
                  },
                },
              )
            }
          >
            {t('people.add')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          label={t('people.username')}
          hint={t('people.username_hint')}
          {...(badName ? { error: t('people.username_bad') } : {})}
        >
          {(props) => (
            <Input
              {...props}
              dir="ltr"
              value={username}
              invalid={badName}
              autoComplete="off"
              onChange={(event) => setUsername(event.target.value)}
            />
          )}
        </Field>
        <Field label={t('people.display_name')}>
          {(props) => (
            <Input
              {...props}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          )}
        </Field>
        {/* A button that is off says why (owner, 2026-09-23: «يلغي زر الانشاء ولا تدري ليش»). */}
        <Field
          label={t('people.new_password')}
          hint={t('people.password_short')}
          {...(shortPassword ? { error: t('people.password_short') } : {})}
        >
          {(props) => (
            <Input
              {...props}
              type="password"
              autoComplete="new-password"
              value={password}
              invalid={shortPassword}
              onChange={(event) => setPassword(event.target.value)}
              data-testid="new-user-password"
            />
          )}
        </Field>
        <Select
          label={t('people.role')}
          value={role}
          onValueChange={(value) => setRole(value === 'admin' ? 'admin' : 'member')}
          options={[
            { value: 'member', label: t('roles.member'), description: t('people.member_can') },
            { value: 'admin', label: t('roles.admin'), description: t('people.admin_can') },
          ]}
        />
        {role === 'admin' ? (
          <p className="text-xs text-muted">{t('people.admin_everywhere')}</p>
        ) : (
          <>
            <WorkspaceChoice
              workspaces={workspaces.data?.items ?? []}
              chosen={chosen}
              onChange={setChosen}
            />
            {!placed && (
              <p className="text-xs text-warning-soft-text" data-testid="workspaces-required">
                {t('people.workspaces_required')}
              </p>
            )}
          </>
        )}
        {create.isError && <Notice tone="danger">{describeError(create.error, t)}</Notice>}
      </div>
    </Dialog>
  );
}

/** The workspaces a member may enter: one box each, at least one to go on. */
function WorkspaceChoice({
  workspaces,
  chosen,
  onChange,
}: {
  workspaces: Workspace[];
  chosen: string[];
  onChange(next: string[]): void;
}) {
  const { t } = useI18n();
  return (
    <fieldset className="flex flex-col gap-2" data-testid="workspace-choice">
      <legend className="mb-1 text-sm font-medium">{t('people.workspaces')}</legend>
      <p className="text-xs text-muted">{t('people.workspaces_hint')}</p>
      {workspaces.map((workspace) => (
        <Checkbox
          key={workspace.id}
          label={
            <span className="flex items-center gap-2">
              <span dir="auto">{workspace.name}</span>
              <span className="text-xs text-muted" dir="ltr">
                {workspace.slug}
              </span>
            </span>
          }
          checked={chosen.includes(workspace.slug)}
          onChange={(on) =>
            onChange(
              on ? [...chosen, workspace.slug] : chosen.filter((slug) => slug !== workspace.slug),
            )
          }
          testId={`workspace-${workspace.slug}`}
        />
      ))}
      {chosen.length === 0 && (
        <p className="text-xs text-danger-soft-text">{t('people.workspaces_required')}</p>
      )}
    </fieldset>
  );
}

function EditWorkspaces({ user, onClose }: { user: HubUser; onClose: () => void }) {
  const { t } = useI18n();
  const update = useUpdateUser();
  const workspaces = useWorkspaces();
  const [chosen, setChosen] = useState<string[]>(user.profiles);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('people.workspaces_for', { name: user.display_name || user.username })}
      closeLabel={t('common.cancel')}
      testId="edit-workspaces"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={chosen.length === 0 || update.isPending}
            onClick={() =>
              update.mutate({ id: user.id, patch: { profiles: chosen } }, { onSuccess: onClose })
            }
            data-testid="save-workspaces"
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <WorkspaceChoice
        workspaces={workspaces.data?.items ?? []}
        chosen={chosen}
        onChange={setChosen}
      />
      {update.isError && <Notice tone="danger">{describeError(update.error, t)}</Notice>}
    </Dialog>
  );
}

/**
 * The doors that locked themselves. An empty list is the answer a healthy hub gives, and
 * it is drawn as such rather than hidden — "nobody is locked out" is information.
 */
function Lockouts() {
  const { t } = useI18n();
  const lockouts = useLockouts();
  const clear = useClearLockouts();
  const rows = lockouts.data?.items ?? [];

  return (
    <section className="flex flex-col gap-3" aria-labelledby="lockouts-heading">
      <div className="flex items-center gap-2">
        <h3 id="lockouts-heading" className="text-sm font-semibold">
          {t('people.lockouts')}
        </h3>
        {rows.length > 0 && (
          <Button
            className="ms-auto"
            size="sm"
            variant="ghost"
            onClick={() => clear.mutate()}
            data-testid="clear-lockouts"
          >
            {t('people.clear_lockouts')}
          </Button>
        )}
      </div>
      {lockouts.isError && <Notice tone="danger">{describeError(lockouts.error, t)}</Notice>}
      {rows.length === 0 ? (
        <EmptyState
          size="sm"
          icon={<IconShield size={20} />}
          title={t('people.no_lockouts')}
          body={t('people.no_lockouts_body')}
        />
      ) : (
        <Table
          caption={t('people.lockouts')}
          testId="lockout-table"
          rows={rows}
          rowKey={(row) => `${row.ip}-${row.kind}`}
          columns={[
            { key: 'ip', header: t('people.ip'), cell: (row) => <span dir="ltr">{row.ip}</span> },
            {
              key: 'kind',
              header: t('people.lock_kind'),
              cell: (row) => t(`people.lock_${row.kind}`),
            },
            {
              key: 'failures',
              header: t('people.failures'),
              cell: (row) => String(row.failures),
              numeric: true,
            },
            {
              key: 'until',
              header: t('people.locked_until'),
              cell: (row) => row.locked_until.slice(11, 16),
            },
          ]}
        />
      )}
    </section>
  );
}
