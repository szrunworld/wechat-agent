// From text boxes and colour samples to PageFacts. Pure: no I/O, no
// subprocess, nothing that could touch WeChat. Coordinates in and out are
// image pixels; the profile's point geometry is scaled through `Geometry`.
import type {
  Bubble, ButtonHit, ChatRow, Coverage, DetailPane, InputBox, PageFacts, PageKind, PixelRect, RequestRow, RequestStatus, TextItem,
} from '@wechat-agent/ports';
import { Geometry, type WeChatLayoutProfile } from './profile.ts';
import { NO_PIXELS, type Sampler } from './png.ts';
import { bottom, byPosition, centreX, centreY, inside, isTruncated, norm, right, roundRect, sameLine, union, untruncate } from './text.ts';

export interface AnalyzeInput {
  texts: TextItem[];
  sampler?: Sampler;
  evidenceRef?: PageFacts['evidenceRef'];
  /** Warnings the caller already collected (theme, decode). */
  warnings?: string[];
}

/**
 * PageFacts plus the `conversation` field the coordinator announced for the
 * port (chat page title). Structurally a PageFacts, so it flows through the
 * frozen interface unchanged until ports adds the field.
 */
export type PageFactsWithConversation = PageFacts & { conversation?: { title: string; rect: PixelRect } };

export interface RequestSection {
  rows: RequestRow[];
  coverage: Coverage;
  warnings: string[];
}

/** Keeps a 0..1 confidence a number. */
const clamp01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

const mean = (ns: number[]) => (ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0);

/** Converts the OCR confidence of a text, which Vision reports 0..1. */
const conf = (t: TextItem) => clamp01(t.confidence);

/**
 * The 新的朋友 rows of the contacts sidebar. Rows start below the 新的朋友
 * header and end at the next section header (群聊, 联系人…), which sits
 * further left than the names. `status` comes from text only; green is a
 * hint for `actionRect` and warnings (T15).
 */
