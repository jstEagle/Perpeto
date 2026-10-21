/*
 * Spindle symbol and wordmark, rendered from the unchanged identity SVGs in
 * brand/identity (copied here until packages/design-tokens/assets lands).
 * Black fills become currentColor so the mark takes the surrounding ink.
 */
import symbolSvg from './perpeto-symbol.svg?raw';
import wordmarkSvg from './perpeto-wordmark.svg?raw';

function recolor(svg: string) {
  return svg
    .replace(/#000000/g, 'currentColor')
    .replace(/<title>[^<]*<\/title>/, '')
    .replace(/\swidth="[^"]*"\s+height="[^"]*"/, ' width="100%" height="100%"')
    .replace('<svg ', '<svg aria-hidden="true" focusable="false" ');
}

const SYMBOL = recolor(symbolSvg);
const WORDMARK = recolor(wordmarkSvg);

export function Spindle({ size = 24, className }: { size?: number; className?: string }) {
  return <span className={`spindle ${className ?? ''}`} style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: SYMBOL }} />;
}

export function Lockup({ height = 22 }: { height?: number }) {
  // Wordmark viewBox is 3530 × 903; the symbol sits at the wordmark's cap height.
  const wordWidth = (height * 3530) / 903;
  return (
    <span className="lockup" role="img" aria-label="perpeto">
      <Spindle size={Math.round(height * 1.1)} />
      <span className="wordmark" style={{ width: wordWidth, height }} dangerouslySetInnerHTML={{ __html: WORDMARK }} />
    </span>
  );
}

/** Relay loader from brand/motion: arms pulse in sequence; static under reduced motion. */
export function SpindleLoader({ size = 20, label = 'Loading' }: { size?: number; label?: string }) {
  return (
    <span className="spindle-loader" style={{ width: size, height: size }} role="status">
      <span className="visually-hidden">{label}</span>
      <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: SYMBOL }} />
    </span>
  );
}
