/*
 * Spindle symbol and lockup from packages/design-tokens/assets, never
 * redrawn. Ink fills become currentColor so the mark takes the surrounding
 * ink; in the product it is always ink on canvas.
 */
import symbolSvg from '@perpeto/design-tokens/assets/perpeto-symbol-ink.svg?raw';
import lockupSvg from '@perpeto/design-tokens/assets/perpeto-lockup-ink.svg?raw';

function recolor(svg: string) {
  return svg
    .replace(/#161615/gi, 'currentColor')
    .replace(/<title>[^<]*<\/title>/, '')
    .replace(/\swidth="[^"]*"/, ' width="100%"')
    .replace(/\sheight="[^"]*"/, ' height="100%"')
    .replace('<svg ', '<svg aria-hidden="true" focusable="false" ');
}

const SYMBOL = recolor(symbolSvg);
const LOCKUP = recolor(lockupSvg);
/** The lockup asset is 888 × 248 including clearspace. */
const LOCKUP_RATIO = 887.96 / 248;

export function Spindle({ size = 24, className }: { size?: number; className?: string }) {
  return <span className={`spindle ${className ?? ''}`} style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: SYMBOL }} />;
}

/** `height` is the asset's full height, clearspace included. */
export function Lockup({ height = 34 }: { height?: number }) {
  return <span className="lockup" role="img" aria-label="perpeto" style={{ width: height * LOCKUP_RATIO, height }} dangerouslySetInnerHTML={{ __html: LOCKUP }} />;
}

/** Relay loader from brand/motion: arms fade in sequence; static under reduced motion. */
export function SpindleLoader({ size = 32, label = 'Loading' }: { size?: number; label?: string }) {
  return (
    <span className="spindle-loader" style={{ width: size, height: size }} role="status">
      <span className="visually-hidden">{label}</span>
      <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: SYMBOL }} />
    </span>
  );
}