export function requestSection(texts: TextItem[], profile: WeChatLayoutProfile, sampler: Sampler = NO_PIXELS): RequestSection | undefined {
  const g = new Geometry(profile);
  const L = profile.layout, V = profile.vocabulary;
  const nameX = g.px(L.request.nameX), statusX = g.px(L.request.statusX), noteOffset = g.px(L.request.noteOffset);
  const sidebar = g.sidebar;
  const sorted = texts.filter((t) => t.rect.x < right(sidebar)).sort(byPosition);
  const header = sorted.find((t) => norm(t.text).includes('新的朋友') && t.rect.x < nameX);
  if (!header) return undefined;
  const warnings: string[] = [];
  const below = sorted.filter((t) => t.rect.y > bottom(header.rect));
  const statusWords = new Set(Object.keys(V.statuses));
  const next = below.find((t) => t.rect.x < nameX - g.px(20) && t.rect.x > header.rect.x - g.px(15) && !statusWords.has(untruncate(t.text)));
  const rows = next ? below.filter((t) => t.rect.y < next.rect.y) : below;
  const endMarker = rows.find((t) => V.endMarkers.some((m) => norm(t.text).includes(m)));
  const names = rows.filter((t) => Math.abs(t.rect.x - nameX) < g.px(12) && t.rect.height >= g.px(11) && t !== endMarker);

  const out: RequestRow[] = [];
  let lastNameY = -Infinity;
  for (const word of names) {
    // A note sits under its name, in the same column but smaller and dimmer.
    if (word.rect.y - lastNameY < noteOffset + g.px(4) && word.rect.y - lastNameY > 0) continue;
    let name = word.text.trim();
    let statusText: string | undefined;
    let statusItem = rows.find((t) => t !== word && t.rect.x >= statusX && sameLine(t, word, g.px(9)));
    if (statusItem) statusText = statusItem.text.trim();
    // A long name runs into its status, so Vision reads them as one line.
    if (!statusText) {
      const tail = [...statusWords].find((s) => untruncate(name).endsWith(s));
      if (tail) {
        statusText = tail;
        const head = name.slice(0, name.lastIndexOf(tail.slice(0, 1)));
        name = head.replace(/[\s•·.…]+$/, '').trim() + (/[.…]{2,}\s*$|…\s*$/.test(head) ? '…' : '');
        statusItem = undefined;
      }
    }
    const noteItem = rows.find((t) => Math.abs(t.rect.x - nameX) < g.px(12) && t.rect.y > word.rect.y + g.px(8) && t.rect.y < word.rect.y + noteOffset + g.px(12));
    const note = noteItem?.text.trim() ?? '';
    const statusKey = statusText ? untruncate(statusText) : '';
    const status: RequestStatus = statusKey ? (V.statuses[statusKey] ?? 'unknown') : 'unknown';
    if (statusKey && !V.statuses[statusKey]) warnings.push(`row "${name}": unrecognised status text "${statusKey}"`);

    const rowCentreY = centreY(word.rect) + g.px(10);
    const rect = roundRect({ x: sidebar.x, y: rowCentreY - g.px(L.request.rowHeight) / 2, width: sidebar.width, height: g.px(L.request.rowHeight) });
    const controlArea: PixelRect = { x: statusX - g.px(8), y: centreY(word.rect) - g.px(18), width: right(sidebar) - statusX + g.px(4), height: g.px(36) };
    const green = sampler.greenBounds(controlArea, 0.12);

    let actionRect: PixelRect | undefined;
    if (status === 'pending') {
      // Text proves the control; green only refines where it is.
      const textRect = statusItem ? statusItem.rect : { x: statusX, y: centreY(word.rect) - g.px(12), width: g.px(48), height: g.px(24) };
      actionRect = roundRect(green ? union(green, textRect) : textRect);
      if (!green && sampler !== NO_PIXELS) warnings.push(`row "${name}": 接受 text without a green control; actionRect is the text box`);
    } else if (green) {
      warnings.push(`row "${name}": green at the status column but status text is "${statusKey || '(none)'}"; not treated as pending`);
    }
    if (!statusKey) warnings.push(`row "${name}": no status text; status unknown`);

    let confidence = conf(word);
    if (statusItem) confidence = Math.min(confidence, conf(statusItem));
    if (isTruncated(name)) { confidence *= 0.8; warnings.push(`row "${name}": name is cut short`); }
    if (!statusKey) confidence *= 0.7;

    out.push({ name, note, status, rect, ...(actionRect ? { actionRect } : {}), confidence: clamp01(confidence), rowKey: `${untruncate(name)}|${norm(note)}` });
    lastNameY = word.rect.y;
  }

  // Same name twice is a fact the handler must see, not a lower score.
  const seen = new Map<string, number>();
  for (const r of out) seen.set(untruncate(r.name), (seen.get(untruncate(r.name)) ?? 0) + 1);
  for (const [n, c] of seen) if (c > 1) warnings.push(`duplicate name "${n}" (${c} rows)`);

  // Coverage of the list, not of the screen.
  let coverage: Coverage = 'current_viewport';
  const cut = rows.some((t) => bottom(t.rect) > bottom(sidebar) - g.px(6));
  const thumb = scrollbarVisible(sampler, profile);
  if (endMarker || next) coverage = 'end_confirmed';
  if (cut || thumb) {
    coverage = 'partial';
    warnings.push(cut ? 'list reaches the bottom edge; rows may continue' : 'scrollbar thumb visible; rows may continue');
  }
  return { rows: out, coverage, warnings };
}

/** A lighter vertical run at the sidebar's right edge, where the thumb sits. */
export function scrollbarVisible(sampler: Sampler, profile: WeChatLayoutProfile): boolean {
  if (sampler === NO_PIXELS) return false;
  const g = new Geometry(profile);
  const S = profile.layout.scrollbar, sidebar = g.sidebar;
  const step = g.px(10);
  let run = 0;
  for (let y = sidebar.y; y < bottom(sidebar); y += step) {
    const luma = sampler.meanLuma({ x: g.px(S.x), y, width: g.px(S.w), height: step });
    // Lighter than the row beside it: a selected row's highlight runs under the strip too and is not a thumb.
    const beside = sampler.meanLuma({ x: g.px(S.x) - g.px(12), y, width: g.px(10), height: step });
    run = luma >= S.minLuma && luma - beside >= 30 ? run + step : 0;
    if (run >= g.px(S.minRunPoints)) return true;
  }
  return false;
}

