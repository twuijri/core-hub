#!/usr/bin/env node
// The demo hub's answers (`-UITestDemo`, CoreHub/Demo/DemoHub.swift): the App Store screenshots
// show a realistic chat, chats list, agents, tasks and settings without any real hub. The data
// is written here once, checked against the contract's own response schemas (the shapes the
// generated Swift client decodes), and turned into CoreHub/Demo/DemoFixtures.swift, a Debug-only
// file. The routes (method + path pattern per operation) come from packages/contracts/openapi.yaml,
// so no API path is typed by hand (ADR 0003).
//
//   node apps/ios/scripts/demo-fixtures.mjs          # validate and write DemoFixtures.swift
//   node apps/ios/scripts/demo-fixtures.mjs --check  # validate; fail when the file is stale (CI)
//
// Needs the contracts package's dependencies (`pnpm install --filter @corehub/contracts`).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listOperations, loadDocument } from '../../../packages/contracts/scripts/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const iosRoot = path.resolve(here, '..');
const repoRoot = path.resolve(iosRoot, '..', '..');
const output = path.join(iosRoot, 'CoreHub', 'Demo', 'DemoFixtures.swift');
const check = process.argv.includes('--check');

// ---------------------------------------------------------------------------------------------
// Ids and times

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A valid, stable ULID for the n-th demo row. */
export function ulid(n) {
  let text = '';
  let value = n;
  do {
    text = CROCKFORD[value % 32] + text;
    value = Math.floor(value / 32);
  } while (value > 0);
  return `01K5DM${text.padStart(20, '0')}`;
}

