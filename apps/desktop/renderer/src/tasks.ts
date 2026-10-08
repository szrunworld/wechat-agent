import type { AppSnapshot, TaskView } from '@wechat-agent/ports';

/** The active task plus the list, de-duplicated by id (active first). */
export function allTasks(snapshot: AppSnapshot): TaskView[] {
  const seen = new Set<string>();
  const out: TaskView[] = [];
  for (const t of [snapshot.activeTask, ...snapshot.tasks]) {
    if (t && !seen.has(t.taskId)) { seen.add(t.taskId); out.push(t); }
  }
  return out;
}

export function pickTask(list: TaskView[], selectedTaskId: string | undefined): TaskView | undefined {
  return list.find((t) => t.taskId === selectedTaskId) ?? list[0];
}