/** The chat list rows of the chats sidebar, newest first as WeChat shows them. */
export function chatRows(texts: TextItem[], profile: WeChatLayoutProfile, sampler: Sampler = NO_PIXELS): ChatRow[] {
  const g = new Geometry(profile);
  const L = profile.layout.chat, sidebar = g.sidebar;
  const nameX = g.px(L.nameX), timeX = g.px(L.timeX);
  const sorted = texts.filter((t) => t.rect.x < right(sidebar)).sort(byPosition);
  const stamp = /^[\d:/\s年月日昨天前星期一二三四五六]+$/;
  const out: ChatRow[] = [];
  for (const name of sorted.filter((t) => Math.abs(t.rect.x - nameX) < g.px(12) && t.rect.height >= g.px(13))) {
    let text = name.text.trim();
    let timeItem = sorted.find((t) => t !== name && t.rect.x > timeX && sameLine(t, name, g.px(9)) && stamp.test(norm(t.text)));
    let time = timeItem?.text.trim();
    if (!time) {
      // A long name runs into its time, so Vision reads them as one line.
      const tail = text.match(/\s((?:昨天|星期[一二三四五六日]|\d{1,4}[/年]\d{1,2}[/月]?\d{0,2}日?)?\s?(?:\d{1,2}:\d{2})?)$/);
      if (!tail || !tail[1].trim()) continue;
      time = tail[1].trim();
      text = text.slice(0, tail.index).replace(/[\s•·.…]+$/, '').trim();
    }
    if (out.some((row) => Math.abs(centreY(row.rect) - centreY(name.rect)) < g.px(10))) continue;
    const preview = sorted.find((t) => Math.abs(t.rect.x - nameX) < g.px(12) && t.rect.y > name.rect.y + g.px(8) && t.rect.y < name.rect.y + g.px(36));
    const rowCentre = centreY(name.rect) + g.px(10);
    const rect = roundRect({ x: sidebar.x, y: rowCentre - g.px(L.rowHeight) / 2, width: sidebar.width, height: g.px(L.rowHeight) });
    // Unread: a count printed at the badge column, or the red badge itself.
    const badgeArea: PixelRect = { x: g.px(L.badgeX), y: rect.y, width: right(sidebar) - g.px(L.badgeX), height: rect.height };
    const count = sorted.find((t) => t !== name && t !== timeItem && /^\d{1,3}$/.test(norm(t.text)) && inside(t.rect, badgeArea));
    const unread = Boolean(count) || sampler.shares(badgeArea).red > 0.01;
    let confidence = conf(name);
    if (timeItem) confidence = Math.min(confidence, conf(timeItem));
    if (isTruncated(name.text)) confidence *= 0.8;
    out.push({ name: text, time, preview: preview?.text.trim() ?? '', unread, rect, confidence: clamp01(confidence) });
  }
  return out;
}

const DETAIL_MESSAGE = /^(验证消息|验证信息|留言|对方消息)[:：]?/;

/** The contact or request shown in the pane to the right of the sidebar. */
export function detailPane(texts: TextItem[], profile: WeChatLayoutProfile): DetailPane | undefined {
  const g = new Geometry(profile);
  const pane = g.pane;
  const inPane = texts.filter((t) => t.rect.x > pane.x).sort(byPosition);
  if (inPane.length === 0) return undefined;
  const title = inPane.find((t) => t.rect.height >= g.px(14) && t.rect.y < g.px(120));
  if (!title) return undefined;
  const value = (label: string) => {
    const item = inPane.find((t) => norm(t.text).startsWith(label));
    if (!item) return undefined;
    const rest = norm(item.text).slice(label.length).replace(/^[:：]/, '');
    if (rest) return rest;
    // The value may be its own word, to the right.
    return inPane.find((t) => t !== item && sameLine(t, item, g.px(9)) && t.rect.x > item.rect.x)?.text.trim();
  };
  const buttons = buttonHits(inPane, profile);
  const message = inPane.find((t) => DETAIL_MESSAGE.test(norm(t.text)));
  const fields = [title, ...inPane.filter((t) => /^(微信号|地区)/.test(norm(t.text)))];
  return {
    name: title.text.replace(/[\s\u2022]+$/, '').trim(),
    wechatId: value('微信号'),
    region: value('地区'),
    message: message ? norm(message.text).replace(DETAIL_MESSAGE, '') : undefined,
    buttons,
    confidence: clamp01(Math.min(...fields.map(conf))),
  };
}

/** Every text that reads as one of the profile's button labels. */
export function buttonHits(texts: TextItem[], profile: WeChatLayoutProfile): ButtonHit[] {
  const labels = new Set(profile.vocabulary.buttons);
  return texts.filter((t) => labels.has(norm(t.text))).map((t) => ({ text: norm(t.text), rect: roundRect(t.rect), confidence: conf(t) }));
}

const TIME_SEPARATOR = /^(\d{1,2}:\d{2}|昨天|星期[一二三四五六日]|\d{1,4}[/年-]\d{1,2}([/月-]\d{1,2})?日?)(\s*\d{1,2}:\d{2})?$/;