const at = (hour, minute = 0) =>
  `2026-09-25T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;

const OWNER = ulid(1);
const PROFILES = { work: ulid(2), personal: ulid(3) };
const AGENTS = { hermes: ulid(10), opencode: ulid(11), direct: ulid(12) };
const PROJECT = ulid(20);
const CHAT = ulid(100);
const generated = (seed) => ({ kind: 'generated', url: null, seed });

const scoped = (id, profile, created = at(7)) => ({
  id,
  profile,
  owner_id: OWNER,
  created_at: created,
  updated_at: created,
});

// ---------------------------------------------------------------------------------------------
// The words, in both languages

const TEXT = {
  en: {
    user: 'Sara',
    profiles: { work: 'Work', personal: 'Personal' },
    direct: 'Direct',
    sessions: [
      [
        'Weekly status update',
        'Here is the status for this week…',
        'hermes',
        'work',
        true,
        'running',
      ],
      [
        'Fix the flaky sign-in test',
        'The test waited on a timer; it now waits for the page.',
        'opencode',
        'work',
      ],
      [
        'Server backup checklist',
        'Nightly backups, then a monthly restore drill.',
        'hermes',
        'work',
      ],
      [
        'October trip plan',
        'Three days in Al Ula, with a day for the old town.',
        'direct',
        'personal',
      ],
      ['Summarise the design notes', 'Five decisions and two open questions.', 'hermes', 'work'],
      [
        'Weekend dinner ideas',
        'Grilled fish, a lentil soup and dates for dessert.',
        'direct',
        'personal',
      ],
    ],
    ask: "Summarise this week's open tasks and draft a short status update for the team.",
    thinking:
      'Read the board of the Work profile, group the tasks by state, keep it short enough for a chat message.',
    reply: [
      'Here is the status for this week:',
      '',
      '**Done**',
      '- Release notes for 1.1 are published.',
      '',
      '**In progress**',
      '- Backup review — waiting on the new storage path.',
      '- Onboarding guide — the first draft is ready for comments.',
      '',
      '**Next**',
      '1. Confirm the storage path with the team.',
      '2. Share the guide on Thursday.',
      '',
      'Shall I remind you on Thursday morning?',
    ].join('\n'),
    toolPreview: 'Tasks in Work: 6',
    followUp: 'Yes, Thursday at 9.',
    done: "Done — I'll remind you on Thursday at 9:00 and bring the guide's comments with it.",
    tasks: [
      [
        'Review the backup script',
        'running',
        'high',
        'hermes',
        'Checking the restore path on the test server.',
      ],
      [
        'Onboarding guide, first draft',
        'review',
        'normal',
        'hermes',
        'Draft ready: 6 sections, 2 open questions.',
      ],
      [
        'Fix the flaky sign-in test',
        'review',
        'high',
        'opencode',
        'Waits for the page instead of a timer.',
      ],
      [
        'Rotate the storage keys',
        'blocked',
        'urgent',
        'hermes',
        null,
        'Waiting for the new storage path.',
      ],
      ['Plan the October trip', 'todo', 'normal', 'direct', null],
      [
        'Publish the 1.1 release notes',
        'done',
        'normal',
        'hermes',
        'Published on the site and in the app.',
      ],
    ],
  },
  ar: {
    user: 'سارة',
    profiles: { work: 'العمل', personal: 'شخصي' },
    direct: 'مباشر',
    sessions: [
      ['تحديث الأسبوع للفريق', 'هذا ملخص الأسبوع…', 'hermes', 'work', true, 'running'],
      [
        'إصلاح اختبار الدخول المتقلّب',
        'كان الاختبار ينتظر مؤقتًا؛ صار ينتظر الصفحة.',
        'opencode',
        'work',
      ],
      ['قائمة النسخ الاحتياطي للخادم', 'نسخ كل ليلة، وتجربة استرجاع كل شهر.', 'hermes', 'work'],
      ['خطة رحلة أكتوبر', 'ثلاثة أيام في العُلا، ويوم للبلدة القديمة.', 'direct', 'personal'],
      ['تلخيص ملاحظات التصميم', 'خمسة قرارات وسؤالان مفتوحان.', 'hermes', 'work'],
      ['أفكار عشاء نهاية الأسبوع', 'سمك مشوي وشوربة عدس وتمر للحلى.', 'direct', 'personal'],
    ],
    ask: 'لخّص مهام هذا الأسبوع المفتوحة واكتب تحديثًا قصيرًا للفريق.',
    thinking: 'أقرأ لوحة مهام بروفايل العمل، أجمعها حسب حالتها، وأختصر بما يناسب رسالة محادثة.',
    reply: [
      'هذا ملخص الأسبوع:',
      '',
      '**أُنجز**',
      '- نُشرت ملاحظات إصدار 1.1.',
      '',
      '**قيد العمل**',
      '- مراجعة النسخ الاحتياطي — ننتظر مسار التخزين الجديد.',
      '- دليل الانضمام — المسودة الأولى جاهزة للملاحظات.',
      '',
      '**التالي**',
      '1. تأكيد مسار التخزين مع الفريق.',
      '2. مشاركة الدليل يوم الخميس.',
      '',
      'أذكّرك صباح الخميس؟',
    ].join('\n'),
    toolPreview: 'مهام العمل: 6',
    followUp: 'نعم، الخميس الساعة 9.',
    done: 'تم — سأذكّرك الخميس الساعة 9:00 ومعي ملاحظات الدليل.',
    tasks: [
      [
        'مراجعة سكربت النسخ الاحتياطي',
        'running',
        'high',
        'hermes',
        'أتحقق من مسار الاسترجاع على خادم الاختبار.',
      ],
      [
        'دليل الانضمام، المسودة الأولى',
        'review',
        'normal',
        'hermes',
        'المسودة جاهزة: ٦ أقسام وسؤالان مفتوحان.',
      ],
      ['إصلاح اختبار الدخول المتقلّب', 'review', 'high', 'opencode', 'ينتظر الصفحة بدل المؤقت.'],
      ['تدوير مفاتيح التخزين', 'blocked', 'urgent', 'hermes', null, 'ننتظر مسار التخزين الجديد.'],
      ['تخطيط رحلة أكتوبر', 'todo', 'normal', 'direct', null],
      ['نشر ملاحظات إصدار 1.1', 'done', 'normal', 'hermes', 'نُشرت في الموقع وفي التطبيق.'],
    ],
  },
};

// ---------------------------------------------------------------------------------------------
// Rows

function user(t) {
  return {
    id: OWNER,
    username: 'sara',
    display_name: t.user,
    role: 'owner',
    status: 'active',
    locale: 'en',
    avatar: generated('sara'),
    profiles: ['work', 'personal'],
    default_profile: 'work',
    last_login_at: at(7),
    created_at: at(6),
    updated_at: at(7),
  };
}

function profiles(t) {
  return {
    items: ['work', 'personal'].map((slug) => ({
      id: PROFILES[slug],
      slug,
      name: t.profiles[slug],
      avatar: generated(slug),
      default_model: null,
      agent_count: 3,
      session_count: slug === 'work' ? 4 : 2,
      owner_id: OWNER,
      created_at: at(6),
      updated_at: at(6),
    })),
  };
}

const installFor = (source, version) => ({
  source,
  path: null,
  package: null,
  command: null,
  version,
  latest_version: version,
  update_available: false,
  pinned_version: null,
  newer_than_tested: false,
  auto_update: false,
  auto_update_supported: false,
  checked_at: at(6),
  error: null,
});

function agents(t, profile) {
  const base = (slug) => scoped(AGENTS[slug], profile, at(6));
  return {
    items: [
      {
        ...base('hermes'),
        slug: 'hermes',
        name: 'Hermes',
        vendor: 'Nous Research',
        kind: 'hermes',
        avatar: generated('hermes'),
        status: 'available',
        enabled: true,
        install: installFor('builtin', null),
        runtime: { state: 'running', url: null, error: null },
        capabilities: [
          'streaming',
          'tools',
          'approvals',
          'mcp',
          'skills',
          'memory',
          'channels',
          'jobs',
        ],
        sections: ['jobs', 'channels', 'skills', 'mcp', 'memory', 'settings'],
        default_model: null,
        limited: false,
        subagents: 'full',
      },
      {
        ...base('opencode'),
        slug: 'opencode',
        name: 'OpenCode',
        vendor: 'SST',
        kind: 'acp',
        avatar: generated('opencode'),
        status: 'available',
        enabled: true,
        install: { ...installFor('managed', '1.18.31'), package: 'opencode-ai' },
        runtime: { state: 'not_applicable', url: null, error: null },
        capabilities: ['streaming', 'tools', 'approvals', 'mcp'],
        sections: ['mcp', 'settings'],
        default_model: null,
        limited: false,
        subagents: 'observe',
      },
      {
        ...base('direct'),
        slug: 'direct',
        name: t.direct,
        vendor: null,
        kind: 'builtin',
        avatar: generated('direct'),
        status: 'available',
        enabled: true,
        install: installFor('builtin', null),
        runtime: { state: 'not_applicable', url: null, error: null },
        capabilities: ['streaming', 'vision', 'resume'],
        sections: ['settings'],
        default_model: null,
        limited: false,
        subagents: 'none',
      },
    ],
  };
}

function session(index, row) {
  const [title, preview, agent, profile, pinned = false, status = 'idle'] = row;
  const id = index === 0 ? CHAT : ulid(101 + index);
  return {
    ...scoped(id, profile, at(8 - Math.min(index, 7))),
    agent_id: AGENTS[agent],
    title,
    source: 'chat',
    origin: null,
    channel: null,
    model: null,
    provider: null,
    reasoning_effort: null,
    working_dir: null,
    pinned,
    archived: false,
    category_id: null,
    preview,
    message_count: index === 0 ? 4 : 6,
    usage: null,
    context: null,
    status: index === 0 ? 'idle' : status,
    active_run_id: null,
    parent_session_id: null,
    notify: true,
    last_message_at: at(9, 40 - index * 5),
    match: null,
  };
}

function sessions(t) {
  return { items: t.sessions.map((row, index) => session(index, row)), next_cursor: null };
}

function sessionDetail(t) {
  return { ...session(0, t.sessions[0]), runs: [], pending_approvals: [] };
}

function message(n, role, text, extra = {}) {
  const agent = role === 'assistant';
  return {
    ...scoped(ulid(200 + n), 'work', at(9, 30 + n)),
    session_id: CHAT,
    room_id: null,
    seq: n,
    role,
    author: agent
      ? { kind: 'agent', id: AGENTS.hermes, name: 'Hermes', avatar: generated('hermes') }
      : { kind: 'user', id: OWNER, name: 'sara', avatar: generated('sara') },
    content: [{ type: 'text', text }],
    reasoning: null,
    tool_calls: [],
    run_id: ulid(300 + Math.ceil(n / 2)),
    status: 'complete',
    mentions: [],
    handoff: null,
    usage: null,
    reply_to_message_id: null,
    ...extra,
  };
}

function messages(t) {
  return {
    items: [
      message(1, 'user', t.ask),
      message(2, 'assistant', t.reply, {
        reasoning: { text: t.thinking, duration_ms: 4200 },
        tool_calls: [
          {
            id: ulid(400),
            name: 'tasks.list',
            status: 'succeeded',
            preview: t.toolPreview,
            arguments: { profile: 'work', status: 'open' },
            output: null,
            output_truncated: false,
            duration_ms: 310,
            subagent_id: null,
            started_at: at(9, 31),
            finished_at: at(9, 31),
          },
        ],
      }),
      message(3, 'user', t.followUp),
      message(4, 'assistant', t.done),
    ],
    has_more: false,
  };
}

function tasks(t) {
  return {
    items: t.tasks.map(([title, status, priority, agent, summary, blocked = null], index) => ({
      ...scoped(ulid(500 + index), agent === 'direct' ? 'personal' : 'work', at(6, index)),
      project_id: PROJECT,
      title,
      description: null,
      status,
      priority,
      tags: [],
      assignee: {
        kind: 'agent',
        id: AGENTS[agent],
        name: agent === 'hermes' ? 'Hermes' : agent === 'opencode' ? 'OpenCode' : t.direct,
      },
      auto_start: false,
      position: `a${index}`,
      blocked_reason: blocked,
      status_reason: null,
      subtask_counts: { total: 0, done: 0 },
      depends_on: [],
      worktree: null,
      session_id: index === 0 ? CHAT : null,
      last_run: { id: null, status: null, finished_at: null },
      attempt_count: status === 'todo' ? 0 : 1,
      latest_summary: summary,
      due_at: null,
      started_at: status === 'todo' ? null : at(7, index),
      completed_at: status === 'done' ? at(8) : null,
      archived_at: null,
      attachment_ids: [],
    })),
    next_cursor: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Answers: [language or '*', operationId, path parameter or null, body]

export function answers() {
  const out = [];
  for (const language of ['en', 'ar']) {
    const t = TEXT[language];
    out.push([language, 'auth.getMe', null, user(t)]);
    out.push([language, 'auth.listProfiles', null, profiles(t)]);
    out.push([language, 'agents.list', null, agents(t, 'work')]);
    out.push([language, 'sessions.list', null, sessions(t)]);
    out.push([language, 'sessions.get', CHAT, sessionDetail(t)]);
    out.push([language, 'sessions.listMessages', CHAT, messages(t)]);
    out.push([language, 'tasks.listTasks', null, tasks(t)]);
  }
  return out;
}

export const DEMO = { chatID: CHAT, ulid };

// ---------------------------------------------------------------------------------------------
// Validation against the contract

function responseSchemaPointer(op) {
  const responses = op.operation.responses ?? {};
  const status = ['200', '201'].find((code) => responses[code]);
  if (!status) throw new Error(`${op.operationId}: no 200/201 response`);
  const escape = (part) => part.replace(/~/g, '~0').replace(/\//g, '~1');
  let response = responses[status];
  let pointer = `#/paths/${escape(op.path)}/${op.method}/responses/${status}`;
  if (response.$ref) {
    pointer = response.$ref;
    response = response.$ref
      .slice(2)
      .split('/')
      .reduce((node, key) => node[key.replace(/~1/g, '/').replace(/~0/g, '~')], op.doc);
  }
  if (!response.content?.['application/json']?.schema) {
    throw new Error(`${op.operationId}: no application/json schema`);
  }
  return `${pointer}/content/application~1json/schema`;
}

