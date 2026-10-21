/* Utility glyphs: 16 px grid, 1.5 px strokes, square ends to match the ruled surfaces. */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="square" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

export const IconPlus = (p: IconProps) => <Icon {...p}><path d="M8 3v10M3 8h10" /></Icon>;
export const IconArrowRight = (p: IconProps) => <Icon {...p}><path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" /></Icon>;
export const IconChevronRight = (p: IconProps) => <Icon {...p}><path d="m6 3.5 4.5 4.5L6 12.5" /></Icon>;
export const IconChevronDown = (p: IconProps) => <Icon {...p}><path d="M3.5 6 8 10.5 12.5 6" /></Icon>;
export const IconClose = (p: IconProps) => <Icon {...p}><path d="m4 4 8 8M12 4l-8 8" /></Icon>;
export const IconCheck = (p: IconProps) => <Icon {...p}><path d="m3 8.5 3.2 3L13 4.5" /></Icon>;
export const IconPause = (p: IconProps) => <Icon {...p}><path d="M5.5 3.5v9M10.5 3.5v9" /></Icon>;
export const IconPlay = (p: IconProps) => <Icon {...p}><path d="M4.5 3v10l8-5z" strokeLinejoin="round" /></Icon>;
export const IconStop = (p: IconProps) => <Icon {...p}><rect x="4" y="4" width="8" height="8" /></Icon>;
export const IconCopy = (p: IconProps) => <Icon {...p}><rect x="5.5" y="5.5" width="7.5" height="7.5" /><path d="M10.5 3H3v7.5" /></Icon>;
export const IconExternal = (p: IconProps) => <Icon {...p}><path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5" /></Icon>;
export const IconMenu = (p: IconProps) => <Icon {...p}><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" /></Icon>;
export const IconSend = (p: IconProps) => <Icon {...p}><path d="M2.5 8h9M8 4.5 11.5 8 8 11.5M13.5 3v10" /></Icon>;
export const IconTrash = (p: IconProps) => <Icon {...p}><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5" /></Icon>;
export const IconSettings = (p: IconProps) => <Icon {...p}><path d="M2.5 4.5h4M9.5 4.5h4M2.5 11.5h7M12.5 11.5h1" /><rect x="6.5" y="3" width="3" height="3" /><rect x="9.5" y="10" width="3" height="3" /></Icon>;
export const IconFit = (p: IconProps) => <Icon {...p}><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /></Icon>;
export const IconMinus = (p: IconProps) => <Icon {...p}><path d="M3 8h10" /></Icon>;
export const IconAlert = (p: IconProps) => <Icon {...p}><path d="M8 2.5 14 13H2z" strokeLinejoin="round" /><path d="M8 6.5v3M8 11v.5" /></Icon>;
export const IconUndo = (p: IconProps) => <Icon {...p}><path d="M5.5 3 2.5 6l3 3" /><path d="M2.5 6h7a3.5 3.5 0 0 1 0 7H6" /></Icon>;
export const IconEdit = (p: IconProps) => <Icon {...p}><path d="M10.5 2.5 13.5 5.5 6 13H3v-3z" strokeLinejoin="round" /></Icon>;
