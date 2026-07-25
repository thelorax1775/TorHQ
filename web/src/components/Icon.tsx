/** Hand-rolled 24px stroke icon set — no icon dependency. */
import type { ReactNode } from "react";

const PATHS = {
  dashboard: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></>,
  download: <><path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M4 20h16" /></>,
  queue: <><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></>,
  star: <><path d="m12 3.4 2.7 5.7 6 .9-4.4 4.3 1 6.3-5.3-2.9-5.3 2.9 1-6.3L3.3 10l6-.9z" /></>,
  inbox: <><path d="M3 12h5l2 3h4l2-3h5" /><path d="M5.6 4.5h12.8l2.6 7.5v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5.2l3.2 2" /></>,
  book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v18H6.5A2.5 2.5 0 0 1 4 18.5z" /><path d="M8 3v18" /></>,
  server: <><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>,
  plug: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2.1" /><circle cx="15" cy="12" r="2.1" /><circle cx="8" cy="18" r="2.1" /></>,
  settings: <><circle cx="12" cy="12" r="3.2" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1" /></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  refresh: <><path d="M20.5 12a8.5 8.5 0 1 1-2.5-6" /><path d="M20.5 3.5V9H15" /></>,
  check: <><path d="m5 13 4.5 4.5L19.5 7" /></>,
  alert: <><path d="M12 4.2 2.9 20h18.2z" /><path d="M12 10v4M12 17.2h.01" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.8h.01" /></>,
  external: <><path d="M14 4h6v6" /><path d="M20 4 11.5 12.5" /><path d="M18 14.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.5" /></>,
  pause: <><path d="M9.5 5v14M14.5 5v14" /></>,
  play: <><path d="M7.5 4.8 19 12 7.5 19.2z" /></>,
  trash: <><path d="M4 7h16" /><path d="M9.5 7V4.6h5V7" /><path d="m6.4 7 1 12.4a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5L17.6 7" /></>,
  up: <><path d="M12 19.5V5" /><path d="m6 11 6-6 6 6" /></>,
  down: <><path d="M12 4.5V19" /><path d="m6 13 6 6 6-6" /></>,
  logout: <><path d="M14.5 4H18a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3.5" /><path d="m9.5 8-4 4 4 4" /><path d="M5.5 12h9" /></>,
  folder: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2.2h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  copy: <><rect x="9" y="9" width="11.5" height="11.5" rx="2" /><path d="M5 15.5V5.5a2 2 0 0 1 2-2h8" /></>,
  send: <><path d="M21 3 3 10.4l7.2 3.2L13.4 21z" /><path d="m10.2 13.6 4-4" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3.2 12h17.6" /><path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18" /></>,
  activity: <><path d="M3 12.5h4l3 7.5 4-16 3 8.5h4" /></>,
  shield: <><path d="M12 3 5 6v6c0 4.4 3 7.7 7 9 4-1.3 7-4.6 7-9V6z" /><path d="m9.2 12 2 2 3.6-3.6" /></>,
  filter: <><path d="M3.5 5.5h17l-6.6 7.7V20l-3.8-2.2v-4.6z" /></>,
  chevron: <><path d="m6 9.5 6 6 6-6" /></>,
  link: <><path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 1 0-5.7-5.7l-1.3 1.3" /><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 1 0 5.7 5.7l1.3-1.3" /></>,
  sliders: <><path d="M4 8h11M19 8h1M4 16h4M12 16h8" /><circle cx="17" cy="8" r="2" /><circle cx="10" cy="16" r="2" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
