import type { FakeApplicationService, SnapshotKey } from '@wechat-agent/ports/fakes';
import { sampleSnapshots } from '@wechat-agent/ports/fakes';

/** Dev-only: switch the Fake service between the sample snapshots. Absent when the real preload is present. */
export function DevStatePanel({ fake, current, onChange }: { fake: FakeApplicationService; current: SnapshotKey; onChange: (k: SnapshotKey) => void }) {
  const keys = Object.keys(sampleSnapshots) as SnapshotKey[];
  return (
    <div className="dev-panel">
      <label>
        Fake 状态
        <select value={current} onChange={(e) => { const k = e.target.value as SnapshotKey; fake.show(k); onChange(k); }}>
          {keys.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </label>
    </div>
  );
}
