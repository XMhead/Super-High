"""Exercise renderer reports with isolated synthetic evidence, without model calls."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from PIL import Image


FIXTURE = None
ENGINES = ('xterm-webgl', 'wraith-webgpu')


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.area = tempfile.TemporaryDirectory(prefix='renderer-summary-', dir=FIXTURE)
        self.root = Path(self.area.name).resolve()
        self.assertEqual(self.root.parent, FIXTURE)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.script = self.root / 'summarize-terminal-benchmark.py'
        shutil.copy2(Path(__file__).with_name('summarize-terminal-benchmark.py'), self.script)
        capture = {'status': 'complete', 'requestedModel': 'fixture-codex', 'native': {'model': 'fixture-codex', 'token_usage': {}},
                   'chunks': [{'data': 'small fixture'}], 'remainingProcesses': [], 'bytes': 13,
                   'sha256': hashlib.sha256(b'small fixture').hexdigest()}
        (self.source / 'codex-recording.json').write_text(json.dumps(capture), encoding='utf-8')
        for name in ('full', 'sustained-control', 'dpi-check', 'dpi-native-scale', 'dense-pixels'):
            folder = self.source / name
            folder.mkdir()
            checks = []
            for engine in ENGINES:
                image = f'{engine}.png'
                Image.new('RGB', (2, 2), (20, 30, 40)).save(folder / image)
                checks.append({'engine': engine, 'dpr': 2 if name == 'dpi-native-scale' else 1, 'screenshot': image,
                               'pixelChecks': [{'label': 'background', 'x': 0, 'y': 0, 'rgb': [20, 30, 40]}]})
            runs = []
            for scene in (('sparse', 'logs', 'dense') if name == 'full' else ('dense',)):
                for engine in ENGINES:
                    runs.append(self.run_row(engine, scene, 1))
            if name == 'full':
                runs.extend(self.run_row(engine, 'dense', 'geometry-1') for engine in ENGINES)
            if name == 'dense-pixels':
                for row, check in zip(runs, checks):
                    row.update(check)
            report = {'complete': True, 'cleanup': {'remaining': []}, 'correctness': checks, 'runs': runs,
                      'scaling': {'processScale': 2}, 'versions': {'@xterm/xterm': '6.0.0', 'wraithterm': 'fixture-version'},
                      'environment': {'font': 'fixture-font'}, 'browser': {'product': 'Fixture Browser'}, 'scope': 'synthetic fixture',
                      'systemGpu': {'devices': [{'deviceString': 'Fixture GPU'}]},
                      'replay': [{'engine': engine, 'screenshot': f'{engine}.png', 'writeCallbackMs': {'p50': 4},
                                  'preprocessMs': {'p50': 2}, 'completedReplayMs': {'p50': 73.1}} for engine in ENGINES]}
            (folder / 'results.json').write_text(json.dumps(report), encoding='utf-8')

    @staticmethod
    def run_row(engine, scene, round_id):
        return {'engine': engine, 'scene': scene, 'round': round_id, 'completedUpdatesPerSecond': 100 if engine == ENGINES[0] else 50,
                'cpuMs': {'mean': 1}, 'payloadSha256': 'same-input', 'fingerprint': {'textSha256': 'same-output', 'visibleSha256': 'same-screen'},
                'updates': 8, 'bytes': 20}

    def tearDown(self):
        self.area.cleanup()

    def run_report(self):
        return subprocess.run([sys.executable, '-B', str(self.script), '--source', str(self.source),
            '--output', str(self.root / 'report'), '--ui', str(self.root / 'report.shui')],
            capture_output=True, text=True, encoding='utf-8', timeout=15)

    def change(self, path, edit):
        file = self.source / path
        data = json.loads(file.read_text(encoding='utf-8'))
        edit(data)
        file.write_text(json.dumps(data), encoding='utf-8')

    def test_report_uses_measured_model_versions_size_latency_and_scaling(self):
        result = self.run_report()
        self.assertEqual(result.returncode, 0, result.stderr)
        summary = json.loads((self.root / 'report/summary.json').read_text(encoding='utf-8'))
        self.assertNotIn('deployment', summary)
        self.assertEqual(summary['metrics'][0]['pairedMedianSpeedup'], 0.5)
        self.assertEqual(summary['chartSeries'][1]['name'], 'Wraith fixture-version')
        ui = (self.root / 'report.shui').read_text(encoding='utf-8')
        for expected in ('fixture-codex', '73.1ms', '0.0 KiB', '200%'):
            self.assertIn(expected, ui)
        for unsupported in ('压力负载中领先', '145 KB', '约33ms', '均未改动'):
            self.assertNotIn(unsupported, ui)

    def test_legacy_evidence_keeps_unrecorded_process_scale_unknown(self):
        self.change('dpi-native-scale/results.json', lambda report: report.pop('scaling'))
        result = self.run_report()
        self.assertEqual(result.returncode, 0, result.stderr)
        summary = json.loads((self.root / 'report/summary.json').read_text(encoding='utf-8'))
        self.assertIsNone(summary['correctness']['nativeScale'])
        self.assertIn('进程缩放未记录', (self.root / 'report.shui').read_text(encoding='utf-8'))

    def test_mismatched_model_and_unfinished_processes_block_report(self):
        self.change('codex-recording.json', lambda capture: capture['native'].update(model='different-model'))
        result = self.run_report()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('model was not confirmed', result.stderr)
        self.change('codex-recording.json', lambda capture: capture['native'].update(model='fixture-codex'))
        self.change('codex-recording.json', lambda capture: capture.update(remainingProcesses=[{'pid': 1}]))
        result = self.run_report()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('processes still require cleanup', result.stderr)
        self.assertFalse((self.root / 'report.shui').exists())


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tmp-root', type=Path, required=True)
    args, remaining = parser.parse_known_args()
    FIXTURE = args.tmp_root.resolve()
    if not args.tmp_root.is_absolute() or not FIXTURE.is_dir() or not any(p.name == 'tmp' and p.parent.name == '.agent' for p in [FIXTURE, *FIXTURE.parents]):
        parser.error('--tmp-root must be an existing workspace .agent/tmp directory')
    unittest.main(argv=[sys.argv[0], *remaining])
