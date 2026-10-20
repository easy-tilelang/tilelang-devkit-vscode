import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowDown, ArrowLeftRight, ArrowUp, Check, CheckCircle2, ChevronDown, ChevronRight, Circle, CircleAlert, Clock3, Code2, Copy, FileCode2, Layers3, LoaderCircle, Moon, PanelLeft, PanelRight, Pencil, Square, Sun, Terminal, WrapText, X, Zap } from 'lucide-react';
import { DevKitMark } from '../shared/brand';
import type { HostMessage, TraceRecord, WebviewMessage } from '../shared/model';
import { applyRecordUpdate } from '../shared/record-update';
import { CodeEditor } from './editor';
import { codeLanguage, describeStage, duration, environmentLabel, lineStats, orderedStages, previousStage } from './trace';
import './style.css';

interface UIState { recordId?: string; selectedId?: string; mode?: 'code' | 'diff'; diffMode?: 'previous' | 'pass'; wrap?: boolean; theme?: 'auto' | 'dark' | 'light'; logs?: boolean; details?: boolean }
interface VSCodeAPI { postMessage(message: WebviewMessage): void; getState(): UIState | undefined; setState(state: UIState): void }
declare function acquireVsCodeApi(): VSCodeAPI;
const vscode = acquireVsCodeApi();
const saved = vscode.getState() ?? {};
const statusNames: Record<string, string> = { running: '编译中', succeeded: '编译完成', failed: '编译失败', cancelled: '已取消', interrupted: '已中断', pending: '等待中' };
const stageStatusNames: Record<string, string> = { running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断', pending: '等待中' };
const kindNames: Record<string, string> = { source: '前端源码', frontend: '初始 IR', pass: '编译 Pass', codegen: '目标代码', jit: 'JIT 编译 / 加载', cache: '缓存命中' };

function send(message: WebviewMessage) { vscode.postMessage(message); }
function hasStage(record: TraceRecord | null, id: string | null | undefined): id is string {
  return typeof id === 'string' && !!record?.kernels.some(kernel => kernel.stages.some(stage => stage.id === id));
}

function StatusIcon({ status, cache = false }: { status: string; cache?: boolean }) {
  if (status === 'running') return <LoaderCircle className="spin" />;
  if (status === 'failed' || status === 'interrupted') return <CircleAlert />;
  if (status === 'cancelled') return <Square />;
  if (cache) return <Zap />;
  return status === 'succeeded' ? <CheckCircle2 /> : <Circle />;
}

function App() {
  const [record, setRecord] = useState<TraceRecord | null>(null);
  const [entryPath, setEntryPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [trusted, setTrusted] = useState(true);
  const [ready, setReady] = useState(false);
  const [selectedId, setSelectedId] = useState(saved.selectedId ?? '');
  const [mode, setMode] = useState<'code' | 'diff'>(saved.mode ?? 'code');
  const [diffMode, setDiffMode] = useState<'previous' | 'pass'>(saved.diffMode ?? 'previous');
  const [wrap, setWrap] = useState(saved.wrap ?? false);
  const [theme, setTheme] = useState<'auto' | 'dark' | 'light'>(saved.theme ?? 'auto');
  const [logs, setLogs] = useState(saved.logs ?? false);
  const [details, setDetails] = useState(window.innerWidth >= 980 && (saved.details ?? true));
  const [width, setWidth] = useState(window.innerWidth);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const runId = useRef<string | null>(saved.recordId ?? null);
  const latestRecord = useRef<TraceRecord | null>(null);
  const compact = width < 980;
  const narrow = width - (details && !compact ? 276 : 0) < 900;

  useEffect(() => {
    const applyRecord = (next: TraceRecord | null, selection: string | null | undefined, explicit: boolean) => {
      const sameRecord = next?.id === runId.current;
      latestRecord.current = next;
      runId.current = next?.id ?? null;
      setRecord(next);
      setSelectedId(current => explicit
        ? hasStage(next, selection) ? selection : ''
        : sameRecord && hasStage(next, current) ? current : '');
    };
    const receive = (event: MessageEvent<HostMessage>) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'request-ready') {
        send({ type: 'ready' });
      } else if (data.type === 'state') {
        applyRecord(data.record, data.selectedStageId, 'selectedStageId' in data);
        setEntryPath(data.config.entryPath); setBusy(data.busy); setTrusted(data.trusted); setReady(true);
      } else if (data.type === 'record') {
        applyRecord(data.record, data.selectedStageId, 'selectedStageId' in data);
        setBusy(data.busy); setReady(true);
      } else if (data.type === 'record-update') {
        const next = applyRecordUpdate(latestRecord.current, data.update);
        if (!next) { send({ type: 'ready' }); return; }
        applyRecord(next, data.selectedStageId, 'selectedStageId' in data);
        setBusy(data.busy); setReady(true);
      } else if (data.type === 'configuration') {
        setEntryPath(data.config.entryPath); setTrusted(data.trusted);
      } else if (data.type === 'reveal-stage') {
        if (latestRecord.current?.id === data.recordId && hasStage(latestRecord.current, data.stageId)) setSelectedId(data.stageId);
      } else if (data.type === 'reveal-error') {
        setLogs(true);
        const stageId = data.stageId ?? latestRecord.current?.error?.stageId;
        if (hasStage(latestRecord.current, stageId)) { setSelectedId(stageId); setMode('code'); }
      } else if (data.type === 'error' || data.type === 'notice') {
        setMessage({ text: data.message, error: data.type === 'error' });
      }
    };
    const breakpoint = window.matchMedia('(max-width: 979px)');
    const collapseDetails = () => { if (breakpoint.matches) setDetails(false); };
    const resize = () => setWidth(window.innerWidth);
    window.addEventListener('message', receive);
    window.addEventListener('resize', resize);
    breakpoint.addEventListener('change', collapseDetails);
    send({ type: 'ready' });
    return () => {
      window.removeEventListener('message', receive); window.removeEventListener('resize', resize);
      breakpoint.removeEventListener('change', collapseDetails);
    };
  }, []);

  useEffect(() => { vscode.setState({ recordId: record?.id, selectedId, mode, diffMode, wrap, theme, logs, details }); }, [record?.id, selectedId, mode, diffMode, wrap, theme, logs, details]);
  useEffect(() => {
    if (!message || message.error) return;
    const timer = window.setTimeout(() => setMessage(null), 4000);
    return () => window.clearTimeout(timer);
  }, [message]);

  const items = useMemo(() => orderedStages(record), [record]);
  const selected = items.find(item => item.stage.id === selectedId) ?? items.find(item => item.stage.kind !== 'source') ?? items[0];
  const previous = selected ? previousStage(items, selected) : undefined;
  const stage = selected?.stage;
  const previousText = diffMode === 'pass' ? stage?.beforeText : previous?.stage.afterText;
  const canDiff = previousText != null && stage?.afterText != null;
  const text = stage?.afterText ?? stage?.beforeText ?? '';
  const comparison = useMemo(() => stage?.afterText != null && previousText != null ? lineStats(previousText, stage.afterText) : null, [stage?.afterText, previousText]);
  const comparisonTitle = diffMode === 'pass' ? '本次阶段输入 → 输出' : '上一阶段 → 当前阶段';
  const selectStage = useCallback((id: string) => {
    const current = latestRecord.current;
    if (!current || !hasStage(current, id)) return;
    setSelectedId(id);
    send({ type: 'stage-selected', recordId: current.id, stageId: id });
  }, []);
  const navigate = useCallback((direction: number) => {
    if (!items.length) return;
    const current = items.findIndex(item => item.stage.id === selected?.stage.id);
    const next = Math.max(0, Math.min(items.length - 1, current + direction));
    if (next !== current) selectStage(items[next].stage.id);
  }, [items, selected?.stage.id, selectStage]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault(); navigate(event.key === 'ArrowUp' ? -1 : 1);
      }
      const target = event.target as HTMLElement;
      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) && !target.isContentEditable) {
        event.preventDefault(); send({ type: 'focus-sidebar' });
      }
      if (event.key === 'Escape') setDetails(false);
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [navigate]);

  const scriptMode = record?.entry.mode === 'script';
  const requestNumber = (id: string) => (record?.kernels.findIndex(item => item.id === id) ?? -1) + 1;
  const requestLabel = (id: string, name: string) => scriptMode ? `${name} · 请求 #${requestNumber(id)}` : name;
  const noObservedJit = scriptMode && record?.status === 'succeeded' && record.kernels.length === 0;
  const runStatus = record ? scriptMode ? ({ running: '脚本执行中', succeeded: '脚本执行完成', failed: '脚本执行失败', cancelled: '已取消', interrupted: '已中断' }[record.status]) : statusNames[record.status] : ready ? '等待编译记录' : '连接工作台…';
  const activeIndex = items.findIndex(item => item.stage.id === stage?.id);
  const language = stage?.afterText == null ? stage?.beforeLanguage ?? 'text' : stage.afterLanguage;
  const fileName = record?.entry.path.replace(/\\/g, '/').split('/').pop();
  const stageNavigation = <div className="stage-pagination"><span className="stage-position" title="完整执行序列">{stage ? activeIndex + 1 : 0} / {items.length}</span><button className="icon-button" aria-label="上一阶段" title="上一阶段 · Alt+↑" disabled={activeIndex <= 0} onClick={() => navigate(-1)}><ArrowUp /></button><button className="icon-button" aria-label="下一阶段" title="下一阶段 · Alt+↓" disabled={!items.length || activeIndex >= items.length - 1} onClick={() => navigate(1)}><ArrowDown /></button></div>;
  const detailsToggle = <button className={`icon-button ${details ? 'is-active' : ''}`} data-testid="details-toggle" aria-label="阶段详情" aria-expanded={details} aria-controls="stage-details" title="展开或收起阶段详情" onClick={() => setDetails(!details)}><PanelRight /></button>;

  return <div className="workbench" data-theme={theme}>
    <header className="viewer-header">
      <div className="viewer-title"><span className="viewer-mark"><DevKitMark /></span><div><span className="eyebrow" title={selected ? requestLabel(selected.kernel.id, selected.kernel.name) : undefined}>{selected ? `${requestLabel(selected.kernel.id, selected.kernel.name)} / ${kindNames[selected.stage.kind]}` : record?.entry.source ? 'FRONTEND SOURCE SNAPSHOT' : 'LOWER TRACE'}</span><h1 data-testid="stage-heading" title={stage?.name}>{stage?.name ?? (record?.entry.source ? '入口源码快照' : '编译阶段查看器')}{selected && selected.repetitions > 1 && <span className="occurrence">第 {selected.occurrence} 次</span>}</h1></div></div>
      <div className="header-actions"><button className="quiet sidebar-link" data-testid="focus-sidebar" title="编译控制与阶段导航 · /" onClick={() => send({ type: 'focus-sidebar' })}><PanelLeft /><span>编译控制与阶段导航</span></button><button className="icon-button" data-testid="edit-source" aria-label="编辑入口脚本" title={entryPath ? `编辑已配置的入口脚本：${entryPath}` : '请先在侧栏配置入口脚本'} disabled={!entryPath} onClick={() => send({ type: 'edit-source' })}><Pencil /></button><button className="icon-button" aria-label={`切换主题，当前${theme === 'auto' ? '跟随 VS Code' : theme === 'dark' ? '深色' : '浅色'}`} title={`主题：${theme === 'auto' ? '跟随 VS Code' : theme === 'dark' ? '深色' : '浅色'}`} data-testid="theme-toggle" onClick={() => setTheme(theme === 'auto' ? 'dark' : theme === 'dark' ? 'light' : 'auto')}>{theme === 'light' ? <Sun /> : theme === 'dark' ? <Moon /> : <Circle />}</button></div>
    </header>
    <div className="record-strip" aria-label="编译状态"><div className={`run-status ${busy ? 'running' : record?.status ?? ''}`} role="status"><StatusIcon status={busy ? 'running' : record?.status ?? 'pending'} /><strong>{busy ? '脚本执行中' : runStatus}</strong>{busy && <span className="live-label">实时采集中</span>}</div>{record && <><span className="record-file" title={record.entry.path}><FileCode2 />{fileName}</span><span className="record-duration"><Clock3 />{duration(record.durationMs)}</span><span className="environment-label" title={record.environment.tilelangPath}>{environmentLabel(record)}</span></>}</div>
    {!trusted && <div className="banner warning"><CircleAlert /><span>当前工作区未受信任。可以查看离线记录；信任工作区后可从侧栏执行 Python 脚本。</span></div>}
    {record?.provenance === 'mock' && <div className="banner mock-banner" data-testid="mock-banner"><span className="label-pill">MOCK</span><span>交互示例数据 <span className="banner-detail">· 此记录用于演示界面，不是真实编译结果</span></span><span className="banner-tail">离线可用</span></div>}
    {noObservedJit && <div className="banner no-jit-banner" data-testid="no-jit-banner" role="status"><CircleAlert /><span>脚本执行成功，但未观察到 TileLang JIT 调用。这不表示缓存命中。<span className="banner-detail">可检查脚本是否触发了编译入口。</span></span></div>}
    {message && <div className={`banner ${message.error ? 'error-banner' : 'notice-banner'}`} role={message.error ? 'alert' : 'status'}>{message.error ? <CircleAlert /> : <Check />}<span>{message.text}</span><button className="icon-button" aria-label="关闭通知" onClick={() => setMessage(null)}><X /></button></div>}
    <div className={`viewer-grid ${details && record ? 'with-details' : ''}`}>
      <main className="code-panel" aria-label="阶段代码与 Diff">
        {stage ? <>
          <div className="editor-toolbar"><div className="view-tabs" role="tablist" aria-label="代码视图"><button role="tab" data-testid="code-tab" aria-selected={mode === 'code'} className={mode === 'code' ? 'active' : ''} onClick={() => setMode('code')}><Code2 /> 代码</button><button role="tab" data-testid="diff-tab" aria-selected={mode === 'diff'} className={mode === 'diff' ? 'active' : ''} onClick={() => setMode('diff')}><ArrowLeftRight /> Diff</button></div>{stageNavigation}<div className="editor-actions"><span className="language-label">{codeLanguage(language, record?.environment.target.kind)}</span><button className={`icon-button ${wrap ? 'is-active' : ''}`} data-testid="wrap-toggle" aria-label="自动换行" aria-pressed={wrap} title="自动换行" onClick={() => setWrap(!wrap)}><WrapText /></button><button className="icon-button" data-testid="copy-button" aria-label="复制当前代码" title="复制当前代码" onClick={() => send({ type: 'copy', text })} disabled={!text}><Copy /></button>{detailsToggle}</div></div>
          {mode === 'diff' && <div className="diff-toolbar"><select data-testid="diff-mode" aria-label="Diff 比较范围" value={diffMode} onChange={e => setDiffMode(e.target.value as 'previous' | 'pass')}><option value="previous">与同 kernel 上一阶段比较</option><option value="pass">本次阶段输入 / 输出</option></select>{canDiff && <span className="diff-counts"><span className="added">+{comparison?.added ?? '—'}</span><span className="deleted">−{comparison?.deleted ?? '—'}</span></span>}</div>}
          {mode === 'diff' && canDiff && <div className={`diff-labels ${narrow ? 'unified' : ''}`}><span><span className="deleted-dot" />{diffMode === 'pass' ? '阶段输入' : previous?.stage.name}</span><span><span className="added-dot" />{stage.name}{narrow ? ' · 合并视图' : ' · 输出'}</span></div>}
          {stage.status === 'failed' && <div className="inline-state failure-text"><CircleAlert /> 此阶段失败{stage.afterText == null && stage.beforeText != null ? '，以下保留失败前的输入快照' : ''}。</div>}
          {mode === 'diff' && !canDiff ? <div className="content-empty"><ArrowLeftRight /><h3>此阶段暂无可比较的输出</h3><p>{diffMode === 'previous' && !previous ? '这是此 kernel 的第一个阶段，没有上一阶段。' : diffMode === 'previous' && previous?.stage.afterText == null ? '同 kernel 的上一阶段没有输出快照，无法进行比较。' : stage.afterText == null ? '阶段尚未生成输出，已采集内容仍保留在代码视图。' : '此阶段没有采集输入快照。可以切换为与上一阶段比较。'}</p><button className="button secondary" onClick={() => setMode('code')}>查看代码</button></div> : stage.afterText == null && stage.beforeText == null ? <div className="content-empty">{stage.kind === 'cache' ? <Zap /> : <Code2 />}<h3>{stage.kind === 'cache' ? '此次调用命中缓存' : stage.status === 'running' ? '正在采集当前阶段' : stage.kind === 'jit' ? 'JIT 阶段已记录' : '此阶段没有代码快照'}</h3><p>{stage.kind === 'cache' ? '该调用未重新执行 Lowering Pass。记录保留真实缓存事件，不生成虚构阶段。' : stage.kind === 'jit' ? '此步骤没有文本形式的代码输出。可打开阶段详情查看编译或加载状态、耗时，并在日志中查看详细信息。' : '可打开阶段详情查看阶段状态，在日志中查看编译信息。'}</p></div> : <CodeEditor text={text} language={language} before={canDiff ? previousText! : undefined} beforeLanguage={diffMode === 'pass' ? stage.beforeLanguage : previous?.stage.afterLanguage} diff={mode === 'diff'} wrap={wrap} narrow={narrow} label={mode === 'diff' ? comparisonTitle : stage.name} />}
          <div className="code-footer"><span>{(activeIndex + 1).toString().padStart(2, '0')} <span className="footer-separator">/</span> {items.length} 阶段</span><span>{text ? `${text.split('\n').length.toLocaleString()} 行` : '无代码快照'}<span className="footer-separator">·</span>只读快照</span>{mode === 'diff' && canDiff && <span>{comparison?.added === 0 && comparison.deleted === 0 ? '比较内容完全一致' : '文本变化不代表性能收益'}</span>}</div>
        </> : record?.entry.source ? <>
          <div className="editor-toolbar"><span className="source-snapshot-label"><FileCode2 /> 入口源码 · {noObservedJit ? '未观察到 JIT' : '尚未产生 IR'}</span>{stageNavigation}<div className="editor-actions"><span className="language-label">Python</span><button className={`icon-button ${wrap ? 'is-active' : ''}`} data-testid="wrap-toggle" aria-label="自动换行" aria-pressed={wrap} title="自动换行" onClick={() => setWrap(!wrap)}><WrapText /></button><button className="icon-button" data-testid="copy-button" aria-label="复制当前代码" title="复制当前代码" onClick={() => send({ type: 'copy', text: record.entry.source })}><Copy /></button>{detailsToggle}</div></div>
          <CodeEditor text={record.entry.source} language="python" diff={false} wrap={wrap} narrow={narrow} label="入口源码快照" />
          <div className="code-footer"><span>入口源码已保留 · {noObservedJit ? '未观察到 JIT' : '尚未产生 IR'}</span><span>{record.entry.source.split('\n').length.toLocaleString()} 行<span className="footer-separator">·</span>只读快照</span></div>
        </> : <div className="welcome"><div className="welcome-illustration"><span className="illustration-file"><FileCode2 /></span><span className="illustration-track"><i /><i /><i /></span><span className="illustration-layers"><Layers3 /></span><span className="illustration-track"><i /><i /><i /></span><span className="illustration-code"><Code2 /></span></div><span className="eyebrow">TILELANG COMPILATION VIEWER</span><h2>逐阶段阅读，理解每一次变换</h2><p>在侧栏运行脚本或打开记录，选择一个阶段，<br />在这里查看完整代码、Diff 与执行信息。</p><div className="welcome-actions"><button className="button primary" onClick={() => send({ type: 'focus-sidebar' })}><PanelLeft /> 打开编译控制与阶段导航</button></div><div className="welcome-note"><span><Check /> 真实执行顺序</span><span><Check /> 逐步 Diff</span><span><Check /> 离线浏览</span></div></div>}

        {record?.error && <div className="run-error" role="alert"><CircleAlert /><div><strong>{record.error.phase} · {record.error.message}</strong><p>{items.length ? `已采集的 ${items.length} 个阶段仍可浏览和导出。` : '入口源码与错误信息已保留，可导出记录。'}</p>{record.error.stageId && <button className="text-button" onClick={() => selectStage(record.error!.stageId!)}>定位失败阶段 <ChevronRight /></button>}</div></div>}
        <div className={`log-panel ${logs ? 'expanded' : ''}`}><button className="log-toggle" data-testid="logs-toggle" onClick={() => setLogs(!logs)} aria-expanded={logs}><Terminal /><span>编译日志</span><span className="log-count">{record?.logs.length ?? 0}</span>{record?.error && <span className="failure-text">含错误信息</span>}<ChevronDown className={logs ? 'flipped' : ''} /></button>{logs && <div className="log-content" role="log" aria-label="编译日志">{record?.logs.length ? record.logs.map((entry, i) => <div className={`log-entry ${entry.stream}`} key={`${entry.timestamp}-${i}`}><time>{entry.timestamp.slice(11, 23)}</time><span className="log-stream">{entry.stream}</span><pre>{entry.text}</pre></div>) : <p className="muted">编译输出将在此显示。</p>}{record?.error?.traceback && <pre className="traceback">{record.error.traceback}</pre>}</div>}</div>
      </main>
      {details && record && <>
        {compact && <button className="inspector-backdrop" aria-label="收起阶段详情" onClick={() => setDetails(false)} />}
      <aside id="stage-details" className="inspector" aria-label="阶段详情"><div className="section-heading"><h2>阶段详情</h2><button className="icon-button inspector-close" aria-label="关闭阶段详情" onClick={() => setDetails(false)}><X /></button></div>{stage && selected ? <>
        <section className="inspector-section"><span className={`kind-badge ${stage.kind}`}>{kindNames[stage.kind]}</span><h3>{stage.name}</h3><p className="description">{describeStage(stage)}</p></section>
        <section className="inspector-section"><h4>执行信息</h4><dl><div><dt>状态</dt><dd className={stage.status}><StatusIcon status={stage.status} />{stageStatusNames[stage.status]}</dd></div><div><dt>耗时</dt><dd className="mono">{duration(stage.durationMs)}</dd></div><div><dt>Kernel</dt><dd title={selected.kernel.symbol}>{selected.kernel.name}</dd></div>{scriptMode && <div><dt>JIT 请求</dt><dd className="mono">#{requestNumber(selected.kernel.id)} / {record?.kernels.length}</dd></div>}<div><dt>执行序号</dt><dd className="mono">#{stage.sequence}</dd></div>{selected.repetitions > 1 && <div><dt>同名执行</dt><dd>第 {selected.occurrence} / {selected.repetitions} 次</dd></div>}<div><dt>阶段分组</dt><dd>{stage.phase ?? '—'}</dd></div>{stage.parentId && <div><dt>父阶段</dt><dd>{items.find(item => item.stage.id === stage.parentId)?.stage.name ?? stage.parentId}</dd></div>}<div><dt>缓存</dt><dd>{selected.kernel.cache === 'hit' ? '命中' : selected.kernel.cache === 'miss' ? '未命中' : selected.kernel.cache === 'not-applicable' ? '不适用' : selected.kernel.cache === 'disabled' ? '已禁用' : '未知'}</dd></div>{selected.kernel.cacheSource && <div><dt>缓存来源</dt><dd>{{ memory: '内存', disk: '磁盘', decorator: '装饰器', disabled: '已禁用', unknown: '未知' }[selected.kernel.cacheSource]}</dd></div>}</dl>{stage.durationMs == null && <p className="detail-note">此阶段未提供可用耗时。</p>}<p className="detail-note">耗时为 instrumentation 记录的墙钟时间，可能包含子 Pass，请勿直接相加。</p></section>

        <section className="inspector-section"><h4>本次阶段变化</h4><p className="detail-note">记录中的输入 → 输出</p><div className="change-cards"><div><span className="added">{stage.added == null ? '—' : `+${stage.added}`}</span><small>新增行</small></div><div><span className="deleted">{stage.deleted == null ? '—' : `−${stage.deleted}`}</span><small>删除行</small></div></div><div className={`change-state ${stage.changed === false ? 'unchanged' : ''}`}>{stage.changed === false ? <><Check /> 输入与输出相同</> : stage.changed === true ? <><ArrowLeftRight /> 代码发生变化</> : <><Circle /> 未提供变化统计</>}</div></section>
        {mode === 'diff' && <section className="inspector-section"><h4>当前 Diff</h4><p className="detail-note">{comparisonTitle}</p><p className="comparison-summary">{canDiff ? <><span className="added">+{comparison?.added ?? '—'}</span> / <span className="deleted">−{comparison?.deleted ?? '—'}</span> 行</> : '暂无可比较内容'}</p><p className="detail-note">比较始终使用完整执行序列，侧栏搜索和筛选不会改变比较基准。</p></section>}
        {record && <section className="inspector-section"><h4>此记录的编译环境</h4><p className="record-environment">{environmentLabel(record)}</p><p className="detail-note">{record.entry.mode === 'script' ? `脚本运行 · ${(record.entry.args ?? []).length} 个参数` : '函数入口'}{record.entry.cwd ? ` · ${record.entry.cwd}` : ''}</p></section>}
        {stage.error && <section className="inspector-section stage-error"><h4>阶段错误</h4><p>{stage.error.message}</p></section>}
        <div className="inspector-footnote"><CircleAlert /><p>说明用于理解编译变换。<br />不根据代码变化推测性能收益。</p></div>
      </> : <div className="inspector-empty"><Code2 /><p>{noObservedJit ? <>脚本未触发可观察的 JIT 调用<br />没有可展示的编译阶段</> : <>选择一个阶段，查看<br />变换说明与执行信息</>}</p></div>}</aside>
      </>}
    </div>
    <footer className="statusbar"><span><span className={`status-dot ${busy ? 'is-running' : ''}`} />{busy ? '采集任务正在运行' : record ? `${record.provenance === 'mock' ? '示例记录' : '编译记录'} · ${record.id}` : 'TileLang DevKit · Lower Trace'}</span><span className="keyboard-hint">Alt ↑ ↓ 切换阶段<span className="footer-separator">·</span>/ 阶段导航</span><span>只读 · 记录格式 v1</span></footer>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
