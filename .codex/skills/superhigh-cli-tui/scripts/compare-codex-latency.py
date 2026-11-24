import argparse, importlib.util, json, os, pathlib, shutil, sqlite3, subprocess, time, uuid
from datetime import datetime, timezone

SOURCE=pathlib.Path.home()/'.codex'
WORKSPACE=pathlib.Path(__file__).resolve().parents[4]
HELPER=WORKSPACE/'scripts/check-agent-host.py'
CLI=WORKSPACE/'.superhigh/cache/desktop-runtime/superhigh-cli.exe'
CODEX=pathlib.Path(os.environ.get('APPDATA', pathlib.Path.home()/'AppData/Roaming'))/'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'
ROUTE_HELPER=None
PROMPT='Reply exactly LATENCY_OK. Do not use tools, search, modify files, or delegate.'

def now():return datetime.now(timezone.utc).isoformat()
def epoch(v):return datetime.fromisoformat(v.replace('Z','+00:00')).timestamp()
def helper():
 s=importlib.util.spec_from_file_location('hostcheck',HELPER);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

def sqlite_clone(src,dst):
 a=sqlite3.connect('file:'+str(src).replace('\\','/')+'?mode=ro',uri=True);b=sqlite3.connect(dst);a.backup(b);b.close();a.close()

def clone_history(src,dst):
 a=sqlite3.connect('file:'+str(src).replace('\\','/')+'?mode=ro',uri=True);b=sqlite3.connect(dst)
 for typ,name,sql in a.execute("select type,name,sql from sqlite_master where sql is not null and name not like 'sqlite_%' order by case type when 'table' then 0 else 1 end"):
  b.execute(sql)
 for table, in a.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'"):
  cols=[r[1] for r in a.execute('pragma table_info("'+table+'")')]
  if table=='_sqlx_migrations':rows=a.execute('select * from "'+table+'"').fetchall()
  elif 'thread_id' in cols: rows=a.execute('select * from "'+table+'" where thread_id=?',(ID,)).fetchall()
  else: rows=[]
  if rows:b.executemany('insert into "'+table+'" values ('+','.join('?'*len(cols))+')',rows)
 b.commit();b.close();a.close()

def prepare(root):
 root.mkdir(parents=True,exist_ok=False)
 frozen=root/'frozen.jsonl';shutil.copyfile(ROLLOUT,frozen)
 data=frozen.read_bytes();pos=data.rfind(b'\n');assert pos>0;frozen.write_bytes(data[:pos+1])
 (root/'frozen-state.sqlite').parent.mkdir(exist_ok=True)
 sqlite_clone(SOURCE/'state_5.sqlite',root/'frozen-state.sqlite');clone_history(SOURCE/'thread_history_1.sqlite',root/'frozen-history.sqlite')
 for mode in ('embedded','direct'):
  home=root/mode/'home';home.mkdir(parents=True)
  for name in ('auth.json','config.toml','models_cache.json','.codex-global-state.json','AGENTS.md'):
   p=SOURCE/name
   if p.is_file():shutil.copy2(p,home/name)
  dest=home/ROLLOUT.relative_to(SOURCE);dest.parent.mkdir(parents=True);shutil.copyfile(frozen,dest)
  shutil.copyfile(root/'frozen-state.sqlite',home/'state_5.sqlite');shutil.copyfile(root/'frozen-history.sqlite',home/'thread_history_1.sqlite')
  c=sqlite3.connect(home/'state_5.sqlite');c.execute('update threads set rollout_path=? where id=?',(str(dest),ID));c.commit();c.close()
 return len(data[:pos+1])

def route():
 if ROUTE_HELPER is None:return {}
 try:
  spec=importlib.util.spec_from_file_location('clash',ROUTE_HELPER);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
  status,body=m.request('GET','/connections');v=json.loads(body);rows=m.safe_connections(v,['chatgpt.com']);return {'status':status,'connections':[{'host':r['host'],'chains':r['chains'],'source_port':r['source_port']} for r in rows]}
 except Exception as e:return {'error_class':type(e).__name__}

