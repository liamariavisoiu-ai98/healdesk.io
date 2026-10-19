import type { IconName } from "@/lib/admin/system-map";

/**
 * The system map's pictures: one plain stroke drawing per kind of thing, so a
 * phone line, a calendar and a key safe can be told apart before their names
 * are read. Drawn here rather than from an icon package, which this app does
 * not carry and should not grow for twenty shapes.
 */

type ExtraIcon = "key" | "play" | "pause" | "next" | "prev" | "close" | "alert" | "check" | "wrench" | "question" | "dot" | "refresh";

const PATHS: Record<IconName | ExtraIcon, React.ReactNode> = {
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c0-3.5 2.9-5.5 6.5-5.5s6.5 2 6.5 5.5" />
      <circle cx="17" cy="7.5" r="2.7" />
      <path d="M16.5 14.6c2.9.3 5 2 5 5.4" />
    </>
  ),
  building: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="1.5" />
      <path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2M10 21v-3h4v3" />
    </>
  ),
  megaphone: (
    <>
      <path d="M3 10v4a1 1 0 0 0 1 1h3l8 5V4L7 9H4a1 1 0 0 0-1 1z" />
      <path d="M18.5 8.5a5 5 0 0 1 0 7" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6" />
    </>
  ),
  store: (
    <>
      <path d="M3.5 9 5 4h14l1.5 5" />
      <path d="M3.5 9a2.8 2.8 0 0 0 5.6 0 2.8 2.8 0 0 0 5.8 0 2.8 2.8 0 0 0 5.6 0" />
      <path d="M5 12v8h14v-8M10 20v-5h4v5" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" />
      <path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13" />
      <path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </>
  ),
  phone: <path d="M5 4h3.5l2 5-2.4 1.5a11 11 0 0 0 5.4 5.4L15 13.5l5 2V19a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />,
  sparkles: (
    <>
      <path d="M11 3.5 12.8 8l4.7 1.8-4.7 1.8L11 16.2l-1.8-4.6L4.5 9.8 9.2 8z" />
      <path d="m18.5 14.5.8 2 2.2.8-2.2.8-.8 2.1-.8-2.1-2.2-.8 2.2-.8z" />
    </>
  ),
  chat: <path d="M20.5 12a8.5 8.5 0 0 1-12.3 7.6L3.5 21l1.4-4.6A8.5 8.5 0 1 1 20.5 12z" />,
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4M8 14h2M14 14h2M8 17.5h2" />
    </>
  ),
  card: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="M2.5 10h19M6.5 15h4" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
  code: <path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16" />,
  cloud: <path d="M7 18.5a4.5 4.5 0 1 1 .8-8.9A6 6 0 0 1 19.2 11a3.8 3.8 0 0 1-.7 7.5z" />,
  table: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M3 14.5h18M9.5 4v16" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20.5 20.5-4.8-4.8" />
    </>
  ),
  chart: <path d="M4 20V11M10 20V5M16 20v-6.5M21.5 20h-19" />,
  shield: <path d="M12 3.2 19.5 6v5.6c0 4.6-3.1 8-7.5 9.2-4.4-1.2-7.5-4.6-7.5-9.2V6z" />,
  inbox: (
    <>
      <path d="M3 13.5 6 5h12l3 8.5V19H3z" />
      <path d="M3 13.5h5l1.2 2.8h5.6l1.2-2.8h5" />
    </>
  ),
  key: (
    <>
      <circle cx="7.5" cy="15.5" r="4" />
      <path d="m10.4 12.6 9.1-9.1M16 7l2.6 2.6M13.6 9.4l2.2 2.2" />
    </>
  ),
  play: <path d="M7.5 4.5v15L19.5 12z" fill="currentColor" />,
  pause: <path d="M7.5 5v14M16.5 5v14" strokeWidth={3} />,
  next: <path d="m9 5.5 6.5 6.5L9 18.5" />,
  prev: <path d="M15 5.5 8.5 12l6.5 6.5" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  alert: <path d="M12 8v5M12 16.5h.01M10.3 3.9 2.6 17.6A2 2 0 0 0 4.3 20.6h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  wrench: <path d="M14.5 6.5a4.5 4.5 0 0 0 5.6 5.6L13 19.2a2.5 2.5 0 0 1-3.6-3.6l7.1-7.1zM14.5 6.5l-1.6-1.6a4.5 4.5 0 0 1 6.2 6.2" />,
  question: <path d="M9.2 9a3 3 0 1 1 4.3 2.7c-.9.5-1.5 1.2-1.5 2.3M12 17.5h.01" />,
  dot: <circle cx="12" cy="12" r="3" fill="currentColor" />,
  refresh: <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" />,
};

export type AnyIcon = keyof typeof PATHS;

export function Icon({ name, className = "size-4", strokeWidth = 1.8 }: { name: AnyIcon; className?: string; strokeWidth?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

/** The same drawing placed inside another SVG, for the map's line badges. */
export function Glyph({ name, x, y, size, color }: { name: AnyIcon; x: number; y: number; size: number; color: string }) {
  return (
    <g
      transform={`translate(${x - size / 2} ${y - size / 2}) scale(${size / 24})`}
      fill="none"
      stroke={color}
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      color={color}
    >
      {PATHS[name]}
    </g>
  );
}
