// Pixels to domain facts (方案 §06 Recognition). Lane C implements it; lanes
// D and H consume it. Coordinates are IMAGE PIXELS of the observed artifact,
// never window points or global points: the platform converts imagePoint.

import type { Coverage, Id } from './domain.ts';

export interface LayoutProfile {
  profileId: Id;
  revision: number;
  app: 'wechat-mac';
  /** e.g. "4.1.x" */
  appVersionRange: string;
  /** Window size in points the measurements assume. */
  window: { width: number; height: number };
  /** Pixels per point the measurements assume. */
  scale: number;
  theme: 'dark' | 'light';
}

export interface ImageMeta {
  width: number;
  height: number;
  /** Pixels per point of the capture (from ImageTransform.scale). */
  scale: number;
  artifactId?: Id;
  sha256?: string;
  windowFrame?: { width: number; height: number };
  windowTitle?: string;
}

export interface ImageInput extends ImageMeta {
  path?: string;
  bytes?: Uint8Array;
}

export type PageKind =
  | 'chats' | 'contacts' | 'new_friends' | 'request_detail' | 'contact_detail' | 'chat'
  | 'search_results' | 'add_friend' | 'dialog' | 'unknown';

export interface PixelRect { x: number; y: number; width: number; height: number }
export interface PixelPoint { x: number; y: number }

export interface TextItem { text: string; rect: PixelRect; confidence: number }

export type RequestStatus = 'pending' | 'added' | 'expired' | 'waiting_verification' | 'rejected' | 'unknown';

export interface RequestRow {
  name: string;
  note: string;
  status: RequestStatus;
  rect: PixelRect;
  /** The accept control, when the row shows one (a green button is a hint, not proof: T15). */
  actionRect?: PixelRect;
  confidence: number;
  /** Stable-ish key for suppression/dedup: name + note, normalised. Not identity. */
  rowKey: string;
}

export interface ChatRow { name: string; time: string; preview: string; unread: boolean; rect: PixelRect; confidence: number }

export interface Bubble {
  side: 'self' | 'other';
  text: string;
  rect: PixelRect;
  /** Position-and-text anchor for before/after comparison (T26); not stable across scrolls. */
  anchorKey: string;
  confidence: number;
}

export interface ButtonHit { text: string; rect: PixelRect; confidence: number }

export interface InputBox { rect: PixelRect; text: string; empty: boolean; confidence: number }

export interface DetailPane {
  name: string;
  wechatId?: string;
  region?: string;
  message?: string;
  buttons: ButtonHit[];
  confidence: number;
}

export interface PageFacts {
  page: PageKind;
  coverage: Coverage;
  profileId: Id;
  requests?: RequestRow[];
  chats?: ChatRow[];
  detail?: DetailPane;
  /** The open chat's title bar, on chat pages. */
  conversation?: { title: string; rect: PixelRect };
  bubbles?: Bubble[];
  inputBox?: InputBox;
  buttons: ButtonHit[];
  texts: TextItem[];
  warnings: string[];
  /** Overall 0..1; per-item confidences are what handlers act on. */
  confidence: number;
  evidenceRef: { artifactId?: Id; sha256?: string };
}

export type Applicability =
  | { applicable: true; profile: LayoutProfile }
  | { applicable: false; reason: 'size_mismatch' | 'scale_mismatch' | 'theme_mismatch' | 'unknown_version' | 'no_profile' };

export interface Recognizer {
  profiles(): LayoutProfile[];
  /** Which profile fits this capture, if any. Unreadable captures must not be guessed at. */
  applicability(image: ImageMeta, preferred?: Id): Applicability;
  recognize(image: ImageInput, profile: LayoutProfile): Promise<PageFacts>;
}
