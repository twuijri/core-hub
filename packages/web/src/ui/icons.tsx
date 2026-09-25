// A small set of inline icons drawn for Core Hub (stroke icons on a 24-grid). Decorative by
// default; pass `label` for a standalone meaning.
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { label?: string; size?: number };

function Svg({ label, size = 18, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
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

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4-4" />
  </Svg>
);
export const IconDevices = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="13" height="10" rx="2" />
    <rect x="17" y="9" width="4" height="10" rx="1" />
    <path d="M7 19h6" />
  </Svg>
);
export const IconAgents = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="7" width="16" height="12" rx="3" />
    <path d="M12 3v4M8 12h.01M16 12h.01M9 16h6" />
  </Svg>
);
export const IconModels = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3z" />
    <path d="M4 7.5 12 12l8-4.5M12 12v9" />
  </Svg>
);
export const IconKnowledge = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 4h9l5 5v11H5z" />
    <path d="M14 4v5h5M8 13h8M8 17h8" />
  </Svg>
);
export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.3 3h-4.6l-.3 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.3 2.7h4.6l.3-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z" />
  </Svg>
);
// A pushpin seen head-on: the cap, the shoulders, the needle. The old drawing was the pin
// seen at an angle and read as an arrow or a kite (owner, 2026-09-22: "مهب واضح وغريب").
/**
 * A pin pushed in at an angle, not a thumbtack seen from the front.
 *
 * The front view is symmetrical, and at 14px a symmetrical shape with a stem reads as a
 * lamp or a trophy — which is what the owner saw. The angled pin has a direction, and a
 * shape with a direction is recognisable small.
 */
export const IconPin = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 4.5l-4 4l-4 1.5l-1.5 1.5l7 7l1.5 -1.5l1.5 -4l4 -4" />
    <path d="M9 15l-4.5 4.5" />
    <path d="M14.5 4l5.5 5.5" />
  </Svg>
);
export const IconSelect = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
    <path d="m8 12 3 3 5-6" />
  </Svg>
);
export const IconArchive = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="5" rx="1" />
    <path d="M5 9v10h14V9M10 13h4" />
  </Svg>
);
export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
  </Svg>
);
export const IconGrip = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="6" r="1.2" fill="currentColor" />
    <circle cx="15" cy="6" r="1.2" fill="currentColor" />
    <circle cx="9" cy="12" r="1.2" fill="currentColor" />
    <circle cx="15" cy="12" r="1.2" fill="currentColor" />
    <circle cx="9" cy="18" r="1.2" fill="currentColor" />
    <circle cx="15" cy="18" r="1.2" fill="currentColor" />
  </Svg>
);
export const IconSend = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </Svg>
);
export const IconSteer = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 5h7a5 5 0 0 1 5 5v6" />
    <path d="m12.5 12.5 3.5 4 3.5-4" />
  </Svg>
);
export const IconStop = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
  </Svg>
);
export const IconPaperclip = (p: IconProps) => (
  <Svg {...p}>
    <path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7" />
  </Svg>
);
export const IconTool = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 4a5 5 0 0 0-5 6L3 16l3 3 6-6a5 5 0 0 0 6-5l-3 3-2-2 3-3z" />
  </Svg>
);
export const IconPanel = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M14 5v14" />
  </Svg>
);
export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Svg>
);
export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);
/** Three dots: "more actions on this row", the overflow of a list row's controls. */
export const IconMore = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12h.01M12 12h.01M19 12h.01" />
  </Svg>
);
/** A question the agent is asking: a circle with a question mark. */
export const IconHelp = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.5v.7M12 17h.01" />
  </Svg>
);
/** "Back": an arrow toward the start of the line, mirrored in a right-to-left page. */
export const IconArrowStart = ({ className = '', ...p }: IconProps) => (
  <Svg {...p} className={`rtl:-scale-x-100 ${className}`}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Svg>
);
/** "Go": an arrow toward the end of the line, mirrored in a right-to-left page. */
export const IconArrowEnd = ({ className = '', ...p }: IconProps) => (
  <Svg {...p} className={`rtl:-scale-x-100 ${className}`}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);
export const IconChevron = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);
export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5h10" />
  </Svg>
);
export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12 5 5 9-10" />
  </Svg>
);
export const IconSpark = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />
  </Svg>
);
export const IconSignOut = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 4H5v16h5M14 8l4 4-4 4M8 12h10" />
  </Svg>
);
export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
);
export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 14.5A8.2 8.2 0 0 1 9.5 4a8.3 8.3 0 1 0 10.5 10.5Z" />
  </Svg>
);
export const IconDisplay = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M9 20h6M12 16v4" />
  </Svg>
);
export const IconReply = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 9V5l-7 7 7 7v-4.1c5 0 8 1.6 10 5.1-.8-5-3.3-10-10-10Z" />
  </Svg>
);
export const IconFork = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="5" r="2.2" />
    <circle cx="7" cy="19" r="2.2" />
    <circle cx="17" cy="9" r="2.2" />
    <path d="M7 7.2v9.6M17 11.2c0 3.2-3.3 3.6-6 4.2" />
  </Svg>
);
export const IconSpeak = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11 5 6.5 9H3v6h3.5L11 19V5Z" />
    <path d="M15.5 9.2a4 4 0 0 1 0 5.6M18.4 6.3a8 8 0 0 1 0 11.4" />
  </Svg>
);
export const IconGlobe = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" />
  </Svg>
);
export const IconMic = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
  </Svg>
);
export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.3 3.9 2.6 17.4A2 2 0 0 0 4.3 20.4h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4M12 17h.01" />
  </Svg>
);
/** What is waiting for the person: a tray with something in it. */
export const IconInbox = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 13 6.5 5.5A2 2 0 0 1 8.4 4h7.2a2 2 0 0 1 1.9 1.5L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
    <path d="M4 13h4.5l1 2h5l1-2H20" />
  </Svg>
);
/** Work going on in the background: a pulse line (the Background button, §49). */
export const IconActivity = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />
  </Svg>
);
export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 5 6v6c0 4 3 7.3 7 9 4-1.7 7-5 7-9V6l-7-3z" />
    <path d="m9 12 2 2 4-4" />
  </Svg>
);
export const IconUpload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 16V4m0 0L8 8m4-4 4 4" />
    <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
  </Svg>
);
export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4v12m0 0-4-4m4 4 4-4" />
    <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
  </Svg>
);
export const IconFolder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.5.7L11.5 7H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
);
export const IconTasks = (p: IconProps) => (
  <Svg {...p}>
    <path d="m3.5 7 1.8 1.8L8.5 5.5" />
    <path d="m3.5 16 1.8 1.8 3.2-3.3" />
    <path d="M11.5 7.5h9M11.5 16.5h9" />
  </Svg>
);
export const IconSchedules = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12.5" r="7.5" />
    <path d="M12 8.5v4l2.5 1.5M9 2.5h6" />
  </Svg>
);
export const IconUnarchive = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7h18v3H3zM5 10v9h14v-9" />
    <path d="M12 17v-5m0 0-2.5 2.5M12 12l2.5 2.5" />
  </Svg>
);
