/**
 * The client's icons: Lucide (https://lucide.dev, ISC — THIRD-PARTY-NOTICES.md), the same set
 * the iOS and Android apps draw, so one idea has one picture on every platform
 * (docs/design/family.md). The outlines are generated into `lucide.generated.ts` by
 * `scripts/icons/lucide-web.mjs` from the pinned `lucide-static` package; nothing is hand-drawn
 * here except the arrangement.
 *
 * Screens keep importing the `Icon…` names below, so swapping a picture is one line in this file.
 * Decorative by default; pass `label` for a standalone meaning.
 */
import { createElement, type ReactNode, type SVGProps } from 'react';
import { lucideNodes, type LucideName } from './lucide.generated.js';

export type IconProps = SVGProps<SVGSVGElement> & { label?: string; size?: number };
export type IconComponent = (p: IconProps) => ReactNode;

/** Lucide's own stroke: 2 on a 24 grid, round caps and joins — as on the phones. */
function Svg({ label, size = 18, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      {...rest}
    >
      {label ? <title>{label}</title> : null}
      {children}
    </svg>
  );
}

/** The elements of one Lucide icon. */
function shapes(name: LucideName): ReactNode[] {
  return lucideNodes[name].map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }));
}

/** An icon component for one Lucide name. `scripts/icons/lucide-web.mjs` reads these calls. */
function lucide(name: LucideName): IconComponent {
  const Icon = (p: IconProps) => <Svg {...p}>{shapes(name)}</Svg>;
  Icon.displayName = `Lucide(${name})`;
  return Icon;
}

export const IconPlus = lucide('plus');
export const IconSearch = lucide('search');
export const IconEdit = lucide('square-pen');
export const IconPalette = lucide('palette');
export const IconGauge = lucide('gauge');
export const IconDevices = lucide('monitor-smartphone');
export const IconTablet = lucide('tablet');
export const IconAgents = lucide('bot');
export const IconModels = lucide('box');
export const IconKnowledge = lucide('book-open');
export const IconSettings = lucide('settings');
/** A phone. The platform is kept in the signature: one outline serves both. */
export const IconPhone = ({
  platform: _platform,
  ...p
}: IconProps & { platform?: 'ios' | 'android' }) => lucide('smartphone')(p);
/**
 * A pin pushed in at an angle, not a thumbtack seen from the front: at 14px a symmetrical
 * shape with a stem reads as a lamp or a trophy (owner, 2026-09-22: "مهب واضح وغريب"). So it is
 * Lucide's pin, turned 45° — the same outline, with a direction.
 */
export const IconPin = (p: IconProps) => (
  <Svg {...p}>
    <g transform="rotate(45 12 12)">{shapes('pin')}</g>
  </Svg>
);
export const IconSelect = lucide('square-check');
export const IconArchive = lucide('archive');
export const IconEye = lucide('eye');
export const IconEyeOff = lucide('eye-off');
export const IconTrash = lucide('trash');
export const IconGrip = lucide('grip-vertical');
export const IconSend = lucide('arrow-up');
/** Stop: Lucide's square, filled and drawn smaller, the universal "stop" glyph. */
export const IconStop = (p: IconProps) => (
  <Svg {...p}>
    <g transform="translate(12 12) scale(0.6) translate(-12 -12)" fill="currentColor" stroke="none">
      {shapes('square')}
    </g>
  </Svg>
);
/** Steer a live run: send this now, into the turn that is running. */
export const IconSteer = lucide('corner-right-down');
export const IconPaperclip = lucide('paperclip');
export const IconTool = lucide('wrench');
export const IconPanel = lucide('panel-right');
export const IconClose = lucide('x');
export const IconMenu = lucide('menu');
/** Three dots: "more actions on this row", the overflow of a list row's controls. */
export const IconMore = lucide('ellipsis');
/** A question the agent is asking: a circle with a question mark. */
export const IconHelp = lucide('circle-question-mark');
/** "Back": an arrow toward the start of the line, mirrored in a right-to-left page. */
export const IconArrowStart = ({ className = '', ...p }: IconProps) =>
  lucide('arrow-left')({ ...p, className: `rtl:-scale-x-100 ${className}` });
/** "Go": an arrow toward the end of the line, mirrored in a right-to-left page. */
export const IconArrowEnd = ({ className = '', ...p }: IconProps) =>
  lucide('arrow-right')({ ...p, className: `rtl:-scale-x-100 ${className}` });
export const IconChevron = lucide('chevron-down');
export const IconCopy = lucide('copy');
export const IconCheck = lucide('check');
export const IconSpark = lucide('sparkles');
export const IconSignOut = lucide('log-out');
export const IconSun = lucide('sun');
export const IconMoon = lucide('moon');
export const IconDisplay = lucide('monitor');
/** The theme that follows the system: half sun, half moon — as on the phones. */
export const IconThemeSystem = lucide('sun-moon');
export const IconReply = lucide('reply');
export const IconFork = lucide('git-fork');
export const IconSpeak = lucide('volume-2');
export const IconGlobe = lucide('globe');
export const IconMic = lucide('mic');
export const IconAlert = lucide('triangle-alert');
/** What is waiting for the person: a tray with something in it. */
export const IconInbox = lucide('inbox');
/** Work going on in the background: a pulse line (the Background button, §56). */
export const IconActivity = lucide('activity');
export const IconShield = lucide('shield-check');
export const IconUpload = lucide('upload');
export const IconDownload = lucide('download');
export const IconExternal = lucide('external-link');
export const IconFolder = lucide('folder');
/** A page with a folded corner: one file (the Files page). */
export const IconFile = lucide('file');
export const IconTasks = lucide('list-checks');
export const IconSchedules = lucide('calendar-clock');
export const IconUnarchive = lucide('archive-restore');
export const IconRestart = lucide('rotate-cw');

/**
 * One picture per destination of docs/clients/navigation.json — the same Lucide name the iOS
 * (`Icons.lucide(for:)`) and Android apps draw for it (docs/design/family.md, "Icons"). A
 * destination missing here has no icon; the sidebar rows and settings rows read this table.
 */
export const destinationIcons: Readonly<Record<string, IconComponent>> = {
  new_chat: lucide('square-pen'),
  search: IconSearch,
  agent_manager: IconAgents,
  tasks: IconTasks,
  schedules: IconSchedules,
  chat: lucide('messages-square'),
  rooms: lucide('users'),
  settings: IconSettings,
  account: lucide('circle-user'),
  users: lucide('users'),
  webhooks: lucide('webhook'),
  display: lucide('type'),
  notifications: lucide('bell'),
  privacy: IconShield,
  this_device: IconDisplay,
  about: lucide('info'),
  models: IconModels,
  device_connections: lucide('qr-code'),
  knowledge: IconKnowledge,
  /** Other Core Hubs linked to this one (ADR 0026). */
  linked_hubs: lucide('network'),
  logs: lucide('scroll-text'),
  usage: lucide('chart-column'),
  skills_usage: IconActivity,
  performance: lucide('gauge'),
  theme: lucide('palette'),
  workspaces: lucide('layout-grid'),
  updates: lucide('circle-arrow-down'),
  plugins: lucide('puzzle'),
  files: IconFolder,
  terminal: lucide('square-terminal'),
  agent_skills: IconSpark,
  agent_mcp: lucide('server'),
  agent_memory: lucide('brain'),
  agent_jobs: lucide('rotate-ccw-clock'),
  agent_channels: lucide('radio'),
  agent_plugins: lucide('puzzle'),
  agent_config_files: lucide('file-cog'),
  agent_settings: lucide('sliders-horizontal'),
  global_agent: IconGlobe,
};
