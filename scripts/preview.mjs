// Browser-only development harness. This file is excluded from the VSIX.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.TRACE_PREVIEW_PORT || 4173);
const themes = {
  dark: { foreground: '#e6eaf1', background: '#10141b', panel: '#171d27', border: '#303948', muted: '#8e9caf', input: '#111722', accent: '#75a7ff' },
  light: { foreground: '#202938', background: '#f7f9fc', panel: '#ffffff', border: '#dce2eb', muted: '#64748b', input: '#ffffff', accent: '#2764c4' },
};

function html() {
  const nonce = randomBytes(24).toString('base64');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; font-src 'self'; img-src 'self' data:; connect-src 'self'"><title>TileLang DevKit · Lower Trace · Browser preview</title><link rel="stylesheet" href="/dist/webview.css"></head><body class="vscode-dark" data-nonce="${nonce}"><div id="root"></div><script nonce="${nonce}">
  const themes = ${JSON.stringify(themes)};
  const preview = window.__tracePreview = {
    record: null, exported: null, copied: '', messages: [], ready: false, trusted: true, selectedStageId:null,
    config: {entryPath:'/workspace/cpu_vecadd.py', scriptArgs:[], pythonPath:'python', workingDirectory:'', disableCache:false},
    setRecord(record) { this.record = structuredClone(record); if(!record.kernels.some(kernel=>kernel.stages.some(stage=>stage.id===this.selectedStageId))) this.selectedStageId=null; this.send({type:'record', record:this.record, busy:record.status === 'running',selectedStageId:this.selectedStageId}); },
    send(message) {
      if(message.type==='reveal-stage' && message.recordId===this.record?.id)this.selectedStageId=message.stageId;
      if(message.type==='reveal-error')this.selectedStageId=message.stageId || this.record?.error?.stageId || this.selectedStageId;
      window.dispatchEvent(new MessageEvent('message', {data:message}));
    },
    setTheme(name) {
      const p = themes[name] || themes.dark;
      document.body.className = 'vscode-' + name;
      document.body.dataset.vscodeThemeKind = 'vscode-' + name;
      const vars = {foreground:p.foreground, 'editor-background':p.background, 'editor-foreground':p.foreground,
        'sideBar-background':p.panel, 'panel-background':p.panel, 'panel-border':p.border, 'descriptionForeground':p.muted,
        'input-background':p.input, 'input-foreground':p.foreground, 'input-border':p.border,
        'dropdown-background':p.input, 'dropdown-foreground':p.foreground, 'dropdown-border':p.border,
        'button-background':p.accent, 'button-foreground':name === 'light'?'#fff':'#07142b',
        'focusBorder':p.accent, 'textLink-foreground':p.accent, 'list-hoverBackground':name === 'light'?'#eef2f8':'#202a38',
        'list-activeSelectionBackground':name === 'light'?'#e0ebff':'#253b5e', 'list-activeSelectionForeground':p.foreground,
        'editorLineNumber-foreground':p.muted, 'editorWidget-background':p.panel, 'widget-border':p.border,
        'font-family':'system-ui, sans-serif', 'editor-font-family':'Consolas, monospace', 'font-size':'13px'};
      for (const [key,value] of Object.entries(vars)) document.body.style.setProperty('--vscode-'+key, value);
    }
  };
  preview.setTheme(new URLSearchParams(location.search).get('theme') || 'dark');
  let savedState;
  window.acquireVsCodeApi = () => ({
    getState: () => savedState,
    setState: value => savedState = value,
    postMessage: async message => {
      preview.messages.push(message);
      if (message.type === 'ready' || message.type === 'demo') {
        const record = message.type==='demo' || !preview.record ? await fetch('/examples/mock.tltrace.json').then(r=>r.json()) : preview.record;
        preview.record = record;
        preview.send({type:'state',record,config:preview.config,busy:false,trusted:preview.trusted,selectedStageId:preview.selectedStageId});
        preview.ready = true;
      } else if (message.type === 'stage-selected') {
        preview.selectedStageId=message.stageId;
      } else if (message.type === 'copy') {
        preview.copied = message.text;
        preview.send({type:'notice',message:'Code copied'});
      } else if (message.type === 'export' && preview.record) {
        preview.exported = structuredClone(preview.record);
        const url = URL.createObjectURL(new Blob([JSON.stringify(preview.record,null,2)],{type:'application/json'}));
        const link = document.createElement('a'); link.href=url; link.download='preview.tltrace.json'; link.click();
        setTimeout(()=>URL.revokeObjectURL(url),1000);
      } else if (message.type === 'import') {
        const input = document.createElement('input'); input.type='file'; input.accept='.json';
        input.onchange=async()=>{try { preview.setRecord(JSON.parse(await input.files[0].text())); } catch(error) { preview.send({type:'error',message:error.message}); }};
        input.click();
      } else if (message.type === 'compile' || message.type === 'cancel') {
        preview.send({type:'notice',message:'浏览器预览仅展示明确标注的 mock 记录；请在 VS Code 扩展中运行脚本并采集真实 JIT。'});
      } else if (message.type === 'example' || message.type === 'browse') {
        preview.send({type:'configuration',config:preview.config,trusted:preview.trusted});
      }
    }
  });
</script><script nonce="${nonce}" src="/dist/webview.js"></script></body></html>`;
}

function sidebarHtml() {
  const nonce = randomBytes(24).toString('base64');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; font-src 'self'; img-src 'self' data:; connect-src 'self'"><title>TileLang DevKit · Lower Trace Sidebar · Browser preview</title><link rel="stylesheet" href="/dist/sidebar.css"></head><body class="vscode-dark" data-nonce="${nonce}"><div id="root"></div><script nonce="${nonce}">
  const themes = ${JSON.stringify(themes)};
  const preview = window.__sidebarPreview = {
    ready: false, messages: [], record: null, exported:null, openedSources:[],
    // One-shot browser-test controls. Undefined chooses the default browse path;
    // null simulates cancelling the dialog. No filesystem is accessed.
    nextBrowsePath:undefined, nextSourceOpenError:null,
    state: {busy:false, trusted:true, currentFile:{path:'/workspace/cpu_vecadd.py',name:'cpu_vecadd.py'}, record:null,config:{entryPath:'/workspace/cpu_vecadd.py',scriptArgs:[],pythonPath:'python',workingDirectory:'',disableCache:false},configRevision:0,selectedStageId:null},
    send(message) { window.dispatchEvent(new MessageEvent('message', {data:message})); },
    setState(state) { this.state = structuredClone(state); this.send({type:'sidebar-state',state:this.state}); },
    setRecord(record) {
      this.record = structuredClone(record);
      let summary = null;
      if (record) {
        const fullStages = record.kernels.flatMap(kernel=>kernel.stages);
        const stages = record.kernels.flatMap((kernel,kernelIndex)=>{
          const sorted=[...kernel.stages].sort((a,b)=>a.sequence-b.sequence);
          const totals=new Map(),counts=new Map();
          for(const stage of sorted)totals.set(stage.name,(totals.get(stage.name)||0)+1);
          return sorted.map(stage=>{
            const occurrence=(counts.get(stage.name)||0)+1;counts.set(stage.name,occurrence);
            const {id,sequence,name,kind,phase,depth,status,durationMs,changed,added,deleted}=stage;
            return {id,sequence,name,kind,phase,depth,status,durationMs,changed,added,deleted,kernelId:kernel.id,kernelName:kernel.name,kernelIndex:kernelIndex+1,cache:kernel.cache,occurrence,repetitions:totals.get(stage.name)};
          });
        }).sort((a,b)=>a.sequence-b.sequence);
        const failed = fullStages.filter(stage=>stage.error).sort((a,b)=>b.sequence-a.sequence)[0];
        const error = record.error || (failed ? {...failed.error,stageId:failed.error.stageId || failed.id} : undefined);
        summary = {id:record.id,entryPath:record.entry.path,fileName:record.entry.path.split('/').pop(),provenance:record.provenance,status:record.status,compilationMode:record.environment.compilationMode,stageCount:stages.length,kernelCount:record.kernels.length,durationMs:record.durationMs,stages,...(error ? {error:{phase:error.phase,message:error.message,stageId:error.stageId}} : {})};
      }
      this.setState({...this.state,busy:record?.status === 'running',record:summary,selectedStageId:summary?.stages.some(stage=>stage.id===this.state.selectedStageId)?this.state.selectedStageId:null});
    },
    setTheme(name) {
      const p = themes[name] || themes.dark;
      document.body.className = 'vscode-' + name;
      const vars = {foreground:p.foreground,'sideBar-background':p.panel,'editor-background':p.background,'widget-border':p.border,'descriptionForeground':p.muted,'font-family':'system-ui, sans-serif','editor-font-family':'Consolas, monospace'};
      for (const [key,value] of Object.entries(vars)) document.body.style.setProperty('--vscode-'+key,value);
    }
  };
  preview.setTheme(new URLSearchParams(location.search).get('theme') || 'dark');
  let savedState;
  window.acquireVsCodeApi = () => ({
    getState:()=>savedState, setState:value=>savedState=value,
    postMessage:async message=>{
      preview.messages.push(message);
      if(message.type === 'ready') {
        const record = await fetch('/examples/mock.tltrace.json').then(response=>response.json());
        preview.setRecord(record); preview.ready=true;
      } else if(message.type === 'select-stage' && message.recordId === preview.record?.id) {
        preview.setState({...preview.state,selectedStageId:message.stageId});
      } else if(message.type === 'compile') {
        preview.send({type:'sidebar-error',message:'浏览器预览不会执行 Python。请在 VS Code 中运行脚本；这里仅展示明确标注的 Mock 数据。'});
      } else if(message.type === 'action' && message.action === 'demo') {
        preview.setRecord(await fetch('/examples/mock.tltrace.json').then(response=>response.json()));
      } else if(message.type === 'action' && message.action === 'export' && preview.record) {
        preview.exported=structuredClone(preview.record);
        const url=URL.createObjectURL(new Blob([JSON.stringify(preview.record,null,2)],{type:'application/json'}));
        const link=document.createElement('a');link.href=url;link.download='preview.tltrace.json';link.click();
        setTimeout(()=>URL.revokeObjectURL(url),1000);
      } else if(message.type === 'action' && message.action === 'import') {
        const input=document.createElement('input');input.type='file';input.accept='.json';
        input.onchange=async()=>{try{preview.setRecord(JSON.parse(await input.files[0].text()));}catch(error){preview.send({type:'sidebar-error',message:error.message});}};
        input.click();
      } else if(message.type === 'action' && ['example','use-current','browse'].includes(message.action)) {
        const preferences=message.preferences===undefined?{pythonPath:preview.state.config.pythonPath,disableCache:preview.state.config.disableCache}:message.preferences;
        const invalid=!preferences || typeof preferences!=='object' || Array.isArray(preferences) ? '入口选择设置必须是对象'
          : typeof preferences.pythonPath!=='string' || preferences.pythonPath.includes(String.fromCharCode(0)) ? 'Python 解释器路径无效'
          : typeof preferences.disableCache!=='boolean' ? '缓存选项必须是布尔值' : null;
        if(invalid){preview.send({type:'sidebar-error',message:invalid});return;}
        let path;
        if(message.action==='browse') {
          path=preview.nextBrowsePath===undefined?'/workspace/selected.py':preview.nextBrowsePath;
          preview.nextBrowsePath=undefined;
          if(path===null)return;
        } else path=message.action==='use-current'?preview.state.currentFile?.path:'/extension/examples/cpu_vecadd.py';
        if(!path)return;
        if(message.action==='example' && preview.nextSourceOpenError) {
          const message=preview.nextSourceOpenError;preview.nextSourceOpenError=null;
          preview.send({type:'sidebar-error',message});return;
        }
        const example=message.action==='example';
        if(example)preview.openedSources.push(path);
        preview.setState({...preview.state,
          ...(example?{currentFile:{path,name:'cpu_vecadd.py'}}:{}),
          config:{...preview.state.config,pythonPath:preferences.pythonPath,disableCache:example?true:preferences.disableCache,entryPath:path,scriptArgs:example?['--repeat','1','--verify']:[],workingDirectory:''},
          configRevision:preview.state.configRevision+1});
        if(example)preview.send({type:'sidebar-notice',message:'已载入 CPU 示例，可编辑源码后点击“保存并运行”。'});
      }
      // Other actions are recorded for tests; this preview never starts Python.
    }
  });
</script><script nonce="${nonce}" src="/dist/sidebar.js"></script></body></html>`;
}

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/favicon.ico') {
      response.writeHead(204); response.end(); return;
    }
    if (pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(html());
      return;
    }
    if (pathname === '/sidebar' || pathname === '/sidebar/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(sidebarHtml());
      return;
    }
    const filename = resolve(root, '.' + pathname);
    if (!filename.startsWith(root + sep) || !/^\/(dist|examples)\//.test(pathname)) {
      response.writeHead(403); response.end('Forbidden'); return;
    }
    const body = await readFile(filename);
    const type = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(filename)] || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    response.end(body);
  } catch {
    response.writeHead(404); response.end('Not found. Run npm run build before previewing.');
  }
}).listen(port, '127.0.0.1', () => console.log(`TileLang DevKit mock preview: http://127.0.0.1:${port}`));
