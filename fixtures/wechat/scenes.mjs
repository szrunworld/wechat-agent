// Builds the synthetic scenes (scenes/*.json) and their expected PageFacts
// subsets (*.expected.json). Every name, id and message here is made up.
// Geometry follows profile 1 (WeChat 4.1, 1280x875 points, dark, 2x).
//
//   node fixtures/wechat/scenes.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const scenesDir = join(here, 'scenes');
mkdirSync(scenesDir, { recursive: true });

const DARK = { window: '#1C1C1E', rail: '#1A1A1A', sidebar: '#262628', pane: '#1C1C1E', text: '#E6E6E6', dim: '#8E8E93', line: '#333336', bubble: '#2C2C2E', green: '#07C160', red: '#FA5151', thumb: '#6E6E73' };
const LIGHT = { window: '#F5F5F5', rail: '#E6E6E6', sidebar: '#EDEDED', pane: '#F5F5F5', text: '#1A1A1A', dim: '#7A7A7A', line: '#DDDDDD', bubble: '#FFFFFF', green: '#07C160', red: '#FA5151', thumb: '#B0B0B0' };

class Scene {
  constructor(name, theme = DARK, size = { width: 1280, height: 875, scale: 2 }) {
    this.name = name;
    this.t = theme;
    this.scene = { ...size, background: theme.window, rects: [], texts: [] };
    this.expected = { scene: name, image: { width: size.width * size.scale, height: size.height * size.scale, scale: size.scale }, applicability: 'applicable' };
    this.rect(0, 0, 58, 875, theme.rail);
    this.rect(58, 0, 243, 875, theme.sidebar);
    this.rect(301, 0, 979, 875, theme.pane);
  }
  rect(x, y, w, h, color, radius = 0) { this.scene.rects.push({ x, y, w, h, color, radius }); return this; }
  text(text, x, y, size = 14, color = this.t.text, bold = false) { this.scene.texts.push({ text, x, y, size, color, bold }); return this; }
  /** The contacts sidebar chrome: search box, 通讯录管理, 新的朋友 header at the measured spot. */
  contactsChrome() {
    this.rect(68, 16, 215, 24, this.t.bubble, 6).text('搜索', 97, 19, 13, this.t.dim);
    this.text('通讯录管理', 159, 58, 14, this.t.text);
    this.text('新的朋友', 75, 112, 13, this.t.dim);
    return this;
  }
  chatsChrome() { return this.rect(68, 16, 215, 24, this.t.bubble, 6).text('搜索', 150, 19, 13, this.t.dim); }
  /** A 新的朋友 row; status '接受' draws the green button; `selected` paints the row WeChat green (T15). */
  requestRow(i, name, note, status, { selected = false, y0 = 160 } = {}) {
    const y = y0 + 69 * i;
    if (selected) this.rect(61, y - 17, 240, 69, this.t.green);
    const colour = selected ? '#FFFFFF' : this.t.text;
    this.rect(76, y - 6, 40, 40, selected ? '#1F6E44' : '#3A3A3C', 6);
    this.text(name, 133, y - 4, 14, colour);
    if (note) this.text(note, 133, y + 20, 12, selected ? '#F0F0F0' : this.t.dim);
    if (status === '接受') this.rect(250, y - 2, 48, 24, this.t.green, 4).text('接受', 262, y + 1, 12, '#FFFFFF');
    else if (status) this.text(status, 258, y + 2, 12, selected ? '#FFFFFF' : this.t.dim);
    return this;
  }
  sectionHeader(label, y) { return this.text(label, 75, y, 13, this.t.dim); }
  chatRow(i, name, time, preview, unread = 0) {
    const y = 70 + 68 * i;
    this.rect(68, y - 6, 40, 40, '#3A3A3C', 6);
    this.text(name, 118, y - 2, 14).text(time, 250, y + 1, 12, '#A8A8AD');
    if (preview) this.text(preview, 118, y + 22, 12, this.t.dim);
    if (unread) this.rect(268, y + 20, 18, 18, this.t.red, 9).text(String(unread), 273, y + 21, 11, '#FFFFFF');
    return this;
  }
  /** The open-conversation pane: title, hairline, input area separator. */
  conversationChrome(title) {
    this.text(title, 640 - title.length * 8, 14, 17, this.t.text, true);
    this.rect(301, 52, 979, 1, this.t.line);
    this.rect(301, 720, 979, 1, this.t.line);
    return this;
  }
  bubble(side, text, y) {
    const w = text.length * 15 + 24;
    if (side === 'other') {
      this.rect(316, y - 4, 36, 36, '#3A3A3C', 6).rect(362, y - 8, w, 32, this.t.bubble, 6).text(text, 374, y - 2, 14, this.t.text);
    } else {
      this.rect(1228, y - 4, 36, 36, '#3A3A3C', 6).rect(1218 - w, y - 8, w, 32, this.t.green, 6).text(text, 1230 - w, y - 2, 14, '#0B1A10');
    }
    return this;
  }
  timeSeparator(label, y) { return this.text(label, 640 - label.length * 4, y, 11, this.t.dim); }
  detail({ title, wechatId, region, message, button }) {
    this.rect(631, 60, 48, 48, '#3A3A3C', 8);
    this.text(title, 708, 66, 17, this.t.text, true);
    if (wechatId) this.text(`微信号：${wechatId}`, 707, 98, 12, this.t.dim);
    if (region) this.text(`地区：${region}`, 707, 118, 12, this.t.dim);
    if (message) this.text(`验证消息：${message}`, 707, 148, 12, this.t.text);
    if (button) this.rect(715, 520, 150, 36, this.t.green, 6).text(button, 790 - button.length * 7, 528, 14, '#FFFFFF');
    return this;
  }
  expect(partial) { Object.assign(this.expected, partial); return this; }
  write() {
    writeFileSync(join(scenesDir, `${this.name}.json`), JSON.stringify(this.scene));
    writeFileSync(join(here, `${this.name}.expected.json`), JSON.stringify(this.expected, null, 2) + '\n');
    console.log(`scene ${this.name}: ${this.scene.rects.length} rects, ${this.scene.texts.length} texts`);
  }
}

