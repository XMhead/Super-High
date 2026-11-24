"""Sample main-screen identity and target app audio while USB updates/debugging run.
No screenshots, media metadata, taps, launches or main-screen changes.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time

FIELD_CONSUMERS = {
    'package': {'superhigh-html/references/mobile-usb.md': 'Identify the sampled main-screen app before interpreting playback evidence.'},
    'duration': {'superhigh-html/references/mobile-usb.md': 'Check that sampling spans the actual update or display operation.'},
    'sampleCount': {'superhigh-html/references/mobile-usb.md': 'Report observed coverage rather than claiming uninterrupted recording.'},
    'mainActivities': {'superhigh-html/references/mobile-usb.md': 'Identify main-screen app switches or installer interception.'},
    'mainStayedInTarget': {'superhigh-html/references/mobile-usb.md': 'Reject a no-interruption claim when the main app changed or was unavailable.'},
    'audioActiveSamples': {'superhigh-html/references/mobile-usb.md': 'Assess target-UID audio continuity separately from main-screen identity.'},
    'audioInactiveSamples': {'superhigh-html/references/mobile-usb.md': 'Reject playback acceptance when any sampled target audio was inactive.'},
    'audioFocusInspection': {'superhigh-html/references/mobile-usb.md': 'Mark unavailable OEM audio-focus evidence without assuming focus stayed unchanged.'},
    'errors': {'superhigh-html/references/mobile-usb.md': 'Reject incomplete sampling before accepting the update.'},
    'samples': {'superhigh-html/references/mobile-usb.md': 'Locate activity or audio transitions by elapsed time and compare output-frame progress.'},
    'limits': {'superhigh-html/references/mobile-usb.md': 'Keep sampling and audio evidence separate from video-frame guarantees.'},
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--adb', default='adb')
    parser.add_argument('--device', required=True)
    parser.add_argument('--package', help='Target app; defaults to the current display-0 app')
    parser.add_argument('--duration', type=int, default=90)
    parser.add_argument('--require-audio', action='store_true',
        help='Also fail when any sample lacks active target-app audio; use for audible playback, omit for QQ or paused video')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not 1 <= args.duration <= 600 or (args.package and not re.fullmatch(r'[\w.]+', args.package)):
        parser.error('Invalid package or duration')

    def adb(*command):
        result = subprocess.run([args.adb, '-s', args.device, 'shell', *command],
            capture_output=True, encoding='utf-8', errors='replace', timeout=15,
            creationflags=0x08000000 if os.name == 'nt' else 0)
        if result.returncode:
            raise RuntimeError('Read-only ADB query failed')
        return result.stdout

    if not args.package:
        activity = adb('dumpsys', 'activity', 'activities')
        main_section = re.search(r'Display #0\b(.*?)(?=\nDisplay #|\Z)', activity, re.S)
        resumed = re.search(r'(?:Resumed:|mResumedActivity:)\s+ActivityRecord\{[^}]*?u\d+\s+(\S+)', main_section[1]) if main_section else None
        if not resumed:
            raise RuntimeError('Display-0 app unavailable')
        args.package = resumed[1].split('/')[0]
    packages = adb('cmd', 'package', 'list', 'packages', '-U', args.package)
    match = re.search(r'package:' + re.escape(args.package) + r'\s+uid:(\d+)', packages)
    if not match:
        raise RuntimeError('Target package UID unavailable')
    uid = match[1]
    focus = adb('dumpsys', 'audio')
    focus_available = 'Exception' not in focus and 'Audio Focus stack' in focus
    started = time.monotonic()
    samples = []
    errors = []
    print(json.dumps({'event': 'started', 'pid': os.getpid(), 'uid': uid, 'duration': args.duration}), flush=True)
    while time.monotonic() - started < args.duration:
        try:
            activity = adb('dumpsys', 'activity', 'activities')
            main_section = re.search(r'Display #0\b(.*?)(?=\nDisplay #|\Z)', activity, re.S)
            resumed = re.search(r'(?:Resumed:|mResumedActivity:)\s+ActivityRecord\{[^}]*?u\d+\s+(\S+)', main_section[1]) if main_section else None
            policy = adb('dumpsys', 'media.audio_policy')
            audio_active = bool(re.search(r'uid\s+' + uid + r';\s+State:\s+Active\b', policy))
            flinger = adb('dumpsys', 'media.audio_flinger')
            outputs = [{'thread': m[1], 'frames': int(m[2])} for m in re.finditer(
                r'Output thread[^\n]*name (\S+),[^\n]*\n(?:(?!Output thread)[\s\S])*?Standby: no\s*\n(?:(?!Output thread)[\s\S])*?Frames written: (\d+)', flinger)]
            samples.append({'seconds': round(time.monotonic() - started, 2),
                'mainActivity': resumed[1] if resumed else None,
                'targetAudioActive': audio_active, 'activeAudioOutputs': outputs})
        except Exception as error:
            errors.append({'seconds': round(time.monotonic() - started, 2), 'error': str(error)})
        time.sleep(0.5)
    main_activities = sorted({s['mainActivity'] for s in samples if s['mainActivity']})
    report = {'package': args.package, 'duration': round(time.monotonic() - started, 2),
        'sampleCount': len(samples), 'mainActivities': main_activities,
        'mainStayedInTarget': bool(samples) and all(s['mainActivity'] and s['mainActivity'].startswith(args.package + '/') for s in samples),
        'audioActiveSamples': sum(s['targetAudioActive'] for s in samples),
        'audioInactiveSamples': sum(not s['targetAudioActive'] for s in samples),
        'audioFocusInspection': 'available' if focus_available else 'unavailable (OEM dumpsys audio error)',
        'errors': errors, 'samples': samples,
        'limits': 'Sampling can miss interruptions between observations; audio output does not prove video frame continuity. User observation remains required.'}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in report.items() if k != 'samples'}, ensure_ascii=False))
    passed = report['mainStayedInTarget'] and not errors
    if args.require_audio:
        passed = passed and report['audioInactiveSamples'] == 0
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
