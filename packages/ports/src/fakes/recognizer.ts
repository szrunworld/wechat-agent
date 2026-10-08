import type { Id } from '../domain.ts';
import type { Applicability, ImageInput, ImageMeta, LayoutProfile, PageFacts, Recognizer } from '../recognizer.ts';

export const FAKE_PROFILE: LayoutProfile = { profileId: 'wechat-4.1-1280x875-2x-dark', revision: 1, app: 'wechat-mac', appVersionRange: '4.1.x', window: { width: 1280, height: 875 }, scale: 2, theme: 'dark' };

/** Hands out scripted PageFacts in order (the last repeats); records what it was asked to read. */
export class FakeRecognizer implements Recognizer {
  readonly reads: ImageMeta[] = [];
  private index = 0;

  constructor(readonly scripted: PageFacts[] = [], readonly profile: LayoutProfile = FAKE_PROFILE, readonly applicable = true) {}

  profiles(): LayoutProfile[] {
    return [this.profile];
  }

  applicability(_image: ImageMeta, _preferred?: Id): Applicability {
    return this.applicable ? { applicable: true, profile: this.profile } : { applicable: false, reason: 'size_mismatch' };
  }

  async recognize(image: ImageInput, profile: LayoutProfile): Promise<PageFacts> {
    this.reads.push(image);
    const facts = this.scripted[Math.min(this.index, this.scripted.length - 1)];
    this.index += 1;
    if (!facts) return { page: 'unknown', coverage: 'unreadable', profileId: profile.profileId, buttons: [], texts: [], warnings: ['no scripted facts'], confidence: 0, evidenceRef: {} };
    return { ...facts, profileId: profile.profileId };
  }
}

/** A PageFacts skeleton for tests. */
export function pageFacts(partial: Partial<PageFacts> & { page: PageFacts['page'] }): PageFacts {
  return { coverage: 'current_viewport', profileId: FAKE_PROFILE.profileId, buttons: [], texts: [], warnings: [], confidence: 0.9, evidenceRef: {}, ...partial };
}
