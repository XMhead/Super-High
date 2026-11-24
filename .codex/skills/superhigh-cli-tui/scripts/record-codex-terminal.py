"""Record one isolated Codex TUI turn through the installed SuperHigh PTY host."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import tomllib
import uuid


FIELD_CONSUMERS = {
    'chunks': {'superhigh-cli-tui/assets/renderer-benchmark/app.ts': 'Replay the same captured PTY bytes for each renderer.'},
    'cols': {'superhigh-cli-tui/assets/renderer-benchmark/app.ts': 'Restore the recorded terminal width before replay.'},
    'rows': {'superhigh-cli-tui/assets/renderer-benchmark/app.ts': 'Restore the recorded terminal height before replay.'},
    'requestedModel': {'superhigh-cli-tui/scripts/summarize-terminal-benchmark.py': 'Reject a capture whose native model differs from the requested model.'},
    'native': {'superhigh-cli-tui/scripts/summarize-terminal-benchmark.py': 'Identify the actual model and cost of the single captured request.'},
    'status': {'superhigh-cli-tui/scripts/summarize-terminal-benchmark.py': 'Reject incomplete captures before building the comparison.'},
    'bytes': {'superhigh-cli-tui/scripts/summarize-terminal-benchmark.py': 'Report the actual recording size.'},
    'sha256': {'superhigh-cli-tui/scripts/summarize-terminal-benchmark.py': 'Reject altered or mismatched input bytes.'},
    'remainingProcesses': {'superhigh-cli-tui/references/renderer-benchmark.md': 'Locate owned test processes that still require cleanup.'},
}


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def toml_value(value):
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, (str, int, float, list)):
        return json.dumps(value, ensure_ascii=False)
    raise TypeError(type(value).__name__)


def prepare_home(source, home, cwd, model):
    config = tomllib.loads((source / 'config.toml').read_text(encoding='utf-8-sig'))
    home.mkdir(parents=True)
    for name in ('auth.json', 'models_cache.json'):
        if (source / name).is_file():
            shutil.copy2(source / name, home / name)
    provider = config.get('model_provider', 'openai')
    values = {'model': model, 'model_provider': provider, 'model_reasoning_effort': 'low',
              'approval_policy': 'never', 'sandbox_mode': 'read-only',
              'suppress_unstable_features_warning': True}
    if config.get('model_catalog_json'):
        catalog = Path(config['model_catalog_json'])
        shutil.copyfile(catalog, home / 'model-catalog.json')
        values['model_catalog_json'] = (home / 'model-catalog.json').as_posix()
    lines = [f'{key} = {toml_value(value)}' for key, value in values.items()]
    details = config.get('model_providers', {}).get(provider)
    if details:
        lines += ['', f'[model_providers.{json.dumps(provider)}]']
        lines += [f'{key} = {toml_value(value)}' for key, value in details.items()
                  if isinstance(value, (str, bool, int, float, list))]
    lines += ['', f'[projects.{json.dumps(str(cwd))}]', 'trust_level = "trusted"']
    (home / 'config.toml').write_text('\n'.join(lines) + '\n', encoding='utf-8')


def native_turn(home):
    result = {}
    for path in (home / 'sessions').glob('**/*.jsonl'):
        for line in path.read_text(encoding='utf-8', errors='replace').splitlines():
            try:
                item = json.loads(line)
            except ValueError:
                continue
            payload = item.get('payload', {})
            kind = payload.get('type')
            if item.get('type') == 'turn_context':
                result['model'] = payload.get('model')
                result['effort'] = payload.get('effort')
            if item.get('type') == 'event_msg' and kind in ('task_started', 'task_complete'):
                result[kind] = item.get('timestamp')
            if item.get('type') == 'event_msg' and kind == 'token_count':
                result['token_usage'] = payload.get('info', {}).get('total_token_usage')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workdir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--model', default='gpt-6.1-terra')
    parser.add_argument('--source-home', type=Path, default=Path.home() / '.codex')
    parser.add_argument('--cli', type=Path, required=True)
    parser.add_argument('--codex', type=Path, required=True)
    parser.add_argument('--cols', type=int, default=120)
    parser.add_argument('--rows', type=int, default=40)
    parser.add_argument('--timeout', type=int, default=180)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[4]
    helper = load_module(root / 'scripts/check-agent-host.py', 'agent_host_check')
    area = args.workdir.resolve()
    output = args.output.resolve()
    if area.exists() or not (root / '.agent/tmp').resolve() in area.parents:
        parser.error('workdir must be a new directory under this workspace .agent/tmp')
    if area == output or area in output.parents:
        parser.error('output must be outside the disposable capture workdir')
    area.mkdir(parents=True)
    cwd = area / 'workspace'
    cwd.mkdir()
    home = area / 'home'
    directory = area / 'host'
    directory.mkdir()
    session_id = str(uuid.uuid4())
    command_args = ['--no-daemon', '--no-alt-screen', '--model', args.model,
                    '--sandbox', 'read-only', '--ask-for-approval', 'never']
    spec = {'session': {'id': session_id, 'title': 'Codex renderer capture', 'providerKind': 'local',
                        'cwd': str(cwd), 'readOnly': False},
            'workspace_id': 'renderer-benchmark', 'project': str(cwd), 'cwd': str(cwd),
            'env': {'CODEX_HOME': str(home)}, 'initial_input': None, 'native_session_id': None,
            'data_dir': str(area / 'data'),
            'launch': {'program': str(args.codex.resolve()), 'args': command_args,
                       'title': 'Codex renderer capture', 'path_env': None,
                       'superhigh_cli_path': str(args.cli.resolve())}}
    prompt = ('这是一次终端绘制样本采集。不要使用工具、联网、读取文件、修改文件或委派。'
              '请用中文直接写一个约600字的终端渲染测试样本：先给三条简短说明，再给一个12行的'
              'TypeScript代码块（带中文字符串、正则和文件路径），再给一个8行、3列的Markdown表格，'
              '再给一个包含中文和英文的树形目录。使用实际内容，不讨论本提示，不询问。'
              '最后单独写：终端采样完成。')
    report = {'schema': 'superhigh.codex-terminal-recording.v1',
              'createdAt': datetime.now(timezone.utc).isoformat(), 'requestedModel': args.model,
              'cols': args.cols, 'rows': args.rows, 'prompt': prompt, 'chunks': [],
              'scope': 'One real Codex TUI turn; installed SuperHigh PTY host; isolated CODEX_HOME',
              'status': 'starting', 'ownedProcesses': [], 'remainingProcesses': []}
    worker = None
    record = None
    cursor = 0
    started = time.perf_counter()

    def collect():
        nonlocal cursor
        snap = helper.rpc(record, 'buffer', after=cursor)
        if snap['startByte'] > cursor:
            raise RuntimeError('PTY output was truncated before capture')
        data = snap['buffer'].encode('utf-8')
        data = data[max(0, cursor - snap['startByte']):]
        if data:
            report['chunks'].append({'ms': round((time.perf_counter() - started) * 1000, 3),
                                     'data': data.decode('utf-8')})
        cursor = snap['endByte']
        return ''.join(chunk['data'] for chunk in report['chunks'][-8:])

    try:
        prepare_home(args.source_home.resolve(), home, cwd, args.model)
        worker = subprocess.Popen([str(args.cli), '__agent-host', str(directory)], stdin=subprocess.PIPE,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                  creationflags=subprocess.CREATE_NO_WINDOW)
        worker.stdin.write(json.dumps(spec).encode())
        worker.stdin.close()
        helper.wait_for(lambda: (directory / 'state.json').is_file() or worker.poll() is not None, 40)
        if not (directory / 'state.json').is_file():
            raise RuntimeError('Agent host failed to initialize')
        record = json.loads((directory / 'state.json').read_text(encoding='utf-8'))
        report['hostIdentity'] = record['process']
        report['childIdentity'] = helper.identity(helper.rpc(record, 'status')['processId'])
        report['launch'] = {'program': str(args.codex), 'args': command_args}
        print(json.dumps({'stage': 'capture-started', 'model': args.model,
                          'host': report['hostIdentity'], 'child': report['childIdentity']}), flush=True)
        helper.rpc(record, 'resize', cols=args.cols, rows=args.rows)
        deadline = time.monotonic() + 50
        while time.monotonic() < deadline:
            text = collect()
            if ('›' in text or '❯' in text) and ('codex' in text.lower() or 'context' in text.lower()):
                break
            if not helper.rpc(record, 'status')['running']:
                raise RuntimeError('Codex exited before prompt')
            time.sleep(.04)
        else:
            raise TimeoutError('Codex prompt unavailable; inspect capture output')
        helper.rpc(record, 'input', input='\x1b[200~' + prompt + '\x1b[201~')
        time.sleep(.5)
        helper.rpc(record, 'input', input='\r')
        deadline = time.monotonic() + args.timeout
        progress = time.monotonic()
        while time.monotonic() < deadline:
            collect()
            turn = native_turn(home)
            report['native'] = turn
            if turn.get('model') and turn['model'] != args.model:
                raise RuntimeError('Codex used a different model; recording rejected')
            if turn.get('task_complete'):
                time.sleep(.4)
                collect()
                report['status'] = 'complete'
                break
            if time.monotonic() - progress > 10:
                print(json.dumps({'stage': 'capturing', 'bytes': cursor, 'native': turn}), flush=True)
                progress = time.monotonic()
            time.sleep(.04)
        else:
            raise TimeoutError('Codex turn did not complete')
        if report.get('native', {}).get('model') != args.model:
            raise RuntimeError('Native turn did not confirm requested model')
    except Exception as error:
        report['status'] = 'error'
        report['error'] = f'{type(error).__name__}: {error}'
    finally:
        if record and helper.identity(record['process']['pid']) == record['process']:
            report['ownedProcesses'] = helper.descendants(record['process']['pid'])
            try:
                helper.rpc(record, 'terminate')
                helper.wait_for(lambda: helper.identity(record['process']['pid']) != record['process'], 20)
            except Exception:
                pass
        elif worker and worker.poll() is None:
            report['ownedProcesses'] = helper.descendants(worker.pid)
            worker.terminate()
        child = report.get('childIdentity')
        if child and helper.identity(child['pid']) == child and child not in report['ownedProcesses']:
            report['ownedProcesses'] += helper.descendants(child['pid'])
        for process in report['ownedProcesses']:
            if helper.identity(process['pid']) == process:
                subprocess.run(['taskkill', '/PID', str(process['pid']), '/F'], capture_output=True,
                               creationflags=subprocess.CREATE_NO_WINDOW)
        time.sleep(.5)
        report['remainingProcesses'] = [process for process in report['ownedProcesses']
                                        if helper.identity(process['pid']) == process]
        if worker:
            try:
                worker.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        # Authentication copies never leave this disposable area.
        for secret in ('auth.json', 'config.toml'):
            (home / secret).unlink(missing_ok=True)
        payload = ''.join(chunk['data'] for chunk in report['chunks']).encode('utf-8')
        report['bytes'] = len(payload)
        report['sha256'] = hashlib.sha256(payload).hexdigest()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({key: report.get(key) for key in
                          ('status', 'error', 'native', 'bytes', 'sha256', 'remainingProcesses')},
                         ensure_ascii=False), flush=True)
    return 0 if report['status'] == 'complete' and not report['remainingProcesses'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
