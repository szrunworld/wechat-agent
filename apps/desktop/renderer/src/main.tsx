// Renderer entry. In the packaged app the preload injects `window.wechatAgent`;
// in `vite dev`, tests and the acceptance renderer the in-memory Fake stands in.
import './index.ts';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FakeApplicationService, sampleSnapshots, type SnapshotKey } from '@wechat-agent/ports/fakes';
import { App } from './App.tsx';
import type { ScreenKey } from './screens/index.ts';
import './styles.css';

const params = new URLSearchParams(window.location.search);
const requestedState = params.get('state');
const initialState: SnapshotKey = requestedState && requestedState in sampleSnapshots ? (requestedState as SnapshotKey) : 'ready_idle';

let fake: FakeApplicationService | undefined;
if (!window.wechatAgent) {
  fake = new FakeApplicationService(initialState);
  window.wechatAgent = fake;
}

const screen = params.get('screen') as ScreenKey | null;
const showPanel = params.get('panel') !== '0';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App service={window.wechatAgent} fake={showPanel ? fake : undefined} initialScreen={screen ?? undefined} />
  </StrictMode>,
);