/**
 * Message bubbles of an open conversation. Side comes from where the text
 * sits (self is right-aligned, other left-aligned); the bubble's colour only
 * confirms or warns. Consecutive lines on the same side close together are
 * one bubble.
 */
export function bubbles(texts: TextItem[], profile: WeChatLayoutProfile, sampler: Sampler = NO_PIXELS, warnings: string[] = []): Bubble[] {
  const g = new Geometry(profile);
  const C = profile.layout.conversation, pane = g.pane, input = g.input;
  const area: PixelRect = { x: pane.x, y: g.px(C.bubbleTop), width: pane.width, height: input.y - g.px(C.bubbleTop) };
  const lines = texts.filter((t) => inside(t.rect, area) && !TIME_SEPARATOR.test(norm(t.text))).sort(byPosition);
  const leftEdge = pane.x + g.px(C.avatarInset), rightEdge = right(pane) - g.px(C.avatarInset);
  type Draft = { side: Bubble['side']; parts: TextItem[]; rect: PixelRect };
  const drafts: Draft[] = [];
  for (const line of lines) {
    const side: Bubble['side'] = Math.abs(line.rect.x - leftEdge) <= Math.abs(right(line.rect) - rightEdge) ? 'other' : 'self';
    const last = drafts[drafts.length - 1];
    const gap = last ? line.rect.y - bottom(last.rect) : Infinity;
    if (last && last.side === side && gap >= -g.px(2) && gap < line.rect.height * 0.9
        && (side === 'other' ? Math.abs(line.rect.x - last.rect.x) < g.px(6) : Math.abs(right(line.rect) - right(last.rect)) < g.px(6))) {
      last.parts.push(line);
      last.rect = union(last.rect, line.rect);
    } else {
      drafts.push({ side, parts: [line], rect: { ...line.rect } });
    }
  }
  const out: Bubble[] = [];
  const ordinals = new Map<string, number>();
  for (const d of drafts) {
    const text = d.parts.map((p) => p.text.trim()).join('\n');
    let confidence = Math.min(...d.parts.map(conf));
    // The bubble's own colour, sampled just outside the text on both sides.
    const pad = g.px(8);
    const strip = (x: number): PixelRect => ({ x, y: d.rect.y, width: pad, height: d.rect.height });
    const green = Math.max(sampler.shares(strip(d.rect.x - pad)).green, sampler.shares(strip(right(d.rect))).green);
    const colourSide: Bubble['side'] | undefined = sampler === NO_PIXELS ? undefined : green > 0.5 ? 'self' : 'other';
    if (colourSide && colourSide !== d.side) { confidence *= 0.6; warnings.push(`bubble "${norm(text).slice(0, 12)}": colour says ${colourSide}, position says ${d.side}`); }
    const key = `${d.side}|${norm(text)}`;
    const ordinal = ordinals.get(key) ?? 0;
    ordinals.set(key, ordinal + 1);
    out.push({
      side: d.side,
      text,
      rect: roundRect(d.rect),
      anchorKey: `${key}|y${Math.round(d.rect.y)}|#${ordinal}`,
      confidence: clamp01(confidence),
    });
  }
  return out;
}

export function inputBox(texts: TextItem[], profile: WeChatLayoutProfile): InputBox {
  const g = new Geometry(profile);
  const rect = roundRect(g.input);
  const typed = texts.filter((t) => inside(t.rect, rect) && conf(t) >= 0.3).sort(byPosition);
  const text = typed.map((t) => t.text.trim()).join('\n');
  // Empty-by-absence: OCR sees no text, which does not rule out an image or sticker draft.
  return { rect, text, empty: typed.length === 0, confidence: typed.length ? clamp01(Math.min(...typed.map(conf))) : 0.7 };
}

/** A modal's buttons near the window's centre: `取消` beside a confirm label. */
export function dialogButtons(texts: TextItem[], profile: WeChatLayoutProfile): ButtonHit[] | undefined {
  const g = new Geometry(profile);
  const cx = g.imageWidth / 2, cy = g.imageHeight / 2;
  const near = (t: TextItem) => Math.abs(centreX(t.rect) - cx) < g.px(300) && Math.abs(centreY(t.rect) - cy) < g.px(250);
  const cancel = texts.find((t) => norm(t.text) === '取消' && near(t));
  if (!cancel) return undefined;
  const confirm = texts.find((t) => ['确定', '确认', '好', '知道了', '发送', '完成'].includes(norm(t.text)) && near(t) && sameLine(t, cancel, g.px(9)));
  if (!confirm) return undefined;
  return buttonHits([cancel, confirm], profile);
}