def events(home,after):
 p=home/'logs_2.sqlite'
 if not p.exists():return {}
 try:
  c=sqlite3.connect('file:'+str(p).replace('\\','/')+'?mode=ro',uri=True)
  rows=c.execute('select ts,ts_nanos,target,feedback_log_body from logs where ts>=? order by ts,ts_nanos',(int(after),)).fetchall();out={}
  for ts,ns,target,body in rows:
   text=(body or '').lower();when=ts+ns/1e9
   if when<after:continue
   if 'connecting to responses websocket' in text:out.setdefault('websocket_connect_epoch',when)
   if 'successfully connected to responses websocket' in text:out.setdefault('websocket_connected_epoch',when)
   if target=='codex_http_client::request' and 'pre_compression_bytes' in text:out.setdefault('http_request_epoch',when)
   if 'falling back to http' in text:out.setdefault('fallback_epoch',when)
   if 'stream disconnected' in text:out['stream_disconnects']=out.get('stream_disconnects',0)+1
  c.close();return out
 except (sqlite3.Error,OSError):return {}

def read_native_events(path,offset):
 result={}
 with path.open('rb') as stream:
  stream.seek(offset)
  for line in stream:
   try:item=json.loads(line)
   except (ValueError,UnicodeDecodeError):continue
   payload=item.get('payload',{})
   kind=payload.get('type')
   if item.get('type')=='event_msg' and kind=='task_started':result.setdefault('task_started_at',item.get('timestamp'))
   if item.get('type')=='turn_context':
    result['model']=payload.get('model')
    result['effort']=payload.get('effort')
   if item.get('type')=='event_msg' and kind=='task_complete':
    result['task_complete_at']=item.get('timestamp')
    result['native_ttft_ms']=payload.get('time_to_first_token_ms')
    result['native_duration_ms']=payload.get('duration_ms')
 return result


def run(root,mode,h,timeout):
 area=root/mode;home=area/'home';directory=area/'host';directory.mkdir();sid=str(uuid.uuid4()); kind='codex' if mode=='embedded' else 'local'
 args=['--dangerously-bypass-approvals-and-sandbox'] if mode=='embedded' else ['--no-daemon','--dangerously-bypass-approvals-and-sandbox','resume',ID]
 spec={'session':{'id':sid,'title':'Codex latency comparison','providerKind':kind,'cwd':str(CWD),'readOnly':False},'workspace_id':'probe','project':str(CWD),'cwd':str(CWD),'env':{'CODEX_HOME':str(home)},'initial_input':None,'native_session_id':ID if mode=='embedded' else None,'data_dir':str(area/'data'),'launch':{'program':str(CODEX),'args':args,'title':'Codex latency comparison','path_env':None,'superhigh_cli_path':str(CLI)}}
 result={'mode':mode,'started_at':now(),'status':'starting','route_before':route(),'owned':[]};record=None;worker=None
 try:
  worker=subprocess.Popen([str(CLI),'__agent-host',str(directory)],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW)
  worker.stdin.write(json.dumps(spec).encode());worker.stdin.close();h.wait_for(lambda:(directory/'state.json').exists() or worker.poll() is not None,40)
  if not (directory/'state.json').exists():raise RuntimeError('host failed')
  record=json.loads((directory/'state.json').read_text(encoding='utf8'));assert h.identity(record['process']['pid'])==record['process'];result['host_identity']=record['process'];result['child_identity']=h.identity(h.rpc(record,'status')['processId']);print(json.dumps({'mode':mode,'host_identity':result['host_identity'],'child_identity':result['child_identity']}),flush=True)
  start=time.monotonic();last=0
  while time.monotonic()-start<90:
   snap=h.rpc(record,'buffer');running=h.rpc(record,'status')['running'];t=snap['buffer']
   if not running:raise RuntimeError('CLI exited before ready')
   if ('❯' in t or '›' in t) and ('esc' in t.lower() or 'context' in t.lower() or 'codex' in t.lower()):break
   if time.monotonic()-last>25: print(mode,'waiting-ready',round(time.monotonic()-start),flush=True);last=time.monotonic()
   time.sleep(.5)
  else:raise TimeoutError('ready')
  time.sleep(2)
  transcript=home/ROLLOUT.relative_to(SOURCE)
  offset=transcript.stat().st_size
  h.rpc(record,'input',input='\x1b[200~'+PROMPT+'\x1b[201~')
  time.sleep(.6)
  result['initial_enter_at']=now()
  sent=time.time()
  h.rpc(record,'input',input='\r')
  last=0
  retried=False
  while time.time()-sent<timeout:
   parsed=read_native_events(transcript,offset)
   result.update(parsed)
   if parsed.get('task_complete_at'):
    result['status']='complete'
    break
   if not retried and not parsed.get('task_started_at') and time.time()-sent>=5:
    result['second_enter_at']=now()
    h.rpc(record,'input',input='\r')
    retried=True
   if time.monotonic()-last>25:
    print(mode,'waiting',round(time.time()-sent),'task_started',bool(parsed.get('task_started_at')),flush=True)
    last=time.monotonic()
   time.sleep(.2)
  else:result['status']='timeout'
  result['api_timing']=events(home,sent);result['route_after']=route()
 except Exception as e:result.update(status='error',error_class=type(e).__name__,error_stage=str(e) if str(e) in ('host failed','CLI exited before ready','ready') else None)
 finally:
  if record and h.identity(record['process']['pid'])==record['process']:
   result['owned']=h.descendants(record['process']['pid'])
   try:h.rpc(record,'terminate');h.wait_for(lambda:h.identity(record['process']['pid'])!=record['process'],20)
   except Exception:pass
  elif worker and worker.poll() is None:
   result['owned']=h.descendants(worker.pid);worker.terminate()
  for p in result['owned']:
   if h.identity(p['pid'])==p:subprocess.run(['taskkill','/PID',str(p['pid']),'/F'],capture_output=True,creationflags=subprocess.CREATE_NO_WINDOW)
  time.sleep(1);result['remaining']=[p for p in result['owned'] if h.identity(p['pid'])==p]
 return result