const MIXED_ROWS = [
  ['林小雨', '我是林小雨，想认识一下', '接受'],
  ['王大为', '来自群聊「合成测试群」', '已添加'],
  ['张小明', '我是张小明', '已过期'],
  ['李晓华', '你好，请通过', '等待验证'],
  ['赵六', '朋友推荐', '已拒绝'],
  ['林小雨', '另一位同名的申请', '已添加'],
  ['昵称特别长的合成…', '长昵称被列表截断', '已添加'],
];
const STATUS = { 接受: 'pending', 已添加: 'added', 已过期: 'expired', 等待验证: 'waiting_verification', 已拒绝: 'rejected' };

function mixed(name, theme) {
  const s = new Scene(name, theme).contactsChrome();
  MIXED_ROWS.forEach(([n, note, st], i) => s.requestRow(i, n, note, st));
  s.sectionHeader('群聊', 660).text('23', 270, 662, 11, s.t.dim);
  s.detail({ title: '林小雨', wechatId: 'wxid_synthetic01', region: '中国大陆', message: '我是林小雨，想认识一下', button: '通过验证' });
  return s;
}

mixed('new-friends-mixed').expect({
  page: 'request_detail', coverage: 'end_confirmed',
  requests: MIXED_ROWS.map(([name, note, st]) => ({ name, note, status: STATUS[st], actionRect: st === '接受' })),
  detail: { name: '林小雨', wechatId: 'wxid_synthetic01', region: '中国大陆', message: '我是林小雨，想认识一下' },
  buttonsInclude: ['通过验证', '接受'],
  warningsInclude: ['duplicate name "林小雨"', 'cut short'],
}).write();

mixed('light-theme', LIGHT).expect({ page: 'unknown', coverage: 'unreadable', warningsInclude: ['theme_mismatch'] }).write();

new Scene('new-friends-green-selected').contactsChrome()
  .requestRow(0, '林小雨', '来自群聊', '已添加', { selected: true })
  .requestRow(1, '王大为', '你好', '', { selected: true })
  .requestRow(2, '张小明', '我是张小明', '接受')
  .sectionHeader('群聊', 400)
  .expect({
    page: 'new_friends', coverage: 'end_confirmed',
    requests: [
      { name: '林小雨', status: 'added', actionRect: false },
      { name: '王大为', status: 'unknown', actionRect: false },
      { name: '张小明', status: 'pending', actionRect: true },
    ],
    warningsInclude: ['not treated as pending'],
  }).write();

new Scene('new-friends-empty').contactsChrome()
  .text('暂无新的朋友', 130, 176, 13, DARK.dim)
  .expect({ page: 'new_friends', coverage: 'end_confirmed', requests: [] }).write();

new Scene('new-friends-header-only').contactsChrome()
  .expect({ page: 'contacts', coverage: 'current_viewport', requests: [] }).write();