export function validate(doc, list) {
  const require = createRequire(path.join(repoRoot, 'packages', 'contracts', 'package.json'));
  const Ajv2020 = require('ajv/dist/2020.js').default;
  const addFormats = require('ajv-formats').default;
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false });
  addFormats(ajv);
  ajv.addSchema({ ...doc, $id: 'openapi.json' });
  const ops = new Map(listOperations(doc).map((op) => [op.operationId, { ...op, doc }]));
  const problems = [];
  for (const [language, operationId, , body] of list) {
    const op = ops.get(operationId);
    if (!op) {
      problems.push(`${operationId}: not an operation of the contract`);
      continue;
    }
    const check = ajv.compile({ $ref: `openapi.json${responseSchemaPointer(op)}` });
    if (!check(body)) {
      for (const error of check.errors ?? []) {
        problems.push(`${language} ${operationId}: ${error.instancePath || '/'} ${error.message}`);
      }
    }
  }
  return { problems, ops };
}

// ---------------------------------------------------------------------------------------------
// Swift

/** `/sessions/{session_id}/messages` → `^/sessions/([^/]+)/messages$` */
export function pattern(template) {
  return `^${template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]+\\?\}/g, '([^/]+)')}$`;
}

export function swift(list, ops) {
  const used = [...new Set(list.map(([, operationId]) => operationId))].sort();
  const routes = used.map((operationId) => {
    const op = ops.get(operationId);
    return `        Route(method: "${op.method.toUpperCase()}", pattern: #"${pattern(op.path)}"#, operation: "${operationId}"),`;
  });
  const entries = list.map(([language, operationId, parameter, body]) => {
    const json = JSON.stringify(body);
    if (json.includes('"##')) throw new Error(`${operationId}: the JSON holds "##`);
    const key = [language, operationId, parameter].filter(Boolean).join(' ');
    return `        "${key}": ##"${json}"##,`;
  });
  return [
    '// Generated by apps/ios/scripts/demo-fixtures.mjs from its own data, checked against',
    '// packages/contracts/openapi.yaml. Do not edit; change the script and run',
    '// `node apps/ios/scripts/demo-fixtures.mjs`. Debug builds only (DemoHub.swift).',
    '#if DEBUG',
    'enum DemoFixtures {',
    '    struct Route {',
    '        let method: String',
    "        /// The operation's path under the contract's base path, as a regular expression.",
    '        let pattern: String',
    '        let operation: String',
    '    }',
    '',
    `    static let chatID = "${CHAT}"`,
    '',
    '    static let routes: [Route] = [',
    ...routes,
    '    ]',
    '',
    '    /// `<language> <operation>[ <path parameter>]` → the JSON body.',
    '    static let answers: [String: String] = [',
    ...entries,
    '    ]',
    '}',
    '#endif',
    '',
  ].join('\n');
}

function main() {
  const doc = loadDocument();
  const list = answers();
  const { problems, ops } = validate(doc, list);
  if (problems.length > 0) {
    console.error(`demo-fixtures  ${problems.length} answer(s) do not match the contract:`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  const text = swift(list, ops);
  const relative = path.relative(repoRoot, output);
  if (check) {
    const current = existsSync(output) ? readFileSync(output, 'utf8') : '';
    if (current !== text) {
      console.error(
        `demo-fixtures  ${relative} is stale: run node apps/ios/scripts/demo-fixtures.mjs`,
      );
      process.exit(1);
    }
    console.log(
      `demo-fixtures  OK — ${list.length} answers match the contract; ${relative} is current.`,
    );
    return;
  }
  writeFileSync(output, text);
  console.log(`demo-fixtures  wrote ${relative} (${list.length} answers, all match the contract).`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