def main():
 global SOURCE,CWD,ID,ROLLOUT,CLI,CODEX,ROUTE_HELPER
 ap=argparse.ArgumentParser(description='Compare isolated same-history Codex TTFT through embedded and direct AgentHost paths.')
 ap.add_argument('--source-home',type=pathlib.Path,default=SOURCE)
 ap.add_argument('--thread-id',required=True)
 ap.add_argument('--rollout',type=pathlib.Path,required=True)
 ap.add_argument('--cwd',type=pathlib.Path,required=True)
 ap.add_argument('--cli',type=pathlib.Path,default=CLI)
 ap.add_argument('--codex',type=pathlib.Path,default=CODEX)
 ap.add_argument('--route-helper',type=pathlib.Path,help='Optional route diagnostics Python module.')
 ap.add_argument('--workdir',type=pathlib.Path,required=True)
 ap.add_argument('--output',type=pathlib.Path,required=True)
 ap.add_argument('--timeout',type=int,default=180)
 a=ap.parse_args()
 if not 0<a.timeout<=240:ap.error('timeout must be between 1 and 240 seconds')
 SOURCE=a.source_home.resolve();CWD=a.cwd.resolve();ID=a.thread_id;ROLLOUT=a.rollout.resolve();CLI=a.cli.resolve();CODEX=a.codex.resolve()
 ROUTE_HELPER=a.route_helper.resolve() if a.route_helper else None
 try:ROLLOUT.relative_to(SOURCE)
 except ValueError:ap.error('rollout must be inside source-home')
 root=a.workdir.resolve();out=a.output.resolve()
 if root.exists() or out.exists() or root==SOURCE or SOURCE in root.parents or root in out.parents:ap.error('workdir and output must be new and separate from source-home')
 if not all(x.is_file() for x in (ROLLOUT,CLI,CODEX,HELPER)) or not CWD.is_dir():ap.error('source rollout, executables or cwd missing')
 report={'created_at':now(),'method':'frozen rollout + selected SQLite rows; sequential real installed agent host','results':[]}
 report['frozen_bytes']=prepare(root);out.parent.mkdir(parents=True,exist_ok=True)
 with out.open('x',encoding='utf8') as f:f.write(json.dumps(report,ensure_ascii=False,indent=2))
 h=helper()
 for mode in ('embedded','direct'):
  result=run(root,mode,h,a.timeout);report['results'].append(result);out.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8');print(json.dumps(result,ensure_ascii=False),flush=True)
  if result.get('remaining'):break
 report['finished_at']=now();out.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
 return 0 if len(report['results'])==2 and all(r['status']=='complete' and not r.get('remaining') for r in report['results']) else 1

if __name__=='__main__':raise SystemExit(main())