export interface SidebarKind { kind: 'contacts' | 'chats' | 'search' | 'unknown' }

/** What page the capture shows, from the cues each page is known by. */
export function classify(texts: TextItem[], profile: WeChatLayoutProfile, parts: {
  requests?: RequestSection; chats: ChatRow[]; detail?: DetailPane; dialog?: ButtonHit[]; bubbles: Bubble[];
}): { page: PageKind; warnings: string[] } {
  const V = profile.vocabulary;
  const g = new Geometry(profile);
  const all = texts.map((t) => norm(t.text));
  const has = (cues: string[]) => cues.some((c) => all.some((t) => t.includes(c)));
  const warnings: string[] = [];
  if (parts.dialog) return { page: 'dialog', warnings: ['a dialog is open'] };
  if (has(V.addFriendCues) && all.some((t) => t === '发送' || t === '发送申请')) return { page: 'add_friend', warnings };
  if (has(V.searchCues)) return { page: 'search_results', warnings };
  const paneTexts = texts.filter((t) => t.rect.x > g.pane.x);
  const paneHas = (cues: string[]) => cues.some((c) => paneTexts.some((t) => norm(t.text).includes(c)));
  if (parts.detail && paneHas(V.requestDetailCues)) return { page: 'request_detail', warnings };
  if (parts.detail && paneHas(['微信号'])) return { page: 'contact_detail', warnings };
  const contactsTree = texts.some((t) => norm(t.text).includes('新的朋友') && t.rect.x < g.px(profile.layout.request.nameX));
  if (contactsTree) {
    if (parts.requests && (parts.requests.rows.length > 0 || parts.requests.coverage !== 'current_viewport')) return { page: 'new_friends', warnings };
    return { page: 'contacts', warnings };
  }
  if (parts.detail && (parts.bubbles.length > 0 || parts.chats.length > 0)) return { page: 'chat', warnings };
  if (parts.chats.length > 0) return { page: 'chats', warnings };
  warnings.push('no page cue recognised');
  return { page: 'unknown', warnings };
}

/** The title of an open conversation: the large text at the top of the pane. */
export function conversationTitle(texts: TextItem[], profile: WeChatLayoutProfile): { title: string; rect: PixelRect } | undefined {
  const g = new Geometry(profile);
  const pane = g.pane;
  const title = texts
    .filter((t) => t.rect.x > pane.x && t.rect.y < g.px(profile.layout.conversation.titleMaxY) && t.rect.height >= g.px(14))
    .sort(byPosition)[0];
  return title ? { title: title.text.replace(/[\s\u2022]+$/, '').trim(), rect: roundRect(title.rect) } : undefined;
}

/** The whole read of one capture, from texts the OCR helper returned. */
export function analyze(input: AnalyzeInput, profile: WeChatLayoutProfile): PageFactsWithConversation {
  const sampler = input.sampler ?? NO_PIXELS;
  const texts = input.texts.map((t) => ({ ...t, rect: roundRect(t.rect), confidence: conf(t) }));
  const warnings = [...(input.warnings ?? [])];
  const requests = requestSection(texts, profile, sampler);
  const chats = chatRows(texts, profile, sampler);
  const detail = detailPane(texts, profile);
  const dialog = dialogButtons(texts, profile);
  const bubbleWarnings: string[] = [];
  const bubbleList = bubbles(texts, profile, sampler, bubbleWarnings);
  const { page, warnings: pageWarnings } = classify(texts, profile, { requests, chats, detail, dialog, bubbles: bubbleList });
  warnings.push(...pageWarnings);
  if (requests) warnings.push(...requests.warnings);

  const facts: PageFactsWithConversation = {
    page,
    coverage: requests && (page === 'new_friends' || page === 'request_detail' || page === 'contacts') ? requests.coverage : 'current_viewport',
    profileId: profile.profileId,
    buttons: dialog ?? buttonHits(texts, profile),
    texts,
    warnings,
    confidence: clamp01(mean(texts.map(conf))),
    evidenceRef: input.evidenceRef ?? {},
  };
  if (requests) facts.requests = requests.rows;
  if (chats.length) facts.chats = chats;
  if (detail) facts.detail = detail;
  if (page === 'chat') {
    facts.bubbles = bubbleList;
    facts.inputBox = inputBox(texts, profile);
    facts.warnings.push(...bubbleWarnings);
    const conversation = conversationTitle(texts, profile);
    if (conversation) facts.conversation = conversation;
  }
  if (texts.length === 0) {
    facts.coverage = 'unreadable';
    facts.warnings.push('no text recognised');
  }
  return facts;
}
