export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type StageStatus = RunStatus;
export type KernelStatus = RunStatus | 'pending';
export type Language = 'python' | 'cpp' | 'text';

export interface TraceError {
  phase: string;
  message: string;
  traceback?: string;
  stageId?: string;
}

export interface Stage {
  id: string;
  sequence: number;
  kind: 'source' | 'frontend' | 'pass' | 'codegen' | 'jit' | 'cache';
  name: string;
  phase: string | null;
  parentId: string | null;
  depth: number;
  status: StageStatus;
  beforeText: string | null;
  afterText: string | null;
  beforeLanguage: Language;
  afterLanguage: Language;
  durationMs: number | null;
  changed: boolean | null;
  added: number | null;
  deleted: number | null;
  error?: TraceError;
}

export interface Kernel {
  id: string;
  name: string;
  symbol: string;
  status: KernelStatus;
  cache: 'not-applicable' | 'hit' | 'miss' | 'unknown' | 'disabled';
  cacheSource?: 'memory' | 'disk' | 'decorator' | 'disabled' | 'unknown';
  stages: Stage[];
}

export interface LogEntry {
  timestamp: string;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
}

export interface TraceRecord {
  schemaVersion: 1;
  id: string;
  provenance: 'real' | 'mock';
  createdAt: string;
  endedAt?: string;
  status: RunStatus;
  durationMs: number | null;
  entry: {
    path: string; function: string; kwargs: Record<string, unknown>; source: string;
    mode?: 'script'; args?: string[]; cwd?: string;
  };
  environment: {
    python: string;
    tilelangVersion: string;
    tilelangPath: string;
    gitRevision?: string;
    target: { kind: string; arch?: string };
    executionBackend?: string;
    compilationMode?: 'jit' | 'source';
  };
  kernels: Kernel[];
  logs: LogEntry[];
  error?: TraceError;
}

export interface CompileConfig {
  entryPath: string;
  scriptArgs: string[];
  pythonPath: string;
  workingDirectory: string;
  disableCache: boolean;
}

export type TraceEvent =
  | { type: 'record'; record: TraceRecord }
  | { type: 'kernel'; kernel: Kernel }
  | { type: 'stage'; kernelId: string; stage: Stage }
  | { type: 'kernel-update'; kernelId: string; patch: Partial<Pick<Kernel, 'status' | 'cache' | 'cacheSource'>> }
  | { type: 'environment'; environment: TraceRecord['environment'] }
  | { type: 'log'; log: LogEntry }
  | { type: 'finish'; status: RunStatus; durationMs: number; error?: TraceError };

export type HostMessage =
  | { type: 'record-update'; update: import('./record-update').RecordUpdate; busy: boolean; selectedStageId?: string | null }
  | { type: 'state'; record: TraceRecord | null; config: CompileConfig; busy: boolean; trusted: boolean; selectedStageId?: string | null }
  | { type: 'record'; record: TraceRecord; busy: boolean; selectedStageId?: string | null }
  | { type: 'configuration'; config: CompileConfig; trusted: boolean }
  | { type: 'reveal-error'; stageId?: string }
  | { type: 'reveal-stage'; recordId: string; stageId: string }
  | { type: 'request-ready' }
  | { type: 'error'; message: string }
  | { type: 'notice'; message: string };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'stage-selected'; recordId: string; stageId: string }
  | { type: 'focus-sidebar' }
  | { type: 'edit-source' }
  | { type: 'compile'; config: CompileConfig }
  | { type: 'cancel' }
  | { type: 'import' }
  | { type: 'export' }
  | { type: 'demo' }
  | { type: 'restore' }
  | { type: 'browse' }
  | { type: 'example' }
  | { type: 'copy'; text: string };
