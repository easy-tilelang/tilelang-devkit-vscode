import type { Kernel, Stage, TraceRecord } from './model';

export interface RecordUpdate {
  recordId: string;
  metadata: Omit<TraceRecord, 'entry' | 'kernels' | 'logs'>;
  kernels: Kernel[]; // Kernel metadata plus only new/replaced stages.
  logOffset: number;
  logs: TraceRecord['logs'];
}

/** Tracks immutable stage replacements and in-place terminal status changes. */
export class RecordPublisher {
  private record: TraceRecord | null = null;
  private stages = new Map<string, { stage: Stage; status: Stage['status'] }>();
  private logCount = 0;
  private entry: TraceRecord['entry'] | undefined;
  private source: string | undefined;

  reset(record: TraceRecord | null): void {
    this.record = record;
    this.entry = record?.entry;
    this.source = record?.entry.source;
    this.stages.clear();
    for (const kernel of record?.kernels ?? []) for (const stage of kernel.stages) {
      this.stages.set(stage.id, { stage, status: stage.status });
    }
    this.logCount = record?.logs.length ?? 0;
  }

  next(record: TraceRecord): { type: 'record'; record: TraceRecord } | { type: 'record-update'; update: RecordUpdate } {
    if (record !== this.record || record.entry !== this.entry || record.entry.source !== this.source || record.logs.length < this.logCount) {
      this.reset(record);
      return { type: 'record', record };
    }
    const { entry: _entry, kernels, logs, ...metadata } = record;
    const update: RecordUpdate = {
      recordId: record.id, metadata,
      kernels: kernels.map(kernel => ({ ...kernel, stages: kernel.stages.filter(stage => {
        const sent = this.stages.get(stage.id);
        const changed = !sent || sent.stage !== stage || sent.status !== stage.status;
        if (changed) this.stages.set(stage.id, { stage, status: stage.status });
        return changed;
      }) })),
      logOffset: this.logCount, logs: logs.slice(this.logCount),
    };
    this.logCount = logs.length;
    return { type: 'record-update', update };
  }
}

/** A mismatched baseline requests a new full snapshot instead of losing data. */
export function applyRecordUpdate(record: TraceRecord | null, update: RecordUpdate): TraceRecord | null {
  if (!record || record.id !== update.recordId || record.logs.length !== update.logOffset) return null;
  const existing = new Map(record.kernels.map(kernel => [kernel.id, kernel]));
  const kernels = update.kernels.map(kernel => {
    const previous = existing.get(kernel.id);
    if (!previous) return kernel;
    if (!kernel.stages.length) return { ...kernel, stages: previous.stages };
    const stages = new Map(previous.stages.map(stage => [stage.id, stage]));
    for (const stage of kernel.stages) stages.set(stage.id, stage);
    return { ...kernel, stages: [...stages.values()].sort((a, b) => a.sequence - b.sequence) };
  });
  return { ...record, ...update.metadata, kernels, logs: [...record.logs, ...update.logs] };
}
