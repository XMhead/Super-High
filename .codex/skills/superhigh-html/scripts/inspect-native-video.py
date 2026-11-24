import argparse
import ctypes as c
from ctypes import wintypes as w
import json
import os
from pathlib import Path
import struct


FIELD_CONSUMERS = {
    'complete': {'superhigh-html/SKILL.md': 'Repeat collection when target identity or bounded coverage is incomplete.'},
    'pid': {'superhigh-html/SKILL.md': 'Match the selected desktop process before interpreting native video evidence.'},
    'window': {'superhigh-html/SKILL.md': 'Verify the owning HWND, executable, visibility and physical bounds.'},
    'surfaces': {'superhigh-html/SKILL.md': 'Compare native visibility and clipping with DOM occlusion before choosing a rendering fix.'},
    'remainingSurfaces': {'superhigh-html/SKILL.md': 'Increase the limit when native surface coverage was capped.'},
    'screenshot': {'superhigh-html/SKILL.md': 'Inspect the target window PNG alongside native surface evidence.'},
    'errors': {'superhigh-html/SKILL.md': 'Re-select a missing or ambiguous target and retry failed collection.'},
}


class BitmapHeader(c.Structure):
    _fields_ = [('size', w.DWORD), ('width', w.LONG), ('height', w.LONG),
                ('planes', w.WORD), ('bits', w.WORD), ('compression', w.DWORD),
                ('image_size', w.DWORD), ('xppm', w.LONG), ('yppm', w.LONG),
                ('colors', w.DWORD), ('important_colors', w.DWORD)]


