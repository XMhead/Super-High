import type { ItemLibrarySource } from '@/types'

export function buildProjectEditorBridgeScript(mainSource: ItemLibrarySource) {
  return `(()=>{
const pending=new Map()
const context={pageId:null,codePreviewRoot:null,mainItemLibrarySource:${JSON.stringify(mainSource)}}
const contextListeners=new Set(),previewListeners=new Set(),workspaceChangeListeners=new Set()
const subscribe=(listeners,listener)=>{listeners.add(listener);return()=>listeners.delete(listener)}
function request(type,payload={}){const requestId=crypto.randomUUID();return new Promise((resolve,reject)=>{pending.set(requestId,{resolve,reject});window.parent.postMessage({type,requestId,...payload},'*')})}
window.addEventListener('message',({data})=>{const entry=pending.get(data?.requestId);if(entry){pending.delete(data.requestId);if(String(data.type||'').endsWith('-error'))entry.reject(new Error(data.error||'SuperHigh 请求失败。'));else entry.resolve(data.result)}if(data?.type==='superhigh-editor:context'){context.pageId=data.pageId??null;context.codePreviewRoot=data.codePreviewRoot??null;context.mainItemLibrarySource=data.mainItemLibrarySource==='mm'?'mm':'ni';window.superhigh.itemLibrary.mainSource=context.mainItemLibrarySource;contextListeners.forEach(listener=>listener({...context}))}if(data?.type==='superhigh-editor:code-preview-content')previewListeners.forEach(listener=>listener(data.path,data.content,{isDirty:data.isDirty===true}));if(data?.type==='superhigh-editor:workspace-files-changed')workspaceChangeListeners.forEach(listener=>listener(data.paths??[],data.kind))})
const itemLibrary=window.superhigh?.itemLibrary||{}
const getItemKeys=typeof itemLibrary.getKeys==='function'?itemLibrary.getKeys:(source)=>request('superhigh-editor:item-library-keys',{source})
window.superhigh=window.superhigh||{}
window.superhigh.itemLibrary=Object.assign({},itemLibrary,{mainSource:${JSON.stringify(mainSource)},getKeys:getItemKeys})
const monsterLibrary=window.superhigh.monsterLibrary||{}
const searchMonsters=typeof monsterLibrary.search==='function'?monsterLibrary.search:(query='',options={})=>request('superhigh-editor:monster-library',{query,...options})
window.superhigh.monsterLibrary=Object.assign({},monsterLibrary,{search:searchMonsters})
window.superhighEditor={
  request,
  fs:(operation,path,payload={})=>request('superhigh-editor:fs',{operation,path,...payload}),
  rcon:(command)=>request('superhigh-editor:rcon',{command}),
  runScriptTool:(toolId,values={})=>request('superhigh-editor:script-tool',{toolId,values}),
  toast:(message,level)=>request('superhigh-editor:ui',{operation:'toast',message,...(level==='error'?{level}:{})}),
  confirm:(message)=>request('superhigh-editor:ui',{operation:'confirm',message}),
  copy:(text)=>request('superhigh-editor:ui',{operation:'copy',text}),
  searchItemLibrary:(source,query,options={})=>request('superhigh-editor:item-library',{source,query,...options}),
  searchMonsterLibrary:searchMonsters,
  getItemKeys,
  minecraft:(operation,payload={})=>request('superhigh-editor:minecraft',{operation,...payload}),
  dragonCore:(operation,payload={})=>request('superhigh-editor:dragoncore',{operation,payload}),
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
