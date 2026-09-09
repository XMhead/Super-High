export function buildProjectEditorBridgeScript() {
  return `(()=>{
const pending=new Map()
const context={pageId:null,codePreviewRoot:null}
const contextListeners=new Set(),previewListeners=new Set(),workspaceChangeListeners=new Set()
const subscribe=(listeners,listener)=>{listeners.add(listener);return()=>listeners.delete(listener)}
function request(type,payload={}){const requestId=crypto.randomUUID();return new Promise((resolve,reject)=>{pending.set(requestId,{resolve,reject});window.parent.postMessage({type,requestId,...payload},'*')})}
window.addEventListener('message',({data})=>{const entry=pending.get(data?.requestId);if(entry){pending.delete(data.requestId);if(String(data.type||'').endsWith('-error'))entry.reject(new Error(data.error||'SuperHigh 请求失败。'));else entry.resolve(data.result)}if(data?.type==='superhigh-editor:context'){context.pageId=data.pageId??null;context.codePreviewRoot=data.codePreviewRoot??null;contextListeners.forEach(listener=>listener({...context}))}if(data?.type==='superhigh-editor:code-preview-content')previewListeners.forEach(listener=>listener(data.path,data.content,{isDirty:data.isDirty===true}));if(data?.type==='superhigh-editor:workspace-files-changed')workspaceChangeListeners.forEach(listener=>listener(data.paths??[],data.kind))})
window.superhigh=window.superhigh||{}
window.superhighEditor={
  request,
  fs:(operation,path,payload={})=>request('superhigh-editor:fs',{operation,path,...payload}),
  runScriptTool:(toolId,values={})=>request('superhigh-editor:script-tool',{toolId,values}),
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
