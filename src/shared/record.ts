import Ajv from 'ajv';
import schema from '../../record.schema.json';
import type { CompileConfig, Kernel, RunStatus, Stage, TraceEvent, TraceRecord } from './model';

const ajv = new Ajv({ allErrors: false, strict: false });
const validate = ajv.compile(schema);
const validators = Object.fromEntries(['stage', 'kernel', 'log', 'environment', 'error'].map(name => [
  name, ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` }),
]));

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function assertRecord(value: unknown): asserts value is TraceRecord {
  if (!validate(value)) throw new Error(`无效的 .tltrace.json 记录：${ajv.errorsText(validate.errors)}`);
  const record = value as unknown as TraceRecord;
  const ids = new Set<string>();
  const sequences = new Set<number>();
  for (const kernel of record.kernels) {
    if (ids.has(kernel.id)) throw new Error(`重复 kernel ID：${kernel.id}`);
    ids.add(kernel.id);
    const stages = new Map(kernel.stages.map(stage => [stage.id, stage]));
    for (const stage of kernel.stages) {
      if (ids.has(stage.id)) throw new Error(`重复阶段 ID：${stage.id}`);
      ids.add(stage.id);
      if (sequences.has(stage.sequence)) throw new Error(`重复阶段顺序：${stage.sequence}`);
      sequences.add(stage.sequence);
      if (stage.parentId !== null) {
        const parent = stages.get(stage.parentId);
        if (!parent || parent.sequence >= stage.sequence || parent.depth >= stage.depth) {
          throw new Error(`阶段 ${stage.id} 的父阶段引用无效`);
        }
      }
    }
  }
}

export function parseRecord(text: string): TraceRecord {
  const record: unknown = JSON.parse(text);
  assertRecord(record);
  return record;
}

export function validateConfig(value: unknown): CompileConfig {
  if (!plainObject(value)) throw new Error('编译配置必须是对象');
  for (const key of ['entryPath', 'pythonPath']) {
    if (typeof value[key] !== 'string' || !(value[key] as string).trim()) throw new Error(`缺少配置：${key}`);
  }
  if (!Array.isArray(value.scriptArgs) || value.scriptArgs.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('脚本参数必须是 JSON 字符串数组，且不能包含空字符');
  if (typeof value.workingDirectory !== 'string') throw new Error('工作目录必须是字符串');
  if (typeof value.disableCache !== 'boolean') throw new Error('禁用缓存配置必须是布尔值');
  if ([value.pythonPath, value.entryPath, value.workingDirectory].some(item => (item as string).includes('\0'))) throw new Error('路径包含无效字符');
  return {
    entryPath: value.entryPath as string, pythonPath: value.pythonPath as string,
    scriptArgs: [...value.scriptArgs], workingDirectory: value.workingDirectory,
    disableCache: value.disableCache,
  };
}

export function emptyRecord(id: string, config: CompileConfig, source: string): TraceRecord {
  return {
    schemaVersion: 1, id, provenance: 'real', createdAt: new Date().toISOString(),
    status: 'running', durationMs: null,
    entry: { path: config.entryPath, function: '__main__', kwargs: {}, source, mode: 'script', args: config.scriptArgs, cwd: config.workingDirectory },
    environment: { python: config.pythonPath, tilelangVersion: '', tilelangPath: '', target: { kind: 'c' }, executionBackend: 'cython', compilationMode: 'jit' },
    kernels: [], logs: [],
  };
}

function requireValid(name: string, value: unknown): void {
  if (!validators[name](value)) throw new Error(`无效的采集事件 ${name}：${ajv.errorsText(validators[name].errors)}`);
}

export function applyEvent(record: TraceRecord, raw: unknown): TraceRecord {
  if (!plainObject(raw) || typeof raw.type !== 'string') throw new Error('无效的采集事件');
  const event = raw as unknown as TraceEvent;
  if (event.type === 'record') {
    assertRecord(event.record);
    if (event.record.id !== record.id) throw new Error('采集事件属于其他任务');
    return { ...event.record, logs: [...record.logs, ...event.record.logs] };
  }
  switch (event.type) {
    case 'kernel':
      requireValid('kernel', event.kernel);
      if (record.kernels.some(k => k.id === event.kernel.id)) throw new Error('重复 kernel 事件');
      assertRecord({ ...record, kernels: [...record.kernels, event.kernel] });
      record.kernels.push(event.kernel);
      break;
    case 'stage': {
      requireValid('stage', event.stage);
      const kernel = record.kernels.find(k => k.id === event.kernelId);
      if (!kernel) throw new Error('阶段事件引用了未知 kernel');
      const index = kernel.stages.findIndex(s => s.id === event.stage.id);
      const stages = [...kernel.stages];
      if (index === -1) stages.push(event.stage);
      else stages[index] = event.stage;
      stages.sort((a, b) => a.sequence - b.sequence);
      assertRecord({ ...record, kernels: record.kernels.map(k => k === kernel ? { ...kernel, stages } : k) });
      kernel.stages = stages;
      break;
    }
    case 'kernel-update': {
      const kernel = record.kernels.find(k => k.id === event.kernelId);
      if (!kernel || !plainObject(event.patch) || Object.keys(event.patch).some(k => !['status', 'cache', 'cacheSource'].includes(k))) throw new Error('无效 kernel 更新');
      requireValid('kernel', { ...kernel, ...event.patch });
      Object.assign(kernel, event.patch);
      break;
    }
    case 'environment': requireValid('environment', event.environment); record.environment = event.environment; break;
    case 'log': requireValid('log', event.log); record.logs.push(event.log); break;
    case 'finish':
      if (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(event.status) || !Number.isFinite(event.durationMs) || event.durationMs < 0) throw new Error('无效任务结束事件');
      if (event.error) requireValid('error', event.error);
      record.status = event.status;
      record.durationMs = event.durationMs;
      record.endedAt = new Date().toISOString();
      if (event.error) record.error = event.error;
      break;
    default: throw new Error(`未知采集事件：${String(raw.type)}`);
  }
  return record;
}

export function endIncomplete(record: TraceRecord, status: Extract<RunStatus, 'cancelled' | 'interrupted' | 'failed'>): void {
  record.status = status;
  record.endedAt = new Date().toISOString();
  for (const kernel of record.kernels) {
    if (kernel.status === 'running') kernel.status = status;
    for (const stage of kernel.stages) if (stage.status === 'running') stage.status = status;
  }
}

export function previousStage(kernel: Kernel, stage: Stage): Stage | undefined {
  const ordered = [...kernel.stages].sort((a, b) => a.sequence - b.sequence);
  return ordered[ordered.findIndex(s => s.id === stage.id) - 1];
}

/** Bytes may split UTF-8 characters or JSON lines. Ignore only the final incomplete line. */
export class EventDecoder {
  private decoder = new TextDecoder();
  private pending = '';
  *push(bytes: Uint8Array): Generator<unknown> {
    this.pending += this.decoder.decode(bytes, { stream: true });
    if (this.pending.length > 128 * 1024 * 1024) throw new Error('单条采集事件超过 128 MiB');
    const lines = this.pending.split('\n');
    this.pending = lines.pop()!;
    for (const line of lines) if (line.trim()) yield JSON.parse(line);
  }
  get hasPartialLine(): boolean { return this.pending.length > 0; }
}

/** Owns a live protocol record. Do not mutate stage identities outside this stream. */
export class RecordEventStream {
  private kernels = new Map<string, Kernel>();
  private stages = new Map<string, { kernel: Kernel; index: number; stage: Stage }>();
  private sequences = new Set<number>();

  constructor(public record: TraceRecord) {
    assertRecord(record);
    this.reindex();
  }

  private reindex(): void {
    this.kernels.clear(); this.stages.clear(); this.sequences.clear();
    for (const kernel of this.record.kernels) {
      this.kernels.set(kernel.id, kernel);
      kernel.stages.forEach((stage, index) => {
        this.stages.set(stage.id, { kernel, index, stage });
        this.sequences.add(stage.sequence);
      });
    }
  }

  apply(raw: unknown): TraceRecord {
    if (plainObject(raw) && raw.type === 'stage') {
      requireValid('stage', raw.stage);
      const stage = raw.stage as Stage;
      const kernel = this.kernels.get(raw.kernelId as string);
      if (!kernel) throw new Error('阶段事件引用了未知 kernel');
      const previous = this.stages.get(stage.id);
      if (previous) {
        if (previous.kernel !== kernel) throw new Error(`重复阶段 ID：${stage.id}`);
        // Structural edits must also validate existing children. They are rare;
        // use the full validator rather than weakening its import invariants.
        if (previous.stage.sequence !== stage.sequence || previous.stage.parentId !== stage.parentId || previous.stage.depth !== stage.depth) {
          this.record = applyEvent(this.record, raw);
          this.reindex();
        } else {
          kernel.stages[previous.index] = stage;
          previous.stage = stage;
        }
        return this.record;
      }
      if (this.kernels.has(stage.id)) throw new Error(`重复阶段 ID：${stage.id}`);
      if (this.sequences.has(stage.sequence)) throw new Error(`重复阶段顺序：${stage.sequence}`);
      if (stage.parentId !== null) {
        const parent = this.stages.get(stage.parentId);
        if (!parent || parent.kernel !== kernel || parent.stage.sequence >= stage.sequence || parent.stage.depth >= stage.depth) {
          throw new Error(`阶段 ${stage.id} 的父阶段引用无效`);
        }
      }
      const last = kernel.stages.at(-1);
      if (last && last.sequence > stage.sequence) {
        this.record = applyEvent(this.record, raw);
        this.reindex();
      } else {
        this.stages.set(stage.id, { kernel, index: kernel.stages.length, stage });
        this.sequences.add(stage.sequence);
        kernel.stages.push(stage);
      }
      return this.record;
    }
    this.record = applyEvent(this.record, raw);
    if (plainObject(raw) && (raw.type === 'record' || raw.type === 'kernel')) this.reindex();
    return this.record;
  }
}
