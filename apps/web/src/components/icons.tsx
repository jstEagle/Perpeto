/* Outline glyphs from the Perpeto Mono specimen: 24 unit grid, 1.6 strokes, round ends. */
import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 18, children, className, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg className={`i ${className ?? ''}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

const icon = (paths: ReactNode) => (p: IconProps) => <Icon {...p}>{paths}</Icon>;

export const IconOverview = icon(
  <>
    <rect x="4" y="4" width="6.5" height="6.5" rx="2" />
    <rect x="13.5" y="4" width="6.5" height="6.5" rx="2" />
    <rect x="4" y="13.5" width="6.5" height="6.5" rx="2" />
    <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="2" />
  </>,
);
export const IconWorkflow = icon(
  <>
    <rect x="3.5" y="4" width="7" height="6" rx="2" />
    <rect x="13.5" y="14" width="7" height="6" rx="2" />
    <path d="M10.5 7h2a3 3 0 0 1 3 3v4" />
  </>,
);
export const IconRuns = icon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M10.4 9.3v5.4l4.3-2.7z" />
  </>,
);
export const IconWork = icon(<path d="M4.5 7.2l1.6 1.6L9 6M4.5 15.2l1.6 1.6L9 14M12 7.5h7.5M12 15.5h7.5" />);
export const IconMessages = icon(<path d="M5 18.5v-12A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6a2.5 2.5 0 0 1-2.5 2.5H9.2L5 18.5z" />);
export const IconMerge = icon(
  <>
    <circle cx="7" cy="5.5" r="2" />
    <circle cx="7" cy="18.5" r="2" />
    <circle cx="17" cy="12.5" r="2" />
    <path d="M7 7.5v9M7 7.5c0 3.2 2.6 5 8 5" />
  </>,
);
export const IconMachines = icon(
  <>
    <rect x="3.5" y="4.5" width="17" height="11" rx="2.5" />
    <path d="M9 19.5h6M12 15.5v4" />
  </>,
);
export const IconAccounts = icon(
  <>
    <circle cx="9.5" cy="8.5" r="3.2" />
    <path d="M3.8 19a5.7 5.7 0 0 1 11.4 0" />
    <path d="M15.8 5.6a3.2 3.2 0 0 1 0 5.8M17.6 14.3a5.7 5.7 0 0 1 2.6 4.7" />
  </>,
);
export const IconUsage = icon(<path d="M5 19.5v-6M10 19.5v-11M15 19.5v-8M20 19.5v-14" />);
export const IconSettings = icon(
  <>
    <path d="M4 7.5h9M18 7.5h2M4 16.5h2M11 16.5h9" />
    <circle cx="15.5" cy="7.5" r="2.3" />
    <circle cx="8.5" cy="16.5" r="2.3" />
  </>,
);
export const IconPlus = icon(<path d="M12 5.5v13M5.5 12h13" />);
export const IconMinus = icon(<path d="M5.5 12h13" />);
export const IconPause = icon(<path d="M9.5 6.5v11M14.5 6.5v11" />);
export const IconPlay = icon(<path d="M8.5 6.2v11.6l9-5.8z" />);
export const IconStop = icon(<rect x="6.5" y="6.5" width="11" height="11" rx="2.5" />);
export const IconChevronDown = icon(<path d="M7.5 10l4.5 4.5 4.5-4.5" />);
export const IconChevronLeft = icon(<path d="M14 7l-5 5 5 5" />);
export const IconChevronRight = icon(<path d="M10 7l5 5-5 5" />);
export const IconSelector = icon(<path d="M8.5 9.5L12 6l3.5 3.5M8.5 14.5L12 18l3.5-3.5" />);
export const IconArrowRight = icon(<path d="M5.5 12h13M13.5 7l5 5-5 5" />);
export const IconMore = icon(
  <>
    <circle cx="6.5" cy="12" r="1.1" fill="currentColor" />
    <circle cx="12" cy="12" r="1.1" fill="currentColor" />
    <circle cx="17.5" cy="12" r="1.1" fill="currentColor" />
  </>,
);
export const IconMenu = icon(<path d="M5 9h14M5 15h14" />);
export const IconSearch = icon(
  <>
    <circle cx="11" cy="11" r="6" />
    <path d="M19.5 19.5l-4.2-4.2" />
  </>,
);
export const IconClose = icon(<path d="M7 7l10 10M17 7L7 17" />);
export const IconCheck = icon(<path d="M6 12.5l4 4 8-9" />);
export const IconCheckCircle = icon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M8.6 12.3l2.3 2.3 4.6-4.8" />
  </>,
);
export const IconXCircle = icon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9.6 9.6l4.8 4.8M14.4 9.6l-4.8 4.8" />
  </>,
);
export const IconCircle = icon(<circle cx="12" cy="12" r="8" />);
export const IconBlocked = icon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M8.5 12h7" />
  </>,
);
/** Filled: a person should look. */
export const IconAlert = icon(
  <>
    <circle cx="12" cy="12" r="9" fill="currentColor" stroke="none" />
    <path d="M12 7.6v5.2" stroke="var(--surface)" strokeWidth="2" />
    <circle cx="12" cy="16.2" r="1.15" fill="var(--surface)" stroke="none" />
  </>,
);
/** Filled: a person must decide. */
export const IconApproval = icon(
  <>
    <path d="M12 4.2l8.3 14.4a1 1 0 0 1-.9 1.5H4.6a1 1 0 0 1-.9-1.5z" fill="currentColor" stroke="none" />
    <path d="M12 9.5v4.3" stroke="var(--surface)" strokeWidth="2" />
    <circle cx="12" cy="16.6" r="1.1" fill="var(--surface)" stroke="none" />
  </>,
);
export const IconClock = icon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.8V12l2.8 1.8" />
  </>,
);
export const IconInbox = icon(
  <>
    <path d="M4 13.5l2-6.4A2.2 2.2 0 0 1 8.1 5.5h7.8a2.2 2.2 0 0 1 2.1 1.6l2 6.4V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
    <path d="M4.2 13.5h4.3l1.2 2h4.6l1.2-2h4.3" />
  </>,
);
export const IconPlanner = icon(<path d="M5 6.5h14M5 12h9M5 17.5h11" />);
export const IconCode = icon(<path d="M9 7.5L4.5 12 9 16.5M15 7.5l4.5 4.5-4.5 4.5" />);
export const IconReview = icon(
  <>
    <path d="M2.8 12S6.2 6 12 6s9.2 6 9.2 6-3.4 6-9.2 6-9.2-6-9.2-6z" />
    <circle cx="12" cy="12" r="2.6" />
  </>,
);
export const IconCi = icon(
  <>
    <rect x="4.5" y="4.5" width="15" height="15" rx="4" />
    <path d="M8.6 12.3l2.3 2.3 4.6-4.8" />
  </>,
);
export const IconFlag = icon(<path d="M6 20V4.8M6 5.2h10.8l-2.2 3.9 2.2 3.9H6" />);
export const IconLoop = icon(
  <>
    <path d="M18.5 9.5A7 7 0 1 0 19 14" />
    <path d="M14.5 9.5h4.5V5" />
  </>,
);
export const IconPerson = icon(
  <>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" />
  </>,
);
export const IconFit = icon(<path d="M4.5 9V6a1.5 1.5 0 0 1 1.5-1.5h3M15 4.5h3A1.5 1.5 0 0 1 19.5 6v3M19.5 15v3a1.5 1.5 0 0 1-1.5 1.5h-3M9 19.5H6A1.5 1.5 0 0 1 4.5 18v-3" />);
export const IconDoc = icon(
  <>
    <path d="M7.5 3.8h5.8l4.2 4.2v10.7a1.5 1.5 0 0 1-1.5 1.5h-8.5A1.5 1.5 0 0 1 6 18.7V5.3a1.5 1.5 0 0 1 1.5-1.5z" />
    <path d="M13 4v4.3h4.3" />
  </>,
);
export const IconTarget = icon(
  <>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4.3" />
  </>,
);
export const IconSend = icon(<path d="M5 12h12M12.5 7l5 5-5 5" />);
export const IconTrash = icon(<path d="M5 7h14M10 7V5h4v2M7 7l.8 12h8.4L17 7" />);
export const IconEdit = icon(<path d="M15.5 4.5l4 4L9 19H5v-4z" />);
export const IconUndo = icon(<path d="M8.5 5L5 8.5 8.5 12M5 8.5h9a4.5 4.5 0 0 1 0 9H9" />);
export const IconCopy = icon(
  <>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" />
    <path d="M15.5 5.5h-9a1 1 0 0 0-1 1v9" />
  </>,
);
export const IconExternal = icon(<path d="M13.5 5h5.5v5.5M19 5l-8 8M17 13.5V18a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4.5" />);
export const IconSparkPrompt = icon(<path d="M5 18.5v-12A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6a2.5 2.5 0 0 1-2.5 2.5H9.2L5 18.5zM9 8.5h6M9 11.5h4" />);
