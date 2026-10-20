import { diffLines } from 'diff';
import type { Kernel, Language, Stage, TraceRecord } from '../shared/model';

export interface StageItem { stage: Stage; kernel: Kernel; occurrence: number; repetitions: number }

export function orderedStages(record: TraceRecord | null): StageItem[] {
  return (record?.kernels.flatMap(kernel => {
    const stages = [...kernel.stages].sort((a, b) => a.sequence - b.sequence);
    const counts = new Map<string, number>();
    const seen = new Map<string, number>();
    for (const stage of stages) counts.set(stage.name, (counts.get(stage.name) ?? 0) + 1);
    return stages.map(stage => {
      const occurrence = (seen.get(stage.name) ?? 0) + 1;
      seen.set(stage.name, occurrence);
      return { stage, kernel, occurrence, repetitions: counts.get(stage.name)! };
    });
  }) ?? []).sort((a, b) => a.stage.sequence - b.stage.sequence);
}

export function previousStage(items: StageItem[], selected: StageItem): StageItem | undefined {
  const index = items.findIndex(item => item.stage.id === selected.stage.id);
  return items.slice(0, index).reverse().find(item => item.kernel.id === selected.kernel.id);
}

export function lineStats(before: string, after: string): { added: number; deleted: number } | null {
  const changes = diffLines(before, after, { timeout: 150 });
  if (!changes) return null;
  return changes.reduce((stats, change) => ({
    added: stats.added + (change.added ? change.count ?? 0 : 0),
    deleted: stats.deleted + (change.removed ? change.count ?? 0 : 0),
  }), { added: 0, deleted: 0 });
}

export function codeLanguage(language: Language, target?: string): string {
  return language === 'python' ? 'Python / TIR' : language === 'cpp' ? target === 'ascend' ? 'C++ / Ascend C' : 'C / C++' : 'Text';
}

export function environmentLabel(record: TraceRecord): string {
  const environment = record.environment;
  const target = environment.target.kind === 'c' ? 'CPU C' : environment.target.kind;
  return [
    `TileLang ${environment.tilelangVersion}`,
    `${target}${environment.target.arch ? ` / ${environment.target.arch}` : ''}`,
    environment.executionBackend,
    environment.compilationMode === 'jit' ? '完整 JIT' : environment.compilationMode === 'source' ? '仅源码' : record.entry.mode !== 'script' ? '函数入口' : undefined,
  ].filter(Boolean).join(' · ');
}

export function duration(value: number | null | undefined): string {
  if (value == null) return '—';
  if (value < 1) return `${value.toFixed(2)} ms`;
  if (value < 1000) return `${value.toFixed(1)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

const descriptions: Record<string, string> = {
  Simplify: '简化 IR 中的表达式和控制流。可通过输入与输出查看这一遍简化实际修改的内容。',
  'tir.Simplify': '简化 TIR 中的算术表达式与控制流；同名 Pass 可能在编译过程中多次执行。',
  'tirx.Simplify': '简化 TIRX 中的算术表达式与控制流；同名 Pass 可能在编译过程中多次执行。',
  LayoutInference: '为线程与缓冲区推导布局信息，供后续 Tile 运算的展开与数据访问使用。',
  LowerTileOp: '把 TileLang 的 Tile 运算展开为目标相关的底层 IR。',
  LowerTileOps: '把 TileLang 的 Tile 运算展开为目标相关的底层 IR。',
  InferFragment: '推导 fragment 的布局与线程分配信息。',
  FlattenBuffer: '把多维缓冲区访问转换成底层索引形式。',
  VectorizeLoop: '对满足条件的循环应用向量化转换。',
  StorageRewrite: '重写临时存储及其访问形式。',
  ThreadSync: '分析并插入需要的线程同步。',
  SplitHostDevice: '将模块中的主机端逻辑与设备端逻辑分离。',
  LowerInitBlock: '展开块的初始化逻辑。',
  BindTarget: '把目标后端信息绑定到 IR，供后续编译阶段读取。',
  Legalize: '将运算转换为当前编译路径支持的合法表达形式。',
};

export function describeStage(stage: Stage): string {
  if (stage.kind === 'source') return '此次运行读取的前端 Python 源码快照。记录保留原文，离线打开时不需要访问原文件。';
  if (stage.kind === 'frontend') return '编译入口产生的初始 PrimFunc / IRModule。这是后续 Lowering 和 Pass 变换的起点。';
  if (stage.kind === 'codegen') return '记录中目标后端生成的代码。生成源码本身不等于 native 编译或动态加载完成；这些步骤会由后续实际发生的阶段单独记录。';
  if (stage.kind === 'jit' && stage.name === 'native_compile') return '将生成的 native wrapper 源码交给本机编译器构建动态库。代码视图保留采集到的完整 wrapper；编译成功后仍需动态加载模块。';
  if (stage.kind === 'jit' && stage.name === 'module_load') return '动态加载已生成的 native 模块，并建立可供调用的运行时入口。此步骤通常没有新的文本代码输出，状态与耗时单独保留。';
  if (stage.kind === 'jit') return 'JIT 的 native 编译或动态加载阶段，具体步骤见阶段名称。若采集到 wrapper 源码，会展示其完整快照；没有代码快照时仍保留状态与耗时。';
  if (stage.kind === 'cache') return '此次调用记录到缓存命中。缓存返回不会重新执行所有编译 Pass，因此记录中不会补造缺失阶段。';
  return descriptions[stage.name] ?? descriptions[stage.name.split('.').at(-1) ?? ''] ?? '暂无阶段说明。可以查看本次 Pass 的输入与输出，确认此次执行实际修改的内容。';
}
