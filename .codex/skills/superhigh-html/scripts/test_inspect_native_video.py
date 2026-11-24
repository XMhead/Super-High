import ctypes as c
from ctypes import wintypes as w
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('inspect_native_video', Path(__file__).with_name('inspect-native-video.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class WindowClass(c.Structure):
    _fields_ = [('style', w.UINT), ('procedure', c.c_void_p), ('class_extra', c.c_int),
                ('window_extra', c.c_int), ('instance', w.HANDLE), ('icon', w.HANDLE),
                ('cursor', w.HANDLE), ('background', w.HANDLE), ('menu', w.LPCWSTR), ('name', w.LPCWSTR)]


@unittest.skipUnless(os.name == 'nt', 'Windows fixture')
class NativeVideoEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = module.Windows()
        cls.api.kernel.GetModuleHandleW.argtypes = [w.LPCWSTR]
        cls.api.kernel.GetModuleHandleW.restype = w.HANDLE
        cls.instance = cls.api.kernel.GetModuleHandleW(None)
        cls.api.user.RegisterClassW.argtypes = [c.POINTER(WindowClass)]
        cls.api.user.RegisterClassW.restype = w.WORD
        cls.api.user.CreateWindowExW.argtypes = [w.DWORD, w.LPCWSTR, w.LPCWSTR, w.DWORD,
                                                c.c_int, c.c_int, c.c_int, c.c_int,
                                                w.HWND, w.HANDLE, w.HANDLE, c.c_void_p]
        cls.api.user.CreateWindowExW.restype = w.HWND
        cls.api.user.DestroyWindow.argtypes = [w.HWND]
        cls.api.user.UnregisterClassW.argtypes = [w.LPCWSTR, w.HANDLE]
        window_class = WindowClass(procedure=c.cast(cls.api.user.DefWindowProcW, c.c_void_p).value,
                                   instance=cls.instance, name='mpv')
        assert cls.api.user.RegisterClassW(c.byref(window_class))

    @classmethod
    def tearDownClass(cls):
        cls.api.user.UnregisterClassW('mpv', cls.instance)

    def setUp(self):
        self.owner, self.surface, self.player = self.fixture()

    def tearDown(self):
        self.api.user.DestroyWindow(self.owner)

    def fixture(self):
        create = self.api.user.CreateWindowExW
        owner = create(0, 'Static', None, 0x80000000, 10, 20, 200, 140, None, None, self.instance, None)
        surface = create(0, 'Static', None, 0x50000000, 0, 0, 160, 90, owner, None, self.instance, None)
        player = create(0, 'mpv', None, 0x50000000, 0, 0, 160, 90, surface, None, self.instance, None)
        assert owner and surface and player
        return owner, surface, player

    def test_discovers_the_native_owner_and_physical_surface(self):
        result = module.inspect(os.getpid(), api=self.api)
        self.assertTrue(result['complete'])
        self.assertEqual(result['window']['hwnd'], self.owner)
        self.assertFalse(result['window']['visible'])
        surface = result['surfaces'][0]
        self.assertEqual(surface['hwnd'], self.surface)
        self.assertEqual(surface['bounds'], [10, 20, 170, 110])
        self.assertEqual(surface['players'][0]['hwnd'], self.player)

    def test_cli_inspects_an_explicit_owner_in_another_process(self):
        import json
        response = subprocess.run([sys.executable, '-B', str(Path(module.__file__)), '--pid', str(os.getpid()),
                                   '--hwnd', str(self.owner)], check=True, capture_output=True, text=True,
                                  encoding='utf-8', timeout=10, creationflags=subprocess.CREATE_NO_WINDOW)
        result = json.loads(response.stdout)
        self.assertTrue(result['complete'])
        self.assertEqual(result['window']['hwnd'], self.owner)
        self.assertEqual(result['surfaces'][0]['players'][0]['hwnd'], self.player)

    def test_clipped_region_is_bounded_and_handles_are_released(self):
        self.api.user.SetWindowRgn.argtypes = [w.HWND, w.HANDLE, w.BOOL]
        self.api.gdi.CombineRgn.argtypes = [w.HANDLE, w.HANDLE, w.HANDLE, c.c_int]
        region = self.api.gdi.CreateRectRgn(0, 0, 160, 90)
        cut = self.api.gdi.CreateRectRgn(120, 0, 160, 20)
        try:
            self.assertNotEqual(self.api.gdi.CombineRgn(region, region, cut, 4), 0)
            applied = self.api.user.SetWindowRgn(self.surface, region, False)
            self.assertNotEqual(applied, 0)
            if applied:
                region = None
        finally:
            self.api.gdi.DeleteObject(cut)
            if region:
                self.api.gdi.DeleteObject(region)
        result = module.inspect(os.getpid(), self.owner, limit=1, api=self.api)
        self.assertFalse(result['complete'])
        self.assertEqual(result['surfaces'][0]['region'], {'kind': 3, 'rectangles': [[0, 0, 120, 20]], 'remaining': 1})
        self.api.user.GetGuiResources.argtypes = [w.HANDLE, w.DWORD]
        self.api.kernel.GetCurrentProcess.restype = w.HANDLE
        process = self.api.kernel.GetCurrentProcess()
        before = self.api.user.GetGuiResources(process, 0)
        for _ in range(12):
            self.assertTrue(module.inspect(os.getpid(), self.owner, api=self.api)['complete'])
        self.assertEqual(self.api.user.GetGuiResources(process, 0), before)

    def test_multiple_native_owners_require_explicit_hwnd(self):
        other, _, _ = self.fixture()
        try:
            with self.assertRaisesRegex(ValueError, 'found 2'):
                module.inspect(os.getpid(), api=self.api)
            self.assertEqual(module.inspect(os.getpid(), other, api=self.api)['window']['hwnd'], other)
        finally:
            self.api.user.DestroyWindow(other)

    def test_child_and_foreign_hwnd_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'top-level'):
            module.inspect(os.getpid(), self.player, api=self.api)
        self.api.user.GetShellWindow.restype = w.HWND
        with self.assertRaisesRegex(ValueError, 'belonging'):
            module.inspect(os.getpid(), self.api.user.GetShellWindow(), api=self.api)

    def test_closed_owner_is_not_replaced_by_another_window(self):
        closed, _, _ = self.fixture()
        self.api.user.DestroyWindow(closed)
        with self.assertRaisesRegex(OSError, 'disappeared'):
            module.inspect(os.getpid(), closed, api=self.api)

    def test_process_exit_during_collection_is_rejected(self):
        with patch.object(self.api.kernel, 'WaitForSingleObject', return_value=0):
            with self.assertRaisesRegex(OSError, 'changed during collection'):
                module.inspect(os.getpid(), self.owner, api=self.api)

    def test_capture_does_not_activate_a_hidden_target(self):
        with self.assertRaisesRegex(OSError, 'visible, non-minimized'):
            self.api.capture(self.owner, self.api.bounds(self.owner))
        self.assertFalse(self.api.user.IsWindowVisible(self.owner))


if __name__ == '__main__':
    unittest.main()
