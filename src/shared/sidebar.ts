import type { CompileConfig, Kernel, RunStatus, Stage, TraceError, TraceRecord } from './model';

export type SidebarAction = 'open' | 'use-current' | 'example' | 'demo' | 'import' | 'export' | 'reveal-error' | 'browse' | 'cancel' | 'edit-source';

export type SidebarPreferences = Pick<CompileConfig, 'pythonPath' | 'disableCache'>;

/** Only fields retained when selecting an entry; the old entry/argv may be incomplete. */
export function validateSidebarPreferences(value: unknown): SidebarPreferences | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('入口选择设置必须是对象');
  const preferences = value as Record<string, unknown>;
  if (typeof preferences.pythonPath !== 'string' || preferences.pythonPath.includes('\0')) throw new Error('Python 解释器路径无效');
  if (typeof preferences.disableCache !== 'boolean') throw new Error('缓存选项必须是布尔值');
  // An empty interpreter is a valid draft; starting a run validates it later.
  return { pythonPath: preferences.pythonPath, disableCache: preferences.disableCache };
}

export type SidebarMessage =
  | { type: 'ready' }
  | { type: 'action'; action: SidebarAction; preferences?: SidebarPreferences }
  | { type: 'compile'; config: CompileConfig }
  | { type: 'edit-source'; entryPath: string }
  | { type: 'select-stage'; recordId: string; stageId: string };

export interface SidebarStage extends Pick<Stage, 'id' | 'sequence' | 'name' | 'kind' | 'phase' | 'depth' | 'status' | 'durationMs' | 'changed' | 'added' | 'deleted'> {
  kernelId: string;
  kernelName: string;
  kernelIndex: number;
  cache: Kernel['cache'];
  occurrence: number;
  repetitions: number;
}

export interface SidebarState {
  busy: boolean;
  trusted: boolean;
  currentFile: { path: string; name: string } | null;
  config: CompileConfig;
  configRevision: number;
  selectedStageId: string | null;
  record: {
    id: string;
    entryPath: string;
    fileName: string;
    provenance: TraceRecord['provenance'];
    status: RunStatus;
    stageCount: number;
    kernelCount: number;
    compilationMode?: TraceRecord['environment']['compilationMode'];
    durationMs: number | null;
    stages: SidebarStage[];
    error?: Pick<TraceError, 'message' | 'phase' | 'stageId'>;
  } | null;
}

export type SidebarHostMessage =
  | { type: 'sidebar-state'; state: SidebarState }
  | { type: 'sidebar-notice'; message: string }
  | { type: 'sidebar-error'; message: string };

/** A detached summary: snapshots, source, logs and tracebacks stay in the workbench. */
export function createSidebarState(
  record: TraceRecord | null,
  busy: boolean,
  trusted: boolean,
  currentFile: { path: string; name: string } | null,
  config: CompileConfig = { entryPath: '', pythonPath: 'python', scriptArgs: [], workingDirectory: '', disableCache: false },
  selectedStageId: string | null = null,
  configRevision = 0,
): SidebarState {
  const state: SidebarState = { busy, trusted, currentFile: currentFile ? { ...currentFile } : null,
    config: { ...config, scriptArgs: [...config.scriptArgs] }, configRevision, selectedStageId, record: null };
  if (!record) return state;

  let stageCount = 0;
  let stageError: TraceError | undefined;
  let errorSequence = -1;
  const stages: SidebarStage[] = [];
  for (const [index, kernel] of record.kernels.entries()) {
    const counts = new Map<string, number>();
    const seen = new Map<string, number>();
    for (const stage of kernel.stages) counts.set(stage.name, (counts.get(stage.name) ?? 0) + 1);
    stageCount += kernel.stages.length;
    for (const stage of [...kernel.stages].sort((a, b) => a.sequence - b.sequence)) {
      const occurrence = (seen.get(stage.name) ?? 0) + 1;
      seen.set(stage.name, occurrence);
      const { id, sequence, name, kind, phase, depth, status, durationMs, changed, added, deleted } = stage;
      stages.push({ id, sequence, name, kind, phase, depth, status, durationMs, changed, added, deleted,
        kernelId: kernel.id, kernelName: kernel.name, kernelIndex: index + 1, cache: kernel.cache,
        occurrence, repetitions: counts.get(stage.name)! });
      if (stage.error && stage.sequence > errorSequence) {
        errorSequence = stage.sequence;
        stageError = { ...stage.error, stageId: stage.error.stageId ?? stage.id };
      }
    }
  }
  const error = record.error ?? stageError;
  state.record = {
    id: record.id,
    entryPath: record.entry.path,
    // Imported records may have been captured on another operating system.
    fileName: record.entry.path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '未命名记录',
    provenance: record.provenance,
    status: record.status,
    stageCount,
    kernelCount: record.kernels.length,
    ...(record.environment.compilationMode ? { compilationMode: record.environment.compilationMode } : {}),
    durationMs: record.durationMs,
    stages: stages.sort((a, b) => a.sequence - b.sequence),
    ...(error ? { error: {
      // Native compiler diagnostics can embed entire generated programs. The
      // full diagnostic remains in the workbench and exported record.
      message: error.message.length > 512 ? `${error.message.slice(0, 512)}…` : error.message,
      phase: error.phase,
      ...(error.stageId !== undefined ? { stageId: error.stageId } : {}),
    } } : {}),
  };
  return state;
}
