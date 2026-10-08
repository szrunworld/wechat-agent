import type { ApplicationService, AppSnapshot, IpcMethod, IpcMethods } from '../ipc.ts';
import { IpcFailure } from '../ipc.ts';
import { sampleSnapshots, type SnapshotKey } from './snapshots.ts';

/** An ApplicationService that serves sample snapshots; UI and shell lanes develop against it. */
export class FakeApplicationService implements ApplicationService {
  private listeners = new Set<(snapshot: AppSnapshot) => void>();
  private current: AppSnapshot;
  readonly calls: { method: IpcMethod; params: unknown }[] = [];

  constructor(initial: SnapshotKey = 'ready_idle') {
    this.current = sampleSnapshots[initial];
  }

  /** Switch the served state; listeners are notified. */
  show(key: SnapshotKey): void {
    this.current = { ...sampleSnapshots[key], revision: this.current.revision + 1 };
    for (const listener of this.listeners) listener(this.current);
  }

  async call<M extends IpcMethod>(method: M, params: IpcMethods[M]['params']): Promise<IpcMethods[M]['result']> {
    this.calls.push({ method, params });
    switch (method) {
      case 'app.getSnapshot':
        return this.current as IpcMethods[M]['result'];
      case 'task.show': {
        const task = this.current.tasks.find((t) => t.taskId === (params as IpcMethods['task.show']['params']).taskId) ?? this.current.activeTask;
        if (!task) throw new IpcFailure({ code: 'not_found', message: 'no such task' });
        return task as IpcMethods[M]['result'];
      }
      case 'task.list':
        return { tasks: this.current.tasks } as IpcMethods[M]['result'];
      case 'connection.check':
        return { state: this.current.connection.state, apiVersion: this.current.connection.apiVersion, methods: [], missingCapabilities: this.current.connection.missingCapabilities } as IpcMethods[M]['result'];
      default:
        throw new IpcFailure({ code: 'unavailable', message: `fake service does not implement ${method}` });
    }
  }

  subscribe(listener: (snapshot: AppSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }
}
