import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUpRight, Check, ChevronDown, Circle, CircleAlert, Clock3, Cpu, Download, FileCode2, FolderOpen, Layers3, ListFilter, LoaderCircle, Moon, Play, Search, Settings2, Square, Sun, Upload, X, Zap } from 'lucide-react';
import { DevKitMark } from '../shared/brand';
import type { CompileConfig } from '../shared/model';
import type { SidebarAction, SidebarHostMessage, SidebarMessage, SidebarStage, SidebarState } from '../shared/sidebar';
import './style.css';

type Theme = 'auto' | 'dark' | 'light';
interface SavedState {
  theme?: Theme; draft?: CompileConfig; argsText?: string; baseConfig?: string; configRevision?: number;
  search?: string; kernel?: string; hideUnchanged?: boolean; advanced?: boolean; configOpen?: boolean; recordId?: string; selectedStageId?: string | null;
}
interface VSCodeAPI { postMessage(message: SidebarMessage): void; getState(): SavedState | undefined; setState(state: SavedState): void; }
declare function acquireVsCodeApi(): VSCodeAPI;
const vscode = acquireVsCodeApi();
const saved = vscode.getState() ?? {};
const defaultConfig: CompileConfig = { entryPath: '', scriptArgs: [], pythonPath: 'python', workingDirectory: '', disableCache: false };
const emptyState: SidebarState = { busy: false, trusted: true, currentFile: null, record: null, config: defaultConfig, configRevision: 0, selectedStageId: null };
const statusLabels: Record<string, string> = { running: '正在运行', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
const kindNames: Record<SidebarStage['kind'], string> = { source: '源码', frontend: '前端 IR', pass: 'Pass', codegen: '目标代码', jit: 'JIT', cache: '缓存' };
function duration(value: number | null): string {
  if (value === null) return '—';
  if (value < 1) return `${value.toFixed(2)} ms`;
  if (value < 1000) return `${value.toFixed(1)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}
function RunIcon({ status, cache = false }: { status: string; cache?: boolean }) {
  if (status === 'running') return <LoaderCircle className="spin" />;
  if (status === 'failed' || status === 'interrupted') return <CircleAlert />;
  if (cache) return <Zap />;
  return status === 'succeeded' ? <Check /> : <Circle />;
}
function parseArgs(text: string): { args: string[]; error?: string } {
  try { const value: unknown = JSON.parse(text); return Array.isArray(value) && value.every(item => typeof item === 'string') ? { args: value } : { args: [], error: '参数必须是 JSON 字符串数组，例如 ["--size", "256"]。' }; }
  catch { return { args: [], error: '参数 JSON 无效，请填写字符串数组，例如 []。' }; }
}

function App() {
  const [state, setState] = useState<SidebarState>(emptyState);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(saved.theme ?? 'auto');
  const [draft, setDraft] = useState<CompileConfig>(saved.draft ?? defaultConfig);
  const [argsText, setArgsText] = useState(saved.argsText ?? JSON.stringify(saved.draft?.scriptArgs ?? []));
  const [advanced, setAdvanced] = useState(saved.advanced ?? false);
  const [configOpen, setConfigOpen] = useState(saved.configOpen ?? true);
  const [search, setSearch] = useState(saved.search ?? '');
  const [kernel, setKernel] = useState(saved.kernel ?? 'all');
  const [hideUnchanged, setHideUnchanged] = useState(saved.hideUnchanged ?? false);
  const baseConfig = useRef(saved.baseConfig);
  const configRevision = useRef(saved.configRevision);
  const recordId = useRef(saved.recordId);
  const selectedId = useRef<string | null>(saved.selectedStageId ?? null);
  const searchRef = useRef<HTMLInputElement>(null);
  const filters = useRef({ search, kernel, hideUnchanged });
  filters.current = { search, kernel, hideUnchanged };
  useEffect(() => {
    const receive = (event: MessageEvent<SidebarHostMessage>) => {
      const message = event.data;
      if (!message || typeof message !== 'object') return;
      if (message.type === 'sidebar-state') {
        const next = message.state;
        const serialized = JSON.stringify(next.config);
        if (baseConfig.current !== serialized || configRevision.current !== next.configRevision) {
          baseConfig.current = serialized; configRevision.current = next.configRevision;
          setDraft(next.config); setArgsText(JSON.stringify(next.config.scriptArgs));
        }
        if (recordId.current !== next.record?.id) { setSearch(''); setKernel('all'); setHideUnchanged(false); recordId.current = next.record?.id; }
        if (next.selectedStageId && next.selectedStageId !== selectedId.current) {
          const target = next.record?.stages.find(stage => stage.id === next.selectedStageId);
          const filter = filters.current;
          if (target && ((filter.kernel !== 'all' && target.kernelId !== filter.kernel) || (filter.hideUnchanged && target.changed === false) || (filter.search.trim() && !`${target.name} ${target.phase ?? ''} ${target.kernelName} ${kindNames[target.kind]}`.toLowerCase().includes(filter.search.trim().toLowerCase())))) {
            setSearch(''); setKernel('all'); setHideUnchanged(false);
          }
          window.setTimeout(() => document.querySelector(`[data-stage-id="${CSS.escape(next.selectedStageId!)}"]`)?.scrollIntoView({ block: 'nearest' }), 0);
        }
        selectedId.current = next.selectedStageId;
        setState(next); setReady(true);
      } else if (message.type === 'sidebar-error') { setNotice(null); setError(message.message); }
      else if (message.type === 'sidebar-notice') { setError(null); setNotice(message.message); }
    };
    window.addEventListener('message', receive);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', receive);
  }, []);
  useEffect(() => {
    vscode.setState({ theme, draft, argsText, baseConfig: baseConfig.current, configRevision: configRevision.current, search, kernel, hideUnchanged, advanced, configOpen, recordId: recordId.current, selectedStageId: selectedId.current });
  }, [theme, draft, argsText, search, kernel, hideUnchanged, advanced, configOpen, state.configRevision, state.record?.id, state.selectedStageId]);

  const record = state.record;
  const stages = useMemo(() => [...(record?.stages ?? [])].sort((a, b) => a.sequence - b.sequence), [record?.stages]);
  const kernels = useMemo(() => [...new Map(stages.map(stage => [stage.kernelId, { id: stage.kernelId, name: stage.kernelName, index: stage.kernelIndex, cache: stage.cache }])).values()].sort((a, b) => a.index - b.index), [stages]);
  const filtered = useMemo(() => stages.filter(stage => (kernel === 'all' || stage.kernelId === kernel) && (!hideUnchanged || stage.changed !== false) && (!search.trim() || `${stage.name} ${stage.phase ?? ''} ${stage.kernelName} ${kindNames[stage.kind]}`.toLowerCase().includes(search.trim().toLowerCase()))), [stages, kernel, hideUnchanged, search]);
  const parsed = parseArgs(argsText);
  const locked = !ready || state.busy;
  const dirty = JSON.stringify({ ...draft, scriptArgs: parsed.args }) !== baseConfig.current || !!parsed.error;
  const status = state.busy ? 'running' : record?.status;
  const noJit = record?.status === 'succeeded' && record.compilationMode === 'jit' && record.kernelCount === 0;
  const dispatch = (action: SidebarAction) => {
    setError(null); setNotice(null);
    if (action === 'reveal-error') { setSearch(''); setKernel('all'); setHideUnchanged(false); }
    const preferences = action === 'example' || action === 'use-current' || action === 'browse'
      ? { pythonPath: draft.pythonPath, disableCache: draft.disableCache } : undefined;
    vscode.postMessage({ type: 'action', action, ...(preferences ? { preferences } : {}) });
  };
  const update = <K extends keyof CompileConfig>(field: K, value: CompileConfig[K]) => setDraft(current => ({ ...current, [field]: value }));
  const selectStage = (stageId: string) => {
    if (!record) return;
    setError(null); setNotice(null);
    selectedId.current = stageId;
    setState(current => ({ ...current, selectedStageId: stageId }));
    vscode.postMessage({ type: 'select-stage', recordId: record.id, stageId });
  };
  const compile = () => {
    setNotice(null);
    if (parsed.error) { setAdvanced(true); setError(parsed.error); return; }
    setError(null); vscode.postMessage({ type: 'compile', config: { ...draft, scriptArgs: parsed.args } });
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && !!event.target.closest('input,textarea,select,[contenteditable="true"]');
      if (event.key === '/' && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); searchRef.current?.focus(); }
      if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && filtered.length) {
        event.preventDefault();
        const current = filtered.findIndex(stage => stage.id === state.selectedStageId);
        const index = current < 0 ? 0 : Math.max(0, Math.min(filtered.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
        selectStage(filtered[index].id);
        document.querySelector(`[data-stage-id="${CSS.escape(filtered[index].id)}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [filtered, state.selectedStageId, record?.id]);

  return <div className="sidebar-app" data-theme={theme}>
    <header className="sidebar-brand"><span className="brand-icon"><DevKitMark /></span><div><h1>TileLang <span>DevKit</span></h1><p>Lower Trace · 编译追踪</p></div><button className="icon-button theme-button" data-testid="sidebar-theme" aria-label={`切换主题，当前${theme === 'auto' ? '跟随 VS Code' : theme === 'dark' ? '深色' : '浅色'}`} title="切换明暗主题" onClick={() => setTheme(theme === 'auto' ? 'dark' : theme === 'dark' ? 'light' : 'auto')}>{theme === 'auto' ? <Circle /> : theme === 'dark' ? <Moon /> : <Sun />}</button></header>
    <section className={`configuration ${advanced && configOpen ? 'advanced' : ''}`} aria-label="编译配置">
      <button className="config-heading" data-testid="sidebar-config-section" aria-expanded={configOpen} onClick={() => setConfigOpen(!configOpen)}><span><Settings2 /> 编译配置{dirty && ready && <i title="本地配置草稿" />}</span><ChevronDown className={configOpen ? '' : 'collapsed'} /></button>
      {configOpen && <><div className="config-body">
        <label className="field-label" htmlFor="entry-path">入口脚本</label>
        <div className="entry-input"><input id="entry-path" data-testid="sidebar-entry-path" aria-label="入口脚本" placeholder="选择已保存的 Python 文件" value={draft.entryPath} onChange={event => update('entryPath', event.target.value)} disabled={locked} title={draft.entryPath} /><button className="icon-button" data-testid="sidebar-browse" aria-label="浏览入口脚本" title="浏览入口脚本" disabled={locked} onClick={() => dispatch('browse')}><FolderOpen /></button></div>
        <div className="entry-shortcuts"><button data-testid="sidebar-use-current" disabled={locked || !state.currentFile} title={state.currentFile?.path ?? '先打开已保存的 .py 文件'} onClick={() => dispatch('use-current')}><FileCode2 /> 使用当前文件</button><button data-testid="sidebar-edit-source" disabled={!ready || !draft.entryPath.trim()} title="在原生编辑器中编辑入口源码" onClick={() => { setError(null); setNotice(null); vscode.postMessage({ type: 'edit-source', entryPath: draft.entryPath }); }}><ArrowUpRight /> 编辑源码</button></div>
        {!state.currentFile && <p className="current-file-hint">使用当前文件前，先打开已保存的 .py 文件。</p>}
        <div className="target-line"><Cpu /><span>CPU C <i>·</i> cython <i>·</i> 完整 JIT</span></div>
        <button className="advanced-toggle" data-testid="sidebar-config-toggle" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}><ChevronDown className={advanced ? '' : 'collapsed'} /> Python 与运行参数 <span>{advanced ? '收起' : '展开'}</span></button>
        {advanced && <div className="advanced-config">
          <label><span className="field-label">Python 解释器</span><input data-testid="sidebar-python-path" aria-label="Python 解释器" placeholder="python" value={draft.pythonPath} disabled={locked} onChange={event => update('pythonPath', event.target.value)} /></label>
          <label><span className="field-label">脚本参数 · JSON 字符串数组</span><textarea data-testid="sidebar-script-args" aria-label="脚本参数 JSON" rows={2} spellCheck={false} value={argsText} disabled={locked} aria-invalid={!!parsed.error} onChange={event => setArgsText(event.target.value)} /></label>
          {parsed.error && <p className="field-error" role="alert">{parsed.error}</p>}
          <label><span className="field-label">工作目录</span><input data-testid="sidebar-working-directory" aria-label="工作目录" placeholder="留空使用工作区目录" value={draft.workingDirectory} disabled={locked} onChange={event => update('workingDirectory', event.target.value)} /></label>
          <label className="cache-setting" title="关闭 TileLang 全局与磁盘缓存，不删除已有缓存文件；装饰器对象的本地缓存仍可能复用。"><input type="checkbox" data-testid="sidebar-disable-cache" checked={draft.disableCache} disabled={locked} onChange={event => update('disableCache', event.target.checked)} /><span>禁用全局 / 磁盘缓存<small>装饰器本地缓存仍可能复用</small></span></label>
        </div>}
      </div><div className="config-footer"><div className="compile-actions">{state.busy ? <button className="run-button cancel" data-testid="sidebar-cancel" onClick={() => dispatch('cancel')}><Square /> 取消运行</button> : <button className="run-button" data-testid="sidebar-compile" disabled={!ready || !state.trusted || !draft.entryPath.trim() || !draft.pythonPath.trim() || !!parsed.error} title={!state.trusted ? '信任工作区后可执行 Python 脚本' : '保存入口文件并以 __main__ 运行脚本，执行完整 JIT'} onClick={compile}><Play /> 保存并运行</button>}<button className="example-button" data-testid="sidebar-example" onClick={() => dispatch('example')} disabled={locked} title="加载 CPU 示例配置并打开源码，不执行脚本">CPU 示例</button></div>
        <p className="execution-note">以 __main__ 运行，会执行脚本逻辑。</p>
      </div></>}
      {!configOpen && <div className="collapsed-config"><span title={draft.entryPath}>{draft.entryPath.replace(/\\/g, '/').split('/').pop() || '尚未选择脚本'}</span>{state.busy ? <button data-testid="sidebar-cancel" className="icon-button" aria-label="取消运行" onClick={() => dispatch('cancel')}><Square /></button> : <button className="icon-button" aria-label="展开编译配置" onClick={() => setConfigOpen(true)}><Settings2 /></button>}</div>}
    </section>
    {error && <div className="sidebar-notice error" role="alert" data-testid="sidebar-error"><CircleAlert /><span>{error}</span><button className="icon-button" aria-label="关闭侧栏错误" onClick={() => setError(null)}><X /></button></div>}
    {notice && <div className="sidebar-notice success" role="status" data-testid="sidebar-notice"><Check /><span>{notice}</span><button className="icon-button" data-testid="sidebar-dismiss-notice" aria-label="关闭侧栏提示" onClick={() => setNotice(null)}><X /></button></div>}
    {!state.trusted && <div className="sidebar-notice restricted" data-testid="sidebar-restricted"><CircleAlert /><span>受限模式：可配置入口与查看离线记录，运行需要信任工作区。</span></div>}
    <section className="record-summary" aria-label="当前记录">
      {record ? <div data-testid="sidebar-record">
        <div className="record-file"><FileCode2 /><span title={record.entryPath}>{record.fileName || '未命名记录'}</span><span className={`provenance ${record.provenance}`}>{record.provenance === 'mock' ? 'MOCK' : 'REAL'}</span><button className="icon-button" data-testid="sidebar-view-record" title="打开当前记录" aria-label="打开当前记录" onClick={() => dispatch('open')}><ArrowUpRight /></button></div>
        <div className="record-line"><span className={`record-status ${status}`} role="status"><RunIcon status={status!} />{statusLabels[status!]}</span><span>{record.stageCount} 阶段 <i>·</i> {record.kernelCount} {record.compilationMode === 'jit' ? 'JIT 请求' : 'kernel'}</span><span className="record-duration" title="记录总耗时"><Clock3 />{duration(record.durationMs)}</span></div>
        {record.provenance === 'mock' && <p className="mock-note">演示数据，非真实编译结果</p>}
        {record.error && <div className="record-error" data-testid="sidebar-record-error"><p title={record.error.message}><CircleAlert /><span>{record.error.phase}: {record.error.message}</span></p><button data-testid="sidebar-reveal-error" onClick={() => dispatch('reveal-error')}>查看错误与日志 <ArrowUpRight /></button></div>}
      </div> : <div className="record-empty" data-testid="sidebar-empty">{ready ? <Layers3 /> : <LoaderCircle className="spin" />}<span>{ready ? state.busy ? '等待采集记录…' : '准备运行，或导入离线记录' : '正在连接扩展…'}</span></div>}
    </section>
    <section className="stage-section" aria-label="编译阶段导航">
      <div className="section-heading"><h2>编译阶段 <span>{filtered.length}{filtered.length !== stages.length ? ` / ${stages.length}` : ''}</span></h2><button className={`icon-button ${hideUnchanged ? 'active' : ''}`} data-testid="sidebar-hide-unchanged" aria-label="隐藏无变化阶段" aria-pressed={hideUnchanged} title="隐藏输入与输出相同的阶段" onClick={() => setHideUnchanged(!hideUnchanged)}><ListFilter /></button></div>
      <div className="stage-filters"><div className="search-field"><Search /><input ref={searchRef} data-testid="sidebar-stage-search" aria-label="搜索编译阶段" placeholder="搜索阶段、kernel…" value={search} onChange={event => setSearch(event.target.value)} /><kbd>/</kbd></div><select data-testid="sidebar-kernel-select" aria-label="筛选 kernel" value={kernel} onChange={event => setKernel(event.target.value)}><option value="all">全部 {record?.compilationMode === 'jit' ? 'JIT 请求' : 'kernel'}</option>{kernels.map(item => <option key={item.id} value={item.id}>#{item.index} · {item.name}{item.cache === 'hit' ? ' · 缓存命中' : ''}</option>)}</select></div>
      <div className="stage-list" role="list" aria-label="按实际执行顺序排列的编译阶段">
        {filtered.map(stage => <button key={stage.id} className={`stage-item ${state.selectedStageId === stage.id ? 'selected' : ''} ${stage.status}`} data-testid="sidebar-stage-item" data-stage-id={stage.id} aria-current={state.selectedStageId === stage.id ? 'step' : undefined} title={`${stage.name}\n${stage.kernelName} · 请求 #${stage.kernelIndex}\n${stage.phase ?? kindNames[stage.kind]} · 嵌套深度 ${stage.depth}\n${statusLabels[stage.status]} · ${duration(stage.durationMs)}${stage.changed === false ? '\n本阶段输入与输出相同' : ''}`} onClick={() => selectStage(stage.id)}>
          <span className={`stage-rail ${stage.kind}`}><span className="stage-sequence">{stage.sequence.toString().padStart(2, '0')}</span><RunIcon status={stage.status} cache={stage.kind === 'cache'} /></span>
          <span className="stage-content"><span className="stage-name"><span>{stage.name}</span>{stage.repetitions > 1 && <small>#{stage.occurrence}</small>}</span><span className="stage-subline"><span>#{stage.kernelIndex} · {stage.kernelName}</span><time>{duration(stage.durationMs)}</time></span><span className="stage-tags"><span>{kindNames[stage.kind]}</span>{stage.depth > 0 && <span className="nesting" title="实际 Pass 嵌套深度">↳ {stage.depth}</span>}{stage.changed === false && <span>无变化</span>}{stage.cache === 'hit' && <span className="cache-hit">缓存命中</span>}{stage.status === 'failed' && <span className="failure-text">失败</span>}{stage.status === 'running' && <span className="running-text">运行中</span>}{stage.changed === true && (stage.added !== null || stage.deleted !== null) && <span className="change-count"><b>+{stage.added ?? '—'}</b><em>−{stage.deleted ?? '—'}</em></span>}</span></span>
        </button>)}
        {!filtered.length && <div className="stages-empty">{search || kernel !== 'all' || hideUnchanged ? <><Search /><strong>没有匹配的阶段</strong><button onClick={() => { setSearch(''); setKernel('all'); setHideUnchanged(false); }}>清除筛选</button></> : <><Layers3 /><strong>{noJit ? '未观察到 JIT 调用' : state.busy ? '等待第一个编译阶段' : record?.status === 'failed' ? '运行尚未产生编译阶段' : '阶段将在这里出现'}</strong><p>{noJit ? '脚本已完成；没有 JIT 调用\n不表示缓存命中。' : '按真实执行顺序采集，\n点击阶段，在编辑区查看代码与 Diff。'}</p></>}</div>}
      </div>
      <div className="stage-keyboard"><kbd>Alt</kbd><kbd>↑</kbd><kbd>↓</kbd><span>切换阶段</span><span className="live-hint">{state.busy ? <><span /> 实时采集</> : '只读快照'}</span></div>
    </section>
    <footer className="offline-actions" aria-label="记录操作"><button data-testid="sidebar-demo" title="明确标注的 Mock 交互演示，不运行 Python" disabled={locked} onClick={() => dispatch('demo')}><Play /><span>Mock</span></button><button data-testid="sidebar-import" title="导入离线编译记录" disabled={locked} onClick={() => dispatch('import')}><Upload /><span>导入</span></button><button data-testid="sidebar-export" title="导出当前记录，长期留存" disabled={!ready || !record} onClick={() => dispatch('export')}><Download /><span>导出</span></button><button className="icon-button" data-testid="sidebar-open" aria-label="打开编译查看器" title="在编辑区打开编译查看器" disabled={!ready} onClick={() => dispatch('open')}><ArrowUpRight /></button></footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
