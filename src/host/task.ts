import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { RecordEventStream, emptyRecord, endIncomplete, EventDecoder, parseRecord, validateConfig } from '../shared/record';
import type { CompileConfig, TraceRecord } from '../shared/model';

export interface TaskOptions {
  storagePath: string;
  runnerPath: string;
  onChange: (record: TraceRecord, busy: boolean) => void;
  onLog?: (text: string) => void;
  cancelGraceMs?: number;
  snapshotIntervalMs?: number;
  retainRunFiles?: boolean;
}

export class CompilationTask {
  record: TraceRecord | null = null;
  busy = false;
  private child?: ChildProcess;
  private cancellationRequested = false;
  private completion?: Promise<void>;
  private disposed = false;
  private finishing = false;
  private cancelTimers: NodeJS.Timeout[] = [];
  private saveQueue: Promise<void> = Promise.resolve();
  private logBytes = 0;
  private logTruncated = false;

  constructor(private options: TaskOptions) {}

  private notify(): void {
    if (this.record) this.options.onChange(this.record, this.busy);
  }

  private log(text: string, stream: 'stdout' | 'stderr' | 'system'): void {
    if (!this.record || !text) return;
    this.options.onLog?.(text);
    this.logBytes += Buffer.byteLength(text);
    if (this.logBytes > 8 * 1024 * 1024) {
      if (this.logTruncated) return;
      this.logTruncated = true;
      text = '\n日志超过 8 MiB，记录中的后续日志已省略。阶段与源码继续完整采集。\n';
      stream = 'system';
    }
    this.record.logs.push({ timestamp: new Date().toISOString(), stream, text });
    this.notify();
  }

  async persist(): Promise<void> {
    if (!this.record) return;
    const text = JSON.stringify(this.record);
    this.saveQueue = this.saveQueue.catch(() => {}).then(async () => {
      await fs.mkdir(this.options.storagePath, { recursive: true });
      const file = path.join(this.options.storagePath, 'latest.tltrace.json');
      await fs.writeFile(`${file}.tmp`, text, 'utf8');
      await fs.rename(`${file}.tmp`, file);
    });
    return this.saveQueue;
  }

