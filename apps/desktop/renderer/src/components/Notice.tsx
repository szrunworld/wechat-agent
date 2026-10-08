import type { Tone } from './StatusBadge.tsx';

const GLYPH: Record<Tone, string> = { ok: '✓', info: 'ℹ', warn: '⚠', danger: '✕', neutral: '●' };

/** A block-level message. `role=alert` only for danger so screen readers are not flooded. */
export function Notice({ tone, title, children }: { tone: Tone; title: string; children?: React.ReactNode }) {
  return (
    <div className={`notice tone-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <div className="notice-title"><span aria-hidden="true">{GLYPH[tone]}</span> {title}</div>
      {children ? <div className="notice-body">{children}</div> : null}
    </div>
  );
}