{
  const s = new Scene('new-friends-partial').contactsChrome();
  for (let i = 0; i < 11; i++) s.requestRow(i, `合成用户${String.fromCharCode(0x7532 + i)}`, `第 ${i + 1} 条合成留言`, i === 0 ? '接受' : '已添加', { y0: 168 });
  s.rect(294, 300, 6, 120, DARK.thumb, 3);
  s.expect({ page: 'new_friends', coverage: 'partial', requestsAtLeast: 10, warningsInclude: ['rows may continue'] }).write();
}

const CHATS = [
  ['林小雨', '20:19', '好的，明天见', 3],
  ['合成测试群', '昨天 14:07', '王大为: 收到', 0],
  ['文件传输助手', '星期日', '', 0],
  ['张小明', '10/06', '[图片]', 1],
];
function chats(name) {
  const s = new Scene(name).chatsChrome();
  CHATS.forEach(([n, t, p, u], i) => s.chatRow(i, n, t, p, u));
  return s;
}
const CHATS_EXPECTED = CHATS.map(([name, time, , unread]) => ({ name, time, unread: unread > 0 }));

chats('chats-list').expect({ page: 'chats', chats: CHATS_EXPECTED }).write();

chats('chat-open').conversationChrome('林小雨')
  .timeSeparator('12:30', 86)
  .bubble('other', '你好，在吗？', 120).bubble('self', '在的', 200).bubble('other', '你好，在吗？', 330).bubble('self', '在的', 420)
  .expect({
    page: 'chat', chats: CHATS_EXPECTED,
    bubbles: [{ side: 'other', text: '你好，在吗？' }, { side: 'self', text: '在的' }, { side: 'other', text: '你好，在吗？' }, { side: 'self', text: '在的' }],
    inputBox: { empty: true },
  }).write();

chats('chat-draft').conversationChrome('林小雨')
  .bubble('other', '你好，在吗？', 120)
  .text('还没发出去的草稿', 320, 736, 14)
  .expect({ page: 'chat', bubbles: [{ side: 'other', text: '你好，在吗？' }], inputBox: { empty: false, text: '还没发出去的草稿' } }).write();

chats('dialog')
  .rect(440, 340, 400, 180, '#2C2C2E', 10)
  .text('确定要清空聊天记录吗？', 480, 380, 15)
  .rect(500, 456, 100, 34, '#3A3A3C', 6).text('取消', 536, 464, 14)
  .rect(680, 456, 100, 34, DARK.green, 6).text('确定', 716, 464, 14, '#FFFFFF')
  .expect({ page: 'dialog', buttons: ['取消', '确定'] }).write();

new Scene('contact-detail').contactsChrome().sectionHeader('群聊', 170).sectionHeader('联系人', 226)
  .detail({ title: '王大为', wechatId: 'wxid_synthetic02', region: '中国大陆', button: '发消息' })
  .expect({ page: 'contact_detail', detail: { name: '王大为', wechatId: 'wxid_synthetic02', region: '中国大陆' }, buttonsInclude: ['发消息'] }).write();

new Scene('add-friend').contactsChrome().sectionHeader('群聊', 170)
  .rect(440, 200, 400, 420, '#2C2C2E', 10)
  .text('发送添加朋友申请', 560, 220, 15, DARK.text, true)
  .rect(470, 270, 340, 60, '#3A3A3C', 6).text('我是合成用户甲', 484, 282, 13)
  .text('设置备注', 470, 360, 13, DARK.dim)
  .rect(470, 390, 340, 36, '#3A3A3C', 6).text('王大为', 484, 398, 13)
  .rect(600, 560, 100, 36, DARK.green, 6).text('发送', 636, 568, 14, '#FFFFFF')
  .expect({ page: 'add_friend', buttonsInclude: ['发送'] }).write();

new Scene('search-results').chatsChrome()
  .text('网络查找', 70, 60, 12, DARK.dim)
  .rect(68, 84, 40, 40, '#3A3A3C', 6).text('查找手机/微信号：synthetic02', 118, 94, 13)
  .expect({ page: 'search_results' }).write();

new Scene('wrong-size', DARK, { width: 500, height: 350, scale: 2 }).contactsChrome()
  .expect({ applicability: 'size_mismatch', coverage: 'unreadable', warningsInclude: ['size_mismatch'] }).write();

new Scene('scale-1x', DARK, { width: 1280, height: 875, scale: 1 }).contactsChrome()
  .expect({ applicability: 'size_mismatch', coverage: 'unreadable', warningsInclude: ['size_mismatch'] }).write();
