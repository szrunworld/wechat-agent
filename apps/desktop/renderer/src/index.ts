// Lane F. See docs/lanes/lane-f.md. The renderer sees only this global.
import type { ApplicationService } from '@wechat-agent/ports';
declare global {
  interface Window { wechatAgent: ApplicationService }
}
export {};
