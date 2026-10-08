import { render, screen, waitFor } from '@testing-library/react';
import { FakeApplicationService, type SnapshotKey } from '@wechat-agent/ports/fakes';
import { App } from '../src/App.tsx';
import type { ScreenKey } from '../src/screens/index.ts';

export async function mount(state: SnapshotKey, screenKey: ScreenKey) {
  const fake = new FakeApplicationService(state);
  const utils = render(<App service={fake} initialScreen={screenKey} />);
  await waitFor(() => utils.container.querySelector('[data-ready="true"]') ?? Promise.reject(new Error('not ready')));
  return { fake, ...utils };
}

export function button(name: string | RegExp): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

export const RESEND = /再发|重发|重新发送|再试一次|重试/;
