export function buildProjectEditorBridgeScript(uiRuntimeUrl = '') {
  return `(()=>{
const pending=new Map()
// Correlation IDs only need to be unique within this preview document.
const requestPrefix='editor-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)+'-'
let requestSequence=0
const hostKeys={F1:'superhigh-editor:toggle-explorer',F4:'superhigh-editor:toggle-editor-picker'}
window.addEventListener('keydown',(event)=>{const type=hostKeys[event.key];if(!type||event.ctrlKey||event.altKey||event.shiftKey||event.metaKey)return;event.preventDefault();if(!event.repeat)window.parent.postMessage({type},'*')},true)
const context={pageId:null,codePreviewRoot:null}
let editorParameters={}
const parameterListeners=new Set()
window.addEventListener('message',({data})=>{if(data?.type==='superhigh-editor:parameters'){editorParameters=data.parameters||{};parameterListeners.forEach(listener=>listener({...editorParameters}))}})
const renderVersions=new WeakMap()
let currentTheme=null
const iuiInstances=new Set()
window.addEventListener('message',({data})=>{if(data?.type==='superhigh-editor:theme'){currentTheme=data;document.documentElement.toggleAttribute('data-md-heading-colors',false);if(data.markdownHeadingColors)document.documentElement.setAttribute('data-md-heading-colors','rgba');iuiInstances.forEach(instance=>instance.theme(data))}})
function renderIui(target,source,options={}){
if(!(target instanceof HTMLElement))throw new Error('renderIui 的第一个参数必须是容器元素。')
target.__superhighIui?.destroy()
renderVersions.set(target,(renderVersions.get(target)||0)+1)
const frame=document.createElement('iframe');frame.title='SuperHigh IUI';frame.style.cssText='display:block;width:100%;height:1px;border:0;';frame.src=${JSON.stringify(uiRuntimeUrl)}
let values=options.values||{},payload={source,values,data:options.data||{}},active=true
const send=(data)=>frame.contentWindow?.postMessage({type:'superhigh-iui:update',...data},'*')
const instance={update:(next,nextOptions={})=>{payload={source:next,values:nextOptions.values||values,data:nextOptions.data||payload.data};send({...payload,theme:currentTheme})},getValues:()=>({...values}),theme:theme=>send({theme}),destroy:()=>{active=false;window.removeEventListener('message',receive);observer.disconnect();iuiInstances.delete(instance);frame.remove();if(target.__superhighIui===instance)delete target.__superhighIui}}
function receive(event){if(!active||event.source!==frame.contentWindow)return;const data=event.data;if(data?.type==='superhigh-iui:ready')send({...payload,theme:currentTheme});if(data?.type==='superhigh-iui:resize')frame.style.height=Math.max(1,Number(data.height)||1)+'px';if(data?.values)values=data.values;if(data?.type==='superhigh-iui:change')options.onChange?.(data);if(data?.type==='superhigh-iui:action')options.onAction?.(data.action);if(data?.type==='superhigh-iui:rendered')options.onRender?.(data);if(data?.type==='superhigh-iui:error')options.onError?.(data.message);if(data?.type==='superhigh-iui:open-resource')options.onOpenResource?.(data.src)}
const observer=new MutationObserver(()=>{if(!target.isConnected||!frame.isConnected)instance.destroy()});observer.observe(document,{childList:true,subtree:true});window.addEventListener('message',receive);iuiInstances.add(instance);target.__superhighIui=instance;target.replaceChildren(frame);return instance
}
async function renderContent(target,content,options={}){if(!(target instanceof HTMLElement))throw new Error('renderContent 的第一个参数必须是容器元素。');target.__superhighIui?.destroy();const version=(renderVersions.get(target)||0)+1;renderVersions.set(target,version);const html=await request('superhigh-editor:render-content',{content:String(content??''),format:options.format||'markdown'});if(renderVersions.get(target)!==version)return;target.classList.add('markdown-body');target.style.whiteSpace='normal';target.innerHTML=html}
const contextListeners=new Set(),previewListeners=new Set(),workspaceChangeListeners=new Set()
const subscribe=(listeners,listener)=>{listeners.add(listener);return()=>listeners.delete(listener)}
function request(type,payload={}){const requestId=requestPrefix+(++requestSequence);return new Promise((resolve,reject)=>{pending.set(requestId,{resolve,reject});window.parent.postMessage({type,requestId,...payload},'*')})}
window.addEventListener('message',({data})=>{const entry=pending.get(data?.requestId);if(entry){pending.delete(data.requestId);if(String(data.type||'').endsWith('-error'))entry.reject(new Error(data.error||'SuperHigh 请求失败。'));else entry.resolve(data.result)}if(data?.type==='superhigh-editor:context'){context.pageId=data.pageId??null;context.codePreviewRoot=data.codePreviewRoot??null;contextListeners.forEach(listener=>listener({...context}))}if(data?.type==='superhigh-editor:code-preview-content')previewListeners.forEach(listener=>listener(data.path,data.content,{isDirty:data.isDirty===true}));if(data?.type==='superhigh-editor:workspace-files-changed')workspaceChangeListeners.forEach(listener=>listener(data.paths??[],data.kind))})
window.superhigh=window.superhigh||{}
window.superhighEditor={
  request,
  renderContent,
  renderIui,
  parameters:()=>({...editorParameters}),
  onParameters:listener=>subscribe(parameterListeners,listener),
  renderOutput:(target,output)=>renderContent(target,typeof output==='string'?output:[output?.stdout,output?.stderr].filter(Boolean).join('\\n\\n')),
  fs:(operation,path,payload={})=>request('superhigh-editor:fs',{operation,path,...payload}),
  runScriptTool:(toolId,values={})=>request('superhigh-editor:script-tool',{toolId,values}),
  listScriptTools:()=>request('superhigh-editor:script-tools'),
  skillOverview:()=>request('superhigh-editor:skill-overview'),
  runScriptToolJson:async(toolId,values={})=>{const result=await request('superhigh-editor:script-tool',{toolId,values});if(result.exitCode!==0)throw new Error(result.stderr||('脚本工具执行失败：'+toolId));try{return JSON.parse(result.stdout)}catch{throw new Error('脚本工具未返回有效 JSON：'+toolId)}},
  toast:(message,level)=>request('superhigh-editor:ui',{operation:'toast',message,...(level==='error'?{level}:{})}),
  confirm:(message)=>request('superhigh-editor:ui',{operation:'confirm',message}),
  copy:(text)=>request('superhigh-editor:ui',{operation:'copy',text}),
  openCodePreview:(path,position={})=>request('superhigh-editor:code-preview',{path,...position}),
  bindCodePreview:(path,position={})=>request('superhigh-editor:code-preview-bind',{path,...position}),
  setCodePreviewContent:(path,content,options={})=>request('superhigh-editor:code-preview-set-content',{path,content,...options}),
  context:()=>({...context}),
  onContext:(listener)=>subscribe(contextListeners,listener),
  onCodePreviewContent:(listener)=>subscribe(previewListeners,listener),
  onWorkspaceFilesChanged:(listener)=>subscribe(workspaceChangeListeners,listener),
}
window.parent.postMessage({type:'superhigh-editor:preview-ready'},'*')
})()`
}