  async restore(): Promise<TraceRecord | null> {
    try {
      const record = parseRecord(await fs.readFile(path.join(this.options.storagePath, 'latest.tltrace.json'), 'utf8'));
      if (record.status === 'running') {
        endIncomplete(record, 'interrupted');
        record.logs.push({ timestamp: new Date().toISOString(), stream: 'system', text: '上次采集进程已结束；恢复了已保存的部分记录。' });
      }
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async start(config: CompileConfig, cwd: string): Promise<void> {
    if (this.disposed) throw new Error('编译任务已销毁');
    if (this.busy) throw new Error('已有编译任务正在运行');
    config = validateConfig(config);
    config.workingDirectory = path.resolve(cwd, config.workingDirectory || '.');
    config.entryPath = path.resolve(cwd, config.entryPath);
    this.busy = true;
    this.cancellationRequested = false;
    this.finishing = false;
    this.logBytes = 0;
    this.logTruncated = false;
    this.record = emptyRecord(randomUUID(), config, '');
    // Install the entire lifecycle before notifying consumers or doing any I/O.
    this.completion = Promise.resolve().then(() => this.run(config));
    return this.completion;
  }

  private async run(config: CompileConfig): Promise<void> {
    const started = performance.now();
    if (!this.record) throw new Error('缺少运行记录');
    const id = this.record.id;
    const dir = path.join(this.options.storagePath, 'runs', id);
    try {
      this.notify();
      this.record.entry.source = await fs.readFile(config.entryPath, 'utf8');
      await fs.mkdir(dir, { recursive: true });
      const requestFile = path.join(dir, 'request.json');
      const eventsFile = path.join(dir, 'events.jsonl');
      const tempDirectory = process.env.TMPDIR || path.join(dir, 'tmp');
      await fs.mkdir(tempDirectory, { recursive: true });
      await fs.writeFile(requestFile, JSON.stringify({
        id, entryPath: config.entryPath, scriptArgs: config.scriptArgs,
        workingDirectory: config.workingDirectory, disableCache: config.disableCache,
        target: { kind: 'c' }, executionBackend: 'cython',
      }));
      await this.persist();
      if (this.cancellationRequested) {
        endIncomplete(this.record, 'cancelled');
        return;
      }
      const child = spawn(config.pythonPath, ['-u', this.options.runnerPath, '--request', requestFile, '--events', eventsFile], {
        cwd: config.workingDirectory, shell: false, detached: process.platform !== 'win32',
        env: { ...process.env, TMPDIR: tempDirectory, PYTHONUNBUFFERED: '1', TL_LOWER_TRACE: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;
      const stdout = new StringDecoder('utf8');
      const stderr = new StringDecoder('utf8');
      child.stdout?.on('data', data => this.log(stdout.write(data), 'stdout'));
      child.stderr?.on('data', data => this.log(stderr.write(data), 'stderr'));
      const decoder = new EventDecoder();
      const events = new RecordEventStream(this.record);
      let offset = 0;
      let polling: Promise<void> | undefined;
      let protocolError: Error | undefined;
      let lastSnapshot = performance.now();
      let snapshotDirty = false;
      let savedLogCount = this.record.logs.length;
      const drain = async (): Promise<void> => {
        if (polling) { await polling; return drain(); }
        polling = (async () => {
          const previousOffset = offset;
          let handle: fs.FileHandle;
          try { handle = await fs.open(eventsFile, 'r'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
          try {
            const size = (await handle.stat()).size;
            while (offset < size) {
              const buffer = Buffer.alloc(Math.min(size - offset, 1024 * 1024));
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
              if (!bytesRead) break;
              offset += bytesRead;
              for (const event of decoder.push(buffer.subarray(0, bytesRead))) this.record = events.apply(event);
            }
          } finally { await handle.close(); }
          if (offset !== previousOffset) { snapshotDirty = true; this.notify(); }
          if ((snapshotDirty || savedLogCount !== this.record!.logs.length) && performance.now() - lastSnapshot >= (this.options.snapshotIntervalMs ?? 1000)) {
            const logCount = this.record!.logs.length;
            await this.persist();
            snapshotDirty = false;
            savedLogCount = logCount;
            lastSnapshot = performance.now();
          }
        })();
        try { await polling; } finally { polling = undefined; }
      };
      const interval = setInterval(() => {
        if (polling || protocolError) return;
        void drain().catch(error => {
          protocolError = error instanceof Error ? error : new Error(String(error));
          this.signal('SIGTERM');
          this.cancelTimers.push(setTimeout(() => this.signal('SIGKILL'), this.options.cancelGraceMs ?? 2000));
        });
      }, 100);
      let spawnError: Error | undefined;
      await new Promise<void>(resolve => {
        child.once('error', error => { spawnError = error; });
        child.once('close', async (code, signal) => {
          clearInterval(interval);
          this.cancelTimers.forEach(clearTimeout);
          this.cancelTimers = [];
          try {
            await polling;
            if (!protocolError) await drain();
            this.log(stdout.end(), 'stdout');
            this.log(stderr.end(), 'stderr');
            if (decoder.hasPartialLine) this.log('进程结束时留下未完成的事件行；已保留此前完整事件。\n', 'system');
            if (this.cancellationRequested) endIncomplete(this.record!, 'cancelled');
            else if (spawnError || protocolError || code !== 0 || this.record!.status === 'running') {
              const error = spawnError ?? protocolError;
              if (!this.record!.error) this.record!.error = {
                phase: spawnError ? 'environment' : protocolError ? 'protocol' : 'process',
                message: error?.message ?? `Python 进程未完成采集（退出码 ${code ?? '—'}，信号 ${signal ?? '—'}）`,
              };
              endIncomplete(this.record!, 'failed');
            }
          } catch (error) {
            if (this.record) {
              this.record.error = { phase: 'protocol', message: error instanceof Error ? error.message : String(error) };
              endIncomplete(this.record, this.cancellationRequested ? 'cancelled' : 'failed');
            }
          } finally { resolve(); }
        });
      });
    } catch (error) {
      this.record.error = { phase: 'environment', message: error instanceof Error ? error.message : String(error) };
      endIncomplete(this.record, this.cancellationRequested ? 'cancelled' : 'failed');
    } finally {
      this.finishing = true;
      this.cancelTimers.forEach(clearTimeout);
      this.cancelTimers = [];
      if (this.record.durationMs === null) this.record.durationMs = performance.now() - started;
      this.child = undefined;
      try {
        // Only remove our own run directory after the final snapshot is durable.
        await this.persist();
        if (!this.options.retainRunFiles) {
          await fs.rm(dir, { recursive: true, force: true }).catch(error => {
            this.options.onLog?.(`无法清理运行目录 ${dir}: ${String(error)}\n`);
          });
        }
      } finally {
        this.busy = false;
        this.notify();
      }
    }
  }

  private signal(signal: NodeJS.Signals): void {
    const pid = this.child?.pid;
    if (!pid) return;
    try {
      if (process.platform === 'win32') this.child?.kill(signal);
      else process.kill(-pid, signal);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') this.log(String(error), 'system'); }
  }

  cancel(): void {
    if (!this.busy || this.cancellationRequested || this.finishing) return;
    this.cancellationRequested = true;
    this.log('正在取消编译，保留已采集的阶段…\n', 'system');
    this.signal('SIGINT');
    const grace = this.options.cancelGraceMs ?? 2000;
    this.cancelTimers.push(setTimeout(() => this.signal('SIGTERM'), grace), setTimeout(() => this.signal('SIGKILL'), grace * 2));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancel();
    await this.completion;
    await this.saveQueue;
  }
}