class Windows:
    def __init__(self):
        if os.name != 'nt':
            raise OSError('Native video inspection requires Windows')
        self.user = c.WinDLL('user32', use_last_error=True)
        self.gdi = c.WinDLL('gdi32', use_last_error=True)
        self.kernel = c.WinDLL('kernel32', use_last_error=True)
        self.callback = c.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
        signatures = {
            self.user: {
                'EnumWindows': ([self.callback, w.LPARAM], w.BOOL),
                'EnumChildWindows': ([w.HWND, self.callback, w.LPARAM], w.BOOL),
                'GetWindowThreadProcessId': ([w.HWND, c.POINTER(w.DWORD)], w.DWORD),
                'GetClassNameW': ([w.HWND, w.LPWSTR, c.c_int], c.c_int),
                'GetWindowRect': ([w.HWND, c.POINTER(w.RECT)], w.BOOL),
                'GetParent': ([w.HWND], w.HWND),
                'GetAncestor': ([w.HWND, w.UINT], w.HWND),
                'IsWindowVisible': ([w.HWND], w.BOOL),
                'IsIconic': ([w.HWND], w.BOOL),
                'GetWindowRgn': ([w.HWND, w.HANDLE], c.c_int),
                'GetWindowDC': ([w.HWND], w.HDC),
                'ReleaseDC': ([w.HWND, w.HDC], c.c_int),
                'PrintWindow': ([w.HWND, w.HDC, w.UINT], w.BOOL),
                'SetProcessDpiAwarenessContext': ([w.HANDLE], w.BOOL),
            },
            self.gdi: {
                'CreateRectRgn': ([c.c_int] * 4, w.HANDLE),
                'GetRegionData': ([w.HANDLE, w.DWORD, c.c_void_p], w.DWORD),
                'DeleteObject': ([w.HANDLE], w.BOOL),
                'CreateCompatibleDC': ([w.HDC], w.HDC),
                'CreateCompatibleBitmap': ([w.HDC, c.c_int, c.c_int], w.HANDLE),
                'SelectObject': ([w.HDC, w.HANDLE], w.HANDLE),
                'DeleteDC': ([w.HDC], w.BOOL),
                'GetDIBits': ([w.HDC, w.HANDLE, w.UINT, w.UINT, c.c_void_p, c.POINTER(BitmapHeader), w.UINT], c.c_int),
            },
            self.kernel: {
                'OpenProcess': ([w.DWORD, w.BOOL, w.DWORD], w.HANDLE),
                'CloseHandle': ([w.HANDLE], w.BOOL),
                'QueryFullProcessImageNameW': ([w.HANDLE, w.DWORD, w.LPWSTR, c.POINTER(w.DWORD)], w.BOOL),
                'WaitForSingleObject': ([w.HANDLE, w.DWORD], w.DWORD),
            },
        }
        for library, functions in signatures.items():
            for name, (args, result) in functions.items():
                function = getattr(library, name)
                function.argtypes, function.restype = args, result
        self.user.SetProcessDpiAwarenessContext(c.c_void_p(-4))

    def enumerate(self, parent=None):
        handles = []
        callback = self.callback(lambda hwnd, _: handles.append(hwnd) or True)
        if parent is None:
            self.user.EnumWindows(callback, 0)
        else:
            self.user.EnumChildWindows(parent, callback, 0)
        return handles

    def pid(self, hwnd):
        pid = w.DWORD()
        if not self.user.GetWindowThreadProcessId(hwnd, c.byref(pid)):
            raise OSError('Target HWND disappeared')
        return pid.value

    def class_name(self, hwnd):
        value = c.create_unicode_buffer(256)
        self.user.GetClassNameW(hwnd, value, len(value))
        return value.value

    def bounds(self, hwnd):
        rect = w.RECT()
        if not self.user.GetWindowRect(hwnd, c.byref(rect)):
            raise OSError('Cannot read target window bounds')
        return [rect.left, rect.top, rect.right, rect.bottom]

    def window(self, hwnd):
        return {'hwnd': hwnd, 'visible': bool(self.user.IsWindowVisible(hwnd)), 'bounds': self.bounds(hwnd)}

    def players(self, hwnd):
        return [child for child in self.enumerate(hwnd) if self.class_name(child).lower() == 'mpv']

    def region(self, hwnd, limit):
        handle = self.gdi.CreateRectRgn(0, 0, 0, 0)
        if not handle:
            raise OSError('Cannot allocate a clipping region')
        try:
            kind = self.user.GetWindowRgn(hwnd, handle)
            size = self.gdi.GetRegionData(handle, 0, None) if kind else 0
            if not size:
                return {'kind': kind, 'rectangles': [], 'remaining': 0}
            if size < 32 or size > 16 * 1024 * 1024:
                raise OSError('Invalid clipping region size')
            data = c.create_string_buffer(size)
            if self.gdi.GetRegionData(handle, size, data) != size:
                raise OSError('Clipping region changed while reading')
            count = struct.unpack_from('<I', data, 8)[0]
            if 32 + count * 16 > size:
                raise OSError('Incomplete clipping region')
            rectangles = [list(struct.unpack_from('<4l', data, 32 + index * 16)) for index in range(min(limit, count))]
            return {'kind': kind, 'rectangles': rectangles, 'remaining': max(0, count - limit)}
        finally:
            self.gdi.DeleteObject(handle)

    def capture(self, hwnd, expected_bounds):
        from PIL import Image
        if self.user.IsIconic(hwnd) or not self.user.IsWindowVisible(hwnd):
            raise OSError('Capture requires a visible, non-minimized target window')
        left, top, right, bottom = expected_bounds
        width, height = right - left, bottom - top
        if width <= 0 or height <= 0:
            raise OSError('Invalid capture dimensions')
        source = self.user.GetWindowDC(hwnd)
        memory = bitmap = previous = None
        try:
            if not source:
                raise OSError('Cannot read target window DC')
            memory = self.gdi.CreateCompatibleDC(source)
            bitmap = self.gdi.CreateCompatibleBitmap(source, width, height)
            if not memory or not bitmap:
                raise OSError('Cannot allocate target window bitmap')
            previous = self.gdi.SelectObject(memory, bitmap)
            if not previous or previous == c.c_void_p(-1).value:
                raise OSError('Cannot select target window bitmap')
            if not self.user.PrintWindow(hwnd, memory, 2):
                raise OSError('PrintWindow failed')
            self.gdi.SelectObject(memory, previous)
            previous = None
            header = BitmapHeader(size=c.sizeof(BitmapHeader), width=width, height=-height, planes=1, bits=32)
            pixels = c.create_string_buffer(width * height * 4)
            if self.gdi.GetDIBits(source, bitmap, 0, height, pixels, c.byref(header), 0) != height:
                raise OSError('Cannot read target window pixels')
            if self.bounds(hwnd) != expected_bounds:
                raise OSError('Target window moved or resized during capture; collect again')
            return Image.frombytes('RGB', (width, height), pixels.raw, 'raw', 'BGRX')
        finally:
            if previous and memory:
                self.gdi.SelectObject(memory, previous)
            if bitmap:
                self.gdi.DeleteObject(bitmap)
            if memory:
                self.gdi.DeleteDC(memory)
            if source:
                self.user.ReleaseDC(hwnd, source)


