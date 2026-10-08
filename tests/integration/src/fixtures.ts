// Synthetic fixtures for the integration slice. Names are made up; no real
// WeChat data, no real screenshots. Coordinates are image pixels (2x capture
// of a 1280x875 window), as the Recognizer port requires.
import type { Coverage, ImageInput, LayoutProfile, Observation, PageFacts, PixelRect, RequestRow, RequestStatus } from '@wechat-agent/ports';
import { FakeRecognizer } from '@wechat-agent/ports/fakes';

export const T0 = '2026-10-08T02:00:00.000Z';

/** A deterministic clock: every call moves one second forward. */
export function clock(start = T0): { now(): string; peek(): string; advance(seconds: number): void } {
  let t = Date.parse(start);
  return {
    now() { t += 1000; return new Date(t).toISOString(); },
    peek() { return new Date(t).toISOString(); },
    advance(seconds) { t += seconds * 1000; },
  };
}

export function observation(over: Partial<Observation> = {}): Observation {
  return {
    snapshotId: 'snap_fixture',
    desktopId: 'desk_fake',
    capturedAt: T0,
    screen: { width: 1280, height: 875, scale: 2 },
    target: { generation: 1, process: { pid: 777, startedAt: T0 }, windowId: 11, windowFrame: { x: 0, y: 25, width: 1280, height: 875 }, title: '微信' },
    image: { artifactId: 'art_fixture', mediaType: 'image/png', width: 2560, height: 1750, byteSize: 4, sha256: 'ab'.repeat(32), transform: { originX: 0, originY: 25, scale: 2 } },
    elements: [],
    ...over,
  };
}

export function pageFacts(partial: Partial<PageFacts> & { page: PageFacts['page'] }): PageFacts {
  return { coverage: 'current_viewport', profileId: 'fixture', buttons: [], texts: [], warnings: [], confidence: 0.9, evidenceRef: {}, ...partial };
}

export function requestRow(name: string, status: RequestStatus, over: Partial<RequestRow> = {}): RequestRow {
  const rect: PixelRect = over.rect ?? { x: 600, y: 300, width: 1200, height: 120 };
  return {
    name, note: `你好，我是${name}`, status, rect,
    actionRect: status === 'pending' ? { x: rect.x + rect.width - 200, y: rect.y + 30, width: 140, height: 60 } : undefined,
    confidence: 0.92, rowKey: `${name}|${name}`,
    ...over,
  };
}

export function newFriendsPage(rows: RequestRow[], coverage: Coverage = 'current_viewport'): PageFacts {
  return pageFacts({ page: 'new_friends', requests: rows, coverage });
}

/** The common accept-request script: pending before approval, pending again after re-observe, added after the click. */
export function acceptScript(name = '测试联系人甲'): PageFacts[] {
  return [
    newFriendsPage([requestRow(name, 'pending')]),
    newFriendsPage([requestRow(name, 'pending', { rect: { x: 600, y: 420, width: 1200, height: 120 } })]),
    newFriendsPage([requestRow(name, 'added')]),
  ];
}

/**
 * A FakeRecognizer whose n-th recognize call can be held until the test
 * releases it. Every handler must read pixels through this port, so it is a
 * timing hook that survives swapping the stub handlers for the real ones.
 */
export class GatedRecognizer extends FakeRecognizer {
  private count = 0;
  private holds = new Map<number, { gate: Promise<void>; release: () => void; reached: Promise<void>; markReached: () => void }>();

  constructor(scripted: PageFacts[] = []) {
    super(scripted);
  }

  /** Hold the n-th recognize (1-based). `reached` resolves when the handler arrives there. */
  hold(call: number): { release(): void; reached: Promise<void> } {
    let release!: () => void;
    let markReached!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const reached = new Promise<void>((r) => { markReached = r; });
    this.holds.set(call, { gate, release, reached, markReached });
    return { release, reached };
  }

  override async recognize(image: ImageInput, profile: LayoutProfile): Promise<PageFacts> {
    this.count += 1;
    const hold = this.holds.get(this.count);
    if (hold) {
      hold.markReached();
      await hold.gate;
    }
    return super.recognize(image, profile);
  }
}
