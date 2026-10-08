// A state label that always carries a glyph and text; colour is secondary.
export type Tone = 'ok' | 'info' | 'warn' | 'danger' | 'neutral';

const GLYPH: Record<Tone, string> = { ok: '✓', info: 'ℹ', warn: '⚠', danger: '✕', neutral: '●' };

export function StatusBadge({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span className={`badge tone-${tone}`} title={title}>
      <span className="badge-glyph" aria-hidden="true">{GLYPH[tone]}</span>
      <span>{children}</span>
    </span>
  );
}
