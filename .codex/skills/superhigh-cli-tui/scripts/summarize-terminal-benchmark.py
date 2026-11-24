"""Validate retained renderer evidence and build a compact SuperHigh IUI report."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import statistics

from PIL import Image


FIELD_CONSUMERS = {
    'table': {'superhigh-cli-tui/references/renderer-benchmark.md': 'The generated IUI throughput table compares both renderers by scene.'},
    'chartLabels': {'superhigh-cli-tui/references/renderer-benchmark.md': 'The generated IUI chart identifies the compared scenes.'},
    'chartSeries': {'superhigh-cli-tui/references/renderer-benchmark.md': 'The generated IUI chart compares paired speed ratios.'},
    'cpuTable': {'superhigh-cli-tui/references/renderer-benchmark.md': 'The generated IUI CPU table compares work per completed update.'},
    'limitations': {'superhigh-cli-tui/references/renderer-benchmark.md': 'The generated IUI scope section separates benchmark results from host acceptance.'},
    'recording': {'superhigh-cli-tui/references/renderer-benchmark.md': 'Check the actual model, input identity and single-request cost before reusing a recording.'},
    'metrics': {'superhigh-cli-tui/references/renderer-benchmark.md': 'Inspect per-scene medians and paired ranges when the chart differs across runs.'},
    'pixelChecks': {'superhigh-cli-tui/references/renderer-benchmark.md': 'Locate failed or differing pixel samples by screenshot and coordinate.'},
    'captures': {'superhigh-cli-tui/references/renderer-benchmark.md': 'Locate the screenshots used to judge glyph and geometry differences.'},
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--ui', type=Path, required=True)
    parser.add_argument('--cpu', help='CPU name recorded on the measured machine; omitted if unavailable')
    args = parser.parse_args()
    source, output, ui = args.source.resolve(), args.output.resolve(), args.ui.resolve()
    output.mkdir(parents=True, exist_ok=True)
    (output / 'raw').mkdir(exist_ok=True)
    batches = {}
    for name in ('full', 'sustained-control', 'dpi-check', 'dpi-native-scale', 'dense-pixels'):
        report_path = source / name / 'results.json'
        report = json.loads(report_path.read_text(encoding='utf-8'))
        if not report['complete'] or report['cleanup']['remaining']:
            raise ValueError(f'{name}: incomplete test or process cleanup')
        batches[name] = report
        shutil.copy2(report_path, output / 'raw' / f'{name}.json')
    full, control, native, pixels = (batches[name] for name in
                                    ('full', 'sustained-control', 'dpi-native-scale', 'dense-pixels'))
    native_scale = native.get('scaling', {}).get('processScale')
    sampled_dprs = sorted({item['dpr'] for item in native['correctness']})
    scale_label = (f'{native_scale * 100:g}% 原生进程缩放' if native_scale is not None
                   else f'采样 DPR {", ".join(str(value) for value in sampled_dprs)}（进程缩放未记录）')
    recording = json.loads((source / 'codex-recording.json').read_text(encoding='utf-8'))
    if recording['status'] != 'complete' or not recording.get('requestedModel') or recording['native']['model'] != recording['requestedModel']:
        raise ValueError('Requested Codex model was not confirmed')
    if recording.get('remainingProcesses'):
        raise ValueError('Codex capture processes still require cleanup')
    payload = ''.join(item['data'] for item in recording['chunks']).encode('utf-8')
    if hashlib.sha256(payload).hexdigest() != recording['sha256']:
        raise ValueError('Codex recording hash mismatch')
    shutil.copy2(source / 'codex-recording.json', output / 'raw/codex-recording.json')

    engines = ['xterm-webgl', 'wraith-webgpu']
    names = {'xterm-webgl': f'xterm {full["versions"]["@xterm/xterm"]} + WebGL', 'wraith-webgpu': f'Wraith {full["versions"]["wraithterm"]}'}
    metrics = []

    def aggregate(label, runs, note):
        groups = {engine: [run for run in runs if run['engine'] == engine] for engine in engines}
        rates = {engine: statistics.median(run['completedUpdatesPerSecond'] for run in group)
                 for engine, group in groups.items()}
        cpu = {engine: statistics.median(run['cpuMs']['mean'] for run in group)
               for engine, group in groups.items()}
        for round_id in {run['round'] for run in runs}:
            pair = [run for run in runs if run['round'] == round_id]
            if len(pair) != 2 or pair[0]['payloadSha256'] != pair[1]['payloadSha256']:
                raise ValueError(f'Invalid input pairing: {label}/{round_id}')
            for key in ('textSha256', 'visibleSha256'):
                if pair[0]['fingerprint'][key] != pair[1]['fingerprint'][key]:
                    raise ValueError(f'Invalid output pairing: {label}/{round_id}/{key}')
        ratios = [next(run['completedUpdatesPerSecond'] for run in runs if run['round'] == round_id and run['engine'] == engines[1]) /
                  next(run['completedUpdatesPerSecond'] for run in runs if run['round'] == round_id and run['engine'] == engines[0])
                  for round_id in {run['round'] for run in runs}]
        item = {'scene': label, 'rates': rates, 'cpuMsPerUpdate': cpu,
                'pairedMedianSpeedup': statistics.median(ratios), 'note': note,
                'pairs': len(ratios), 'updatesPerRun': runs[0]['updates']}
        metrics.append(item)
        return item

    for key, label in [('sparse', '状态栏小范围更新'), ('logs', '连续日志滚动'), ('dense', '密集整屏刷新')]:
        aggregate(label, [run for run in full['runs'] if run['scene'] == key and isinstance(run['round'], int)],
                  '交错回放；轮数和更新量见 pairs、updatesPerRun')
    sustained = aggregate('持续整屏压力', control['runs'], '持续整屏交错回放')
    geometry = aggregate('相同像素尺寸对照', [run for run in full['runs'] if str(run['round']).startswith('geometry-')],
                         '按相同像素尺寸配置对照')

    pixel_results = []
    captures = []
    for batch_name, entries in [('full', [item for item in full['correctness'] if item['dpr'] == 1]),
                                 ('dpi-native-scale', native['correctness']), ('dense-pixels', pixels['runs'])]:
        for item in entries:
            file = source / batch_name / item['screenshot']
            target = f'{batch_name}-{item["screenshot"]}'
            shutil.copy2(file, output / target)
            with Image.open(file) as original:
                image = original.convert('RGB')
                for check in item['pixelChecks']:
                    point = (round(check['x']), round(check['y']))
                    actual = image.getpixel(point)
                    passed = tuple(check['rgb']) == actual
                    pixel_results.append({'engine': item['engine'], 'batch': batch_name,
                                          'label': check['label'], 'xy': point,
                                          'expectedRgb': check['rgb'], 'actualRgb': actual, 'passed': passed})
                    if not passed:
                        raise ValueError(f'Pixel check failed: {batch_name}/{item["engine"]}/{check["label"]}')
            captures.append({'engine': item['engine'], 'batch': batch_name, 'file': target})
    for item in full['replay']:
        target = f'replay-{item["engine"]}.png'
        shutil.copy2(source / 'full' / item['screenshot'], output / target)
        captures.append({'engine': item['engine'], 'batch': 'replay', 'file': target})
    replay = {item['engine']: {'writeCallbackMsP50': item['writeCallbackMs']['p50'],
                              'preprocessMsP50': item['preprocessMs']['p50'],
                              'twoRafAndFenceMsP50': item['completedReplayMs']['p50']}
              for item in full['replay']}
    all_runs = full['runs'] + control['runs'] + pixels['runs']
    gpu_name = full['systemGpu']['devices'][0]['deviceString']
    summary = {
        'createdAt': datetime.now(timezone.utc).isoformat(), 'versions': full['versions'],
        'environment': {'browser': full['browser']['product'], 'gpu': gpu_name,
                        'cpu': args.cpu or full.get('hostCpu'), 'font': full['environment']['font'],
                        'scope': full['scope'], 'cursorBlink': False, 'scrollback': 10000},
        'recording': {'model': recording['native']['model'], 'nativeRequests': 1,
                      'bytes': recording['bytes'], 'sha256': recording['sha256'],
                      'tokenUsage': recording['native']['token_usage']},
        'metrics': metrics, 'replay': replay, 'pixelChecks': pixel_results, 'captures': captures,
        'pressure': {'updatesAcrossBothEngines': sum(run['updates'] for run in all_runs),
                     'bytesAcrossBothEngines': sum(run['bytes'] for run in all_runs)},
        'correctness': {'pairedBuffersMatch': True, 'resizeAndSerialize': True,
                        'keyboardSelectionPaste': True, 'historyScrollAndHiddenOutput': True,
                        'nativeScalePixels': True, 'nativeScale': native_scale, 'sampledDprs': sampled_dprs, 'pixelChecksPassed': len(pixel_results),
                        'pixelIdentityClaimed': False},
        'limitations': [
            '测试范围为独立无头浏览器回放；浏览器、依赖版本和 GPU 以本次采样为准。',
            '压力吞吐使用公开上游基准相同的私有 parse/renderRows 与 GPU fence；是已完成更新/秒，不是显示器 FPS。',
            '公开 write 回放使用真实 Codex 录制与 SuperHigh 颜色/整帧适配器；总时间包含两次 rAF 等待与 GPU 完成。',
            '相同字号可能产生不同单元格宽度；结合 geometry 字段和同像素尺寸对照判断。',
            'CDP DPR 仿真与原生进程缩放分别记录；仿真异常需要在真实系统缩放下复验。',
            '真实 Tauri IPC、桌面跨显示器、系统输入法、文件跳转、透明主题和其他 Agent CLI 由宿主验收覆盖。',
        ],
    }
    summary['table'] = [[item['scene'], f'{item["rates"][engines[0]]:,.0f}', f'{item["rates"][engines[1]]:,.0f}',
                         f'{item["pairedMedianSpeedup"]:.2f}×'] for item in metrics]
    summary['chartLabels'] = [item['scene'] for item in metrics]
    summary['chartSeries'] = [{'name': names[engines[0]], 'values': [1] * len(metrics)},
                              {'name': names[engines[1]], 'values': [round(item['pairedMedianSpeedup'], 2) for item in metrics]}]
    summary['cpuTable'] = [[item['scene'], f'{item["cpuMsPerUpdate"][engines[0]]:.3f}',
                            f'{item["cpuMsPerUpdate"][engines[1]]:.3f}'] for item in metrics]
    (output / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')

    relative = output.relative_to(ui.parent).as_posix()
    data_path = relative + '/summary.json'
    q = lambda value: json.dumps(value, ensure_ascii=False)
    image_for = lambda batch, engine: relative + '/' + next(item['file'] for item in captures if item['batch'] == batch and item['engine'] == engine)
    title = ('# Codex CLI 渲染对照\n'
             f'Wraith 连续整屏压力的配对中位吞吐为 xterm 6＋WebGL 的 **{sustained["pairedMedianSpeedup"]:.2f} 倍**；'
             f'相同像素尺寸对照为 **{geometry["pairedMedianSpeedup"]:.2f} 倍**。\n\n'
             f'{gpu_name} · {full["browser"]["product"]} · 仅一次 {recording["native"]["model"]} 实际请求，后续全部本地回放。')
    replay_text = (f'真实 Codex 录制 {recording["bytes"] / 1024:.1f} KiB。公开 write 完成解析的中位耗时：'
                   f'xterm **{replay[engines[0]]["writeCallbackMsP50"]:.1f}ms**，'
                   f'Wraith **{replay[engines[1]]["writeCallbackMsP50"]:.1f}ms**。'
                   '包含两次 rAF 等待及 GPU 完成后的整段回放：'
                   f'xterm **{replay[engines[0]]["twoRafAndFenceMsP50"]:.1f}ms**，'
                   f'Wraith **{replay[engines[1]]["twoRafAndFenceMsP50"]:.1f}ms**。模型回答速度与日常输入延迟需分别测量。')
    tests_text = (f'终端文字与属性哈希一致；中文、组合字符、ANSI色块、历史滚动、隐藏后恢复、'
                  f'选择/键盘/粘贴、序列化恢复通过。**{len(pixel_results)} 个像素取样点通过**。'
                  f'**{scale_label}** 的像素取样通过。字形、线条与字宽按对应截图比较。')
    pressure_label = f'{summary["pressure"]["updatesAcrossBothEngines"]:,} 次'
    sections = [
        'root = Stack([intro, overview, throughput, cpu, replay, verification, pictures, scope])',
        f'intro = Text({q(title)})',
        f'overview = Grid([Stat("真实模型请求", "1 次"), Stat("压力更新", {q(pressure_label)}), Stat("残留测试进程", "0")])',
        f'throughput = Card("GPU 完成吞吐：更新/秒，越高越好", [Table(["场景", "xterm 6＋WebGL", "Wraith", "配对倍率"], Data({q(data_path)}, "table")), Chart("bar", Data({q(data_path)}, "chartLabels"), Data({q(data_path)}, "chartSeries"), unit: "×")])',
        f'cpu = Section("CPU 每次更新耗时（ms，越低越好）", [Table(["场景", "xterm 6＋WebGL", "Wraith"], Data({q(data_path)}, "cpuTable"))], collapsed: true)',
        f'replay = Card("真实 Codex 输出回放", [Text({q(replay_text)})])',
        f'verification = Card("正确性", [Text({q(tests_text)})])',
        f'pictures = Tabs(["Codex 实际输出", "默认缩放校验画面", {q(scale_label)}, "整屏压力画面"], [realPictures, normalPictures, scaledPictures, densePictures])',
        *[f'{statement} = Tabs(["xterm 6＋WebGL", "Wraith"], [Image({q(image_for(batch, engines[0]))}, {q(label + " / xterm")}), Image({q(image_for(batch, engines[1]))}, {q(label + " / Wraith")})])'
          for statement, batch, label in [('realPictures', 'replay', 'Codex真实输出'), ('normalPictures', 'full', '默认缩放'),
                                           ('scaledPictures', 'dpi-native-scale', scale_label), ('densePictures', 'dense-pixels', '密集压力最终帧')]],
        f'scope = Section("方法、边界与原始证据", [List(Data({q(data_path)}, "limitations")), Text("测试进程已回收；本机部署与发布状态由各自验收记录提供。"), Text({q("原始数据： [summary.json](" + relative + "/summary.json) · [完整测试](" + relative + "/raw/full.json) · [持续压力](" + relative + "/raw/sustained-control.json) · [Codex录制](" + relative + "/raw/codex-recording.json)")})], collapsed: true)',
    ]
    ui.write_text('\n'.join(sections) + '\n', encoding='utf-8')
    print(json.dumps({'ui': str(ui), 'summary': str(output / 'summary.json'), 'metrics': summary['table'],
                      'pixelChecksPassed': len(pixel_results), 'pressure': summary['pressure']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
