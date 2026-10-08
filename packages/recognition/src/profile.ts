// Versioned layout profiles. A profile is the frozen `LayoutProfile` plus
// the measured geometry (in points) and the vocabulary the analysis keys on.
// Nothing in the code hard-codes a WeChat version: add a JSON file to add a
// profile.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LayoutProfile, PixelRect, RequestStatus } from '@wechat-agent/ports';

export interface PointRect { x: number; y: number; w: number; h: number }
export interface Point { x: number; y: number }

export interface ProfileLayout {
  rail: PointRect & { chats: Point; contacts: Point };
  search: Point & { clearX: number };
  sidebar: PointRect;
  sectionHeaderX: number;
  newFriendsHeader: Point;
  pane: PointRect;
  request: { nameX: number; statusX: number; rowHeight: number; noteOffset: number };
  chat: { nameX: number; timeX: number; rowHeight: number; badgeX: number };
  conversation: { titleMaxY: number; bubbleTop: number; input: PointRect; avatarInset: number };
  theme: { samples: PointRect[]; darkMaxLuma: number; lightMinLuma: number };
  scrollbar: { x: number; w: number; minRunPoints: number; minLuma: number };
}

export interface ProfileVocabulary {
  statuses: Record<string, RequestStatus>;
  endMarkers: string[];
  buttons: string[];
  sectionHeaders: string[];
  addFriendCues: string[];
  searchCues: string[];
  requestDetailCues: string[];
  contactDetailCues: string[];
}

export interface WeChatLayoutProfile extends LayoutProfile {
  /** Points of window size the capture may differ by and still count as this profile. */
  sizeTolerancePoints: number;
  layout: ProfileLayout;
  vocabulary: ProfileVocabulary;
}

export const PROFILES_DIR = resolve(import.meta.dirname, '../profiles');

export function loadProfiles(dir = PROFILES_DIR): WeChatLayoutProfile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => parseProfile(readFileSync(join(dir, f), 'utf8'), f));
}

export function parseProfile(json: string, source = 'profile'): WeChatLayoutProfile {
  const p = JSON.parse(json) as WeChatLayoutProfile;
  for (const key of ['profileId', 'revision', 'app', 'appVersionRange', 'window', 'scale', 'theme', 'layout', 'vocabulary'] as const) {
    if (p[key] === undefined) throw new Error(`${source}: profile lacks ${key}`);
  }
  if (p.app !== 'wechat-mac') throw new Error(`${source}: unsupported app ${p.app}`);
  if (p.theme !== 'dark' && p.theme !== 'light') throw new Error(`${source}: bad theme ${String(p.theme)}`);
  p.sizeTolerancePoints ??= 0;
  return p;
}

/** The public, frozen part of a profile (what `Recognizer.profiles()` hands out). */
export function publicProfile(p: WeChatLayoutProfile): LayoutProfile {
  const { profileId, revision, app, appVersionRange, window, scale, theme } = p;
  return { profileId, revision, app, appVersionRange, window, scale, theme };
}

/** Converts the profile's point geometry to the pixels of a capture at the profile's scale. */
export class Geometry {
  constructor(readonly profile: WeChatLayoutProfile) {}
  get scale() { return this.profile.scale; }
  /** Points to pixels. */
  px(points: number): number { return points * this.profile.scale; }
  rect(r: PointRect): PixelRect { return { x: this.px(r.x), y: this.px(r.y), width: this.px(r.w), height: this.px(r.h) }; }
  get sidebar() { return this.rect(this.profile.layout.sidebar); }
  get pane() { return this.rect(this.profile.layout.pane); }
  get input() { return this.rect(this.profile.layout.conversation.input); }
  get imageWidth() { return this.px(this.profile.window.width); }
  get imageHeight() { return this.px(this.profile.window.height); }
}
