import { useId } from 'react';
import type { Decision } from '../rules.ts';

/**
 * A primary control. When the decision denies it, the button is disabled and the
 * reasons are rendered next to it (and linked via aria-describedby), so a greyed
 * button never leaves the person guessing.
 */
export function ActionButton({ decision, onClick, children, busy = false, kind = 'primary' }: {
  decision: Decision; onClick: () => void; children: React.ReactNode; busy?: boolean; kind?: 'primary' | 'secondary' | 'danger';
}) {
  const id = useId();
  const disabled = !decision.ok || busy;
  return (
    <span className="action">
      <button type="button" className={`btn btn-${kind}`} disabled={disabled} aria-describedby={decision.ok ? undefined : id} aria-busy={busy} onClick={onClick}>
        {busy ? '处理中…' : children}
      </button>
      {!decision.ok ? (
        <span className="action-reasons" id={id}>
          不可用：{decision.reasons.join('；')}
        </span>
      ) : null}
    </span>
  );
}
