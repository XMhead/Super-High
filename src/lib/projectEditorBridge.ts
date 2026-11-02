export function buildProjectEditorBridgeScript() {
  return `(()=>{
const pending=new Map()
// Correlation IDs only need to be unique within this preview document.
const requestPrefix='editor-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)+'-'
let requestSequence=0
const hostKeys={F1:'superhigh-editor:toggle-explorer',F4:'superhigh-editor:toggle-editor-picker'}
window.addEventListener('keydown',(event)=>{const type=hostKeys[event.key];if(!type||event.ctrlKey||event.altKey||event.shiftKey||event.metaKey)return;event.preventDefault();if(!event.repeat)window.parent.postMessage({type},'*')},true)
const context={pageId:null,codePreviewRoot:null}
const contextListeners=new Set(),previewListeners=new Set(),workspaceChangeListeners=new Set()
const subscribe=(listeners,listener)=>{listeners.add(listener);return()=>listeners.delete(listener)}
function request(type,payload={}){const requestId=requestPrefix+(++requestSequence);return new Promise((resolve,reject)=>{pending.set(requestId,{resolve,reject});window.parent.postMessage({type,requestId,...payload},'*')})}
window.addEventListener('message',({data})=>{const entry=pending.get(data?.requestId);if(entry){pending.delete(data.requestId);if(String(data.type||'').endsWith('-error'))entry.reject(new Error(data.error||'SuperHigh 请求失败。'));else entry.resolve(data.result)}if(data?.type==='superhigh-editor:context'){context.pageId=data.pageId??null;context.codePreviewRoot=data.codePreviewRoot??null;contextListeners.forEach(listener=>listener({...context}))}if(data?.type==='superhigh-editor:code-preview-content')previewListeners.forEach(listener=>listener(data.path,data.content,{isDirty:data.isDirty===true}));if(data?.type==='superhigh-editor:workspace-files-changed')workspaceChangeListeners.forEach(listener=>listener(data.paths??[],data.kind))})
window.superhigh=window.superhigh||{}
window.superhighEditor={
  request,
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