def inspect(pid, hwnd=None, output=None, limit=8, api=None):
    api = api or Windows()
    process = api.kernel.OpenProcess(0x101000, False, pid)
    if not process:
        raise OSError('Target process is unavailable')
    try:
        if hwnd is None:
            candidates = [handle for handle in api.enumerate() if api.pid(handle) == pid and api.players(handle)]
            if not candidates:
                raise ValueError('No native video owner; open the target video before collecting evidence')
            if len(candidates) > 1:
                raise ValueError(f'Expected one native video owner; found {len(candidates)}: HWNDs {candidates[:limit]}. Select --hwnd explicitly')
            hwnd = candidates[0]
        if api.pid(hwnd) != pid or api.user.GetAncestor(hwnd, 2) != hwnd:
            raise ValueError('--hwnd must be a top-level window belonging to --pid')
        executable = c.create_unicode_buffer(32768)
        length = w.DWORD(len(executable))
        if not api.kernel.QueryFullProcessImageNameW(process, 0, executable, c.byref(length)):
            raise OSError('Cannot identify target executable')
        owner = {**api.window(hwnd), 'executable': executable.value}
        players = api.players(hwnd)
        groups = {}
        for player in players:
            parent = api.user.GetParent(player)
            groups.setdefault(parent, []).append(player)
        surfaces = [{**api.window(parent), 'region': api.region(parent, limit),
                     'players': [api.window(player) for player in children]}
                    for parent, children in list(groups.items())[:limit]]
        if not surfaces:
            raise ValueError('No native video surface in the selected owner window')
        capture = api.capture(hwnd, owner['bounds']) if output else None
        if api.kernel.WaitForSingleObject(process, 0) != 258 or api.pid(hwnd) != pid:
            raise OSError('Target process or window changed during collection')
        screenshot = None
        if capture is not None:
            output = Path(output).resolve()
            output.parent.mkdir(parents=True, exist_ok=True)
            capture.save(output, format='PNG')
            screenshot = {'path': str(output), 'width': capture.width, 'height': capture.height,
                          'method': 'PrintWindow(PW_RENDERFULLCONTENT)'}
        return {'complete': len(groups) <= limit and not any(surface['region']['remaining'] for surface in surfaces),
                'pid': pid, 'window': owner, 'surfaces': surfaces,
                'remainingSurfaces': max(0, len(groups) - limit), 'screenshot': screenshot, 'errors': []}
    finally:
        api.kernel.CloseHandle(process)


def main():
    parser = argparse.ArgumentParser(description='Read exact Windows native video HWND visibility and clipping; optionally capture the owning window without activating it.')
    parser.add_argument('--pid', type=int, required=True)
    parser.add_argument('--hwnd', type=lambda value: int(value, 0), help='Exact top-level HWND; required when multiple video owners exist')
    parser.add_argument('--output', type=Path, help='Optional original-resolution PrintWindow PNG; inspect pixels to verify GPU video content')
    parser.add_argument('--limit', type=int, default=8, help='Maximum surfaces and region rectangles, 1..20')
    args = parser.parse_args()
    if args.pid <= 0 or not 1 <= args.limit <= 20 or (args.hwnd is not None and args.hwnd <= 0) or (args.output and args.output.suffix.lower() != '.png'):
        parser.error('Require positive PID/HWND, limit 1..20 and a .png output path')
    try:
        result = inspect(args.pid, args.hwnd, args.output, args.limit)
    except (OSError, ValueError, ImportError) as error:
        result = {'complete': False, 'pid': args.pid, 'errors': [str(error)]}
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['complete'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
