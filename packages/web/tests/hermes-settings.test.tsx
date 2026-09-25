/**
 * Hermes's Settings page (contract decision §56): the form Hermes's adapter declares, drawn with
 * each field's help and Hermes's default in the reading language; a save says when it applies (or
 * that Hermes restarts); the writes waiting for review are approved or rejected; and Privacy's
 * switch is Hermes's own `privacy.redact_pii`. The whole app is mounted on a scripted hub.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../src/types.js';

class FakeSocket {
  connected = false;
  io = { on: () => undefined };
  on() {
    return this;
  }
  off() {
    return this;
  }
  once() {
    return this;
  }
  connect() {
    return this;
  }
  emit(_event: string, _payload: unknown, ack?: (reply: unknown) => void) {
    ack?.({ ok: true, replayed: 0, truncated: false });
    return this;
  }
  removeAllListeners() {}
  disconnect() {}
}

vi.mock('../src/realtime/socket.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, connectNamespace: () => new FakeSocket() };
});

const { App } = await import('../src/app.js');
const { SessionStore } = await import('../src/auth/store.js');
const { findApprovalMode } = await import('../src/chat/useComposerControls.js');

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  };
}

const HERMES = '01J8QK3ZR2W7M5N4P6T8V9X0AG';

const hermes = {
  id: HERMES,
  profile: 'default',
  owner_id: '01J8QK3ZR2W7M5N4P6T8V9X0HM',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  slug: 'hermes',
  name: 'Hermes',
  vendor: 'Nous Research',
  kind: 'hermes',
  adapter: 'hermes',
  status: 'available',
  enabled: true,
  limited: false,
  capabilities: ['streaming', 'tools', 'memory', 'skills'],
  sections: [],
  default_model: null,
  runtime: { error: null },
  install: {
    source: 'builtin',
    version: '2026.9.14',
    error: null,
    update_available: false,
    latest_version: null,
  },
} as unknown as Agent;

const t = (ar: string, en: string) => ({ ar, en });

function sections(values: Record<string, unknown> = {}) {
  const v = (key: string) => (key in values ? values[key] : null);
  return [
    {
      key: 'agent',
      title: t('وقت التشغيل', 'Agent runtime'),
      restart_required: false,
      applies: 'next_message',
      note: t('تسري من الرسالة التالية.', 'Applies from the next message.'),
      fields: [
        {
          key: 'max_turns',
          label: t('أقصى عدد للدورات في التشغيل', 'Max turns per run'),
          kind: 'integer',
          value: v('max_turns'),
          options: [],
          min: 0,
          max: 100000,
          hint: null,
          help: t('صفر = بلا حد.', '0 = no limit.'),
          default: null,
          default_text: t('٥٠٠ في محادثات كور هب', "500 in Core Hub's conversations"),
        },
        {
          key: 'reasoning_effort',
          label: t('مستوى التفكير الافتراضي', 'Default reasoning effort'),
          kind: 'choice',
          value: v('reasoning_effort'),
          options: [
            { value: 'low', label: 'Low', labels: t('منخفض', 'Low') },
            { value: 'high', label: 'High', labels: t('عالٍ', 'High') },
          ],
          min: null,
          max: null,
          hint: null,
          help: t('للنماذج التي تفكر.', 'For models that reason.'),
          default: null,
          default_text: t('افتراضي النموذج', "The model's own"),
        },
      ],
    },
    {
      key: 'memory',
      title: t('الذاكرة', 'Memory'),
      restart_required: false,
      applies: 'next_message',
      note: null,
      fields: [
        {
          key: 'memory_char_limit',
          label: t('حد ذاكرة الوكيل (حروف)', "Agent's memory limit (characters)"),
          kind: 'integer',
          value: v('memory_char_limit'),
          options: [],
          min: 100,
          max: 100000,
          hint: null,
          help: t('تُحقن في كل رسالة.', 'Goes into every message.'),
          default: 2200,
        },
      ],
    },
    {
      key: 'approvals',
      title: t('الموافقات', 'Approvals'),
      restart_required: false,
      applies: 'next_message',
      note: null,
      fields: [
        {
          key: 'approvals_mode',
          label: t('الموافقة على الأوامر الخطرة', 'Approval of dangerous commands'),
          kind: 'choice',
          value: v('approvals_mode'),
          options: [
            { value: 'manual', label: 'Manual', labels: t('يدوي', 'Manual') },
            { value: 'smart', label: 'Smart', labels: t('ذكي', 'Smart') },
            { value: 'off', label: 'Off', labels: t('بلا موافقات', 'Off') },
          ],
          min: null,
          max: null,
          hint: null,
          help: null,
          default: 'smart',
        },
        {
          key: 'memory_write_approval',
          label: t(
            'مراجعة ما يكتبه الوكيل في ذاكرته',
            'Review what the agent writes to its memory',
          ),
          kind: 'toggle',
          value: v('memory_write_approval'),
          options: [],
          min: null,
          max: null,
          hint: null,
          help: null,
          default: false,
        },
      ],
    },
    {
      key: 'network',
      title: t('وكيل الشبكة', 'Network proxy'),
      restart_required: true,
      applies: 'restart',
      note: t('لهرمز وحده، لا لكور هب نفسه.', 'For Hermes only, not Core Hub itself.'),
      fields: [
        {
          key: 'https_proxy',
          label: t('وكيل HTTPS', 'HTTPS proxy'),
          kind: 'text',
          value: v('https_proxy'),
          options: [],
          min: null,
          max: null,
          hint: null,
          help: null,
          default: null,
          default_text: t('بلا وكيل', 'No proxy'),
        },
      ],
    },
    {
      key: 'privacy',
      title: t('الخصوصية', 'Privacy'),
      restart_required: false,
      applies: 'next_message',
      note: t('في قنوات المراسلة فقط.', 'On messaging channels only.'),
      fields: [
        {
          key: 'redact_pii',
          label: t(
            'إخفاء المعرّفات وأرقام الهواتف عن النموذج',
            'Hide ids and phone numbers from the model',
          ),
          kind: 'toggle',
          value: v('redact_pii'),
          options: [],
          min: null,
          max: null,
          hint: null,
          help: null,
          default: false,
        },
      ],
    },
  ];
}

interface Sent {
  path: string;
  method: string;
  body: Record<string, unknown> | null;
}

function hub(options: { restartJob?: string; approveRefusal?: string } = {}) {
  const values: Record<string, unknown> = {};
  let pending = [
    {
      id: 'aa11',
      kind: 'memory',
      action: 'add',
      summary: 'Remember: the deploy runs on Fridays',
      origin: 'background_review',
      created_at: '2026-09-25T09:30:00Z',
      target: 'memory',
      name: null,
      content: 'The deploy runs on Fridays.',
      old_text: null,
    },
    {
      id: 'bb22',
      kind: 'skills',
      action: 'create',
      summary: "create 'deploy-notes'",
      origin: 'foreground',
      created_at: '2026-09-25T09:31:00Z',
      target: null,
      name: 'deploy-notes',
      content: 'Run the deploy on Fridays.',
      old_text: null,
    },
  ];
  const sent: Sent[] = [];
  const fetchImpl = ((url: string, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    sent.push({ path, method, body });
    const json = (value: unknown, status = 200) =>
      Promise.resolve(
        new Response(status === 204 ? null : JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (path.endsWith('/agents')) return json({ items: [hermes] });
    if (path.endsWith(`/agents/${HERMES}/settings`) && method === 'PATCH') {
      Object.assign(values, (body?.values ?? {}) as Record<string, unknown>);
      const section = sections(values).find((s) => s.key === body?.section);
      return json({
        section,
        restart_job_id: body?.section === 'network' ? (options.restartJob ?? null) : null,
      });
    }
    if (path.endsWith(`/agents/${HERMES}/settings`)) return json({ sections: sections(values) });
    if (path.endsWith('/pending-writes')) return json({ items: pending });
    if (path.endsWith('/approve')) {
      if (options.approveRefusal)
        return json(
          {
            error: 'The request conflicts with the current state',
            code: 'state_invalid',
            details: { reason: 'pending_not_applied', message: options.approveRefusal },
          },
          409,
        );
      const id = path.split('/').at(-2);
      pending = pending.filter((w) => w.id !== id);
      return json({ id, kind: path.split('/').at(-3), applied: true });
    }
    if (path.includes('/pending-writes/') && method === 'DELETE') {
      const id = path.split('/').pop();
      pending = pending.filter((w) => w.id !== id);
      return json(null, 204);
    }
    if (path.endsWith('/profiles'))
      return json({
        items: [{ id: '01J8QK3ZR2W7M5N4P6T8V9X0P1', slug: 'default', name: 'Default' }],
      });
    if (path.endsWith('/meta')) return json({ name: 'Core Hub', server_version: '0.0.0' });
    if (path.endsWith('/auth/app-tokens')) return json({ items: [] });
    return json({ items: [], next_cursor: null });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent };
}

function mount(path: string, fetchImpl: typeof fetch, language: 'ar' | 'en' = 'en') {
  const store = new SessionStore(memoryStorage());
  store.save({
    profile: 'default',
    token: 't',
    refresh_token: null,
    expires_at: null,
    user: { id: '01J8QK3ZR2W7M5N4P6T8V9X0AA', username: 'u', display_name: 'U', role: 'owner' },
  });
  window.localStorage.setItem('corehub.display', JSON.stringify({ language }));
  render(
    <App
      store={store}
      baseUrl="http://hub.test"
      fetchImpl={fetchImpl}
      router={(children) => <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>}
    />,
  );
}

describe("Hermes's Settings page", () => {
  it('draws each field with what it does and Hermes default, and says when a section applies', async () => {
    const { fetchImpl } = hub();
    mount(`/agents/${HERMES}/settings`, fetchImpl);
    const agent = await screen.findByTestId('settings-section-agent');
    expect(agent.textContent).toContain('Max turns per run');
    expect(agent.textContent).toContain('0 = no limit.');
    expect(agent.textContent).toContain("Hermes's default: 500 in Core Hub's conversations");
    expect(agent.textContent).toContain('Applies from the next message.');
    const memory = screen.getByTestId('settings-section-memory');
    expect(memory.textContent).toContain("Hermes's default: 2200");
    expect(
      (within(memory).getByTestId('field-memory_char_limit') as HTMLInputElement).placeholder,
    ).toBe('2200');
    expect(screen.getByTestId('section-note-network').textContent).toContain('not Core Hub itself');
  });

  it('saves max turns and says it applies from the next message', async () => {
    const { fetchImpl, sent } = hub();
    const user = userEvent.setup();
    mount(`/agents/${HERMES}/settings`, fetchImpl);
    const input = await screen.findByTestId('field-max_turns');
    await user.type(input, '60');
    await user.click(screen.getByTestId('save-agent'));
    await waitFor(() =>
      expect(sent.find((s) => s.method === 'PATCH' && s.path.endsWith('/settings'))?.body).toEqual({
        section: 'agent',
        values: { max_turns: 60 },
      }),
    );
    expect((await screen.findByTestId('saved-agent')).textContent).toContain(
      'applies from the next message',
    );
    await waitFor(() =>
      expect((screen.getByTestId('field-max_turns') as HTMLInputElement).value).toBe('60'),
    );
  });

  it("an emptied number goes back to Hermes's default (null)", async () => {
    const { fetchImpl, sent } = hub();
    const user = userEvent.setup();
    mount(`/agents/${HERMES}/settings`, fetchImpl);
    const input = await screen.findByTestId('field-memory_char_limit');
    await user.type(input, '9');
    await user.clear(input);
    await user.click(screen.getByTestId('save-memory'));
    await waitFor(() =>
      expect(sent.find((s) => s.method === 'PATCH' && s.path.endsWith('/settings'))?.body).toEqual({
        section: 'memory',
        values: { memory_char_limit: null },
      }),
    );
  });

  it('a proxy save that restarts Hermes says so', async () => {
    const { fetchImpl, sent } = hub({ restartJob: '01J8QK3ZR2W7M5N4P6T8V9X0K5' });
    const user = userEvent.setup();
    mount(`/agents/${HERMES}/settings`, fetchImpl);
    await user.type(await screen.findByTestId('field-https_proxy'), 'http://proxy.local:3128');
    await user.click(screen.getByTestId('save-network'));
    expect((await screen.findByTestId('saved-network')).textContent).toContain(
      'Hermes is restarting',
    );
    expect(sent.find((s) => s.method === 'PATCH')?.body).toEqual({
      section: 'network',
      values: { https_proxy: 'http://proxy.local:3128' },
    });
  });

  it('reads in Arabic: labels, choices and the default', async () => {
    const { fetchImpl } = hub();
    mount(`/agents/${HERMES}/settings`, fetchImpl, 'ar');
    const agent = await screen.findByTestId('settings-section-agent');
    expect(agent.textContent).toContain('أقصى عدد للدورات في التشغيل');
    expect(agent.textContent).toContain('الافتراضي في هرمز: ٥٠٠ في محادثات كور هب');
    expect(screen.getByTestId('settings-section-approvals').textContent).toContain(
      'الموافقة على الأوامر الخطرة',
    );
  });
});

describe('Waiting for review', () => {
  it('shows what each write would change, approves one and rejects the other', async () => {
    const { fetchImpl, sent } = hub();
    const user = userEvent.setup();
    mount(`/agents/${HERMES}/settings`, fetchImpl);
    const card = await screen.findByTestId('pending-writes');
    await within(card).findByTestId('pending-write-aa11');
    expect(within(card).getByTestId('pending-content-aa11').textContent).toBe(
      'The deploy runs on Fridays.',
    );
    expect(within(card).getByTestId('pending-write-bb22').textContent).toContain('deploy-notes');
    expect(within(card).getByTestId('pending-write-aa11').textContent).toContain(
      "Hermes's own review",
    );

    await user.click(within(card).getByTestId('pending-approve-aa11'));
    await waitFor(() => expect(within(card).queryByTestId('pending-write-aa11')).toBeNull());
    expect(
      sent.some(
        (s) => s.method === 'POST' && s.path.endsWith('/pending-writes/memory/aa11/approve'),
      ),
    ).toBe(true);

    await user.click(within(card).getByTestId('pending-reject-bb22'));
    await waitFor(() => expect(within(card).queryByTestId('pending-write-bb22')).toBeNull());
    expect(
      sent.some((s) => s.method === 'DELETE' && s.path.endsWith('/pending-writes/skills/bb22')),
    ).toBe(true);
    expect(await within(card).findByTestId('pending-empty')).toBeTruthy();
  });

  it("keeps a write Hermes could not apply, with Hermes's words", async () => {
    const { fetchImpl } = hub({ approveRefusal: 'Memory at 2190/2200 chars.' });
    const user = userEvent.setup();
    mount(`/agents/${HERMES}/settings`, fetchImpl);
    await user.click(await screen.findByTestId('pending-approve-aa11'));
    expect((await screen.findByTestId('pending-error')).textContent).toBeTruthy();
    expect(screen.getByTestId('pending-write-aa11')).toBeTruthy();
  });
});

describe('Privacy: the switch is Hermes’s own redact_pii', () => {
  it('reads and writes privacy.redact_pii through Hermes settings', async () => {
    const { fetchImpl, sent } = hub();
    const user = userEvent.setup();
    mount('/settings/privacy', fetchImpl);
    const block = await screen.findByTestId('privacy-redact');
    expect(block.textContent).toContain('On messaging channels only.');
    const toggle = within(block).getByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await user.click(toggle);
    await waitFor(() =>
      expect(sent.find((s) => s.method === 'PATCH')?.body).toEqual({
        section: 'privacy',
        values: { redact_pii: true },
      }),
    );
    // Not the hub's own profile setting, which nothing reads.
    expect(sent.some((s) => s.path.includes('/profiles/') && s.path.endsWith('/settings'))).toBe(
      false,
    );
  });
});

describe('The composer approval selector', () => {
  it("shows Hermes's own default while nothing is written", () => {
    const found = findApprovalMode(sections() as never);
    expect(found).toMatchObject({ section: 'approvals', key: 'approvals_mode', value: 'smart' });
    expect(found?.options.map((o) => o.value)).toEqual(['manual', 'smart', 'off']);
  });
});
