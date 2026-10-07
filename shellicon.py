# -*- coding: utf-8 -*-
"""按扩展名取 Windows 自带的文件类型图标，编码成 PNG 字节。

为什么要它：拖进来的文件要在底栏显示成"它本来的样子"（Word 就 Word 的图标）。
浏览器拿不到系统图标，所以由后端取好、以 PNG 发给前端。

三条刻意的选择：
  · **全程 ctypes 直调 shell32/gdi32，不起子进程** —— PowerShell 那条路一次 200~400ms，
    而且要在服务线程里开进程，不划算。
  · **按扩展名取**（SHGFI_USEFILEATTRIBUTES）—— 文件不必存在，于是结果可以一直缓存；
    也就不会因为"文件被删了"而变成白板。
  · **不依赖 PIL** —— 自己拼 PNG（就是 zlib + 四个块），免得为一张 32px 的图
    把 3MB 的 Pillow 拖进 exe。

拿不到就返回 None，让前端退回去画个色块 —— 宁可看见失败，别静默给个空图。
"""
import ctypes
import struct
import zlib
from ctypes import wintypes

_SIZE = 32                      # 系统"大图标"就是 32×32

SHGFI_ICON = 0x000000100
SHGFI_USEFILEATTRIBUTES = 0x000000010
FILE_ATTRIBUTE_NORMAL = 0x00000080
DIB_RGB_COLORS = 0              # = BI_RGB
DI_NORMAL = 0x0003

_shell32 = ctypes.WinDLL("shell32", use_last_error=True)
_user32 = ctypes.WinDLL("user32", use_last_error=True)
_gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)


class _SHFILEINFOW(ctypes.Structure):
    _fields_ = [("hIcon", wintypes.HANDLE),
                ("iIcon", ctypes.c_int),
                ("dwAttributes", wintypes.DWORD),
                ("szDisplayName", wintypes.WCHAR * 260),
                ("szTypeName", wintypes.WCHAR * 80)]


class _BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG),
                ("biHeight", wintypes.LONG), ("biPlanes", wintypes.WORD),
                ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
                ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD),
                ("biClrImportant", wintypes.DWORD)]


class _BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", _BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


# ⚠️ 64 位下这些返回值是**指针**，不声明 restype 会被 ctypes 默认按 int 截断成负数，
#    后面 SelectObject / DeleteObject 全部失效（这个坑很安静，图会画不出来）。
_shell32.SHGetFileInfoW.restype = ctypes.c_void_p
_gdi32.CreateCompatibleDC.restype = ctypes.c_void_p
_gdi32.CreateDIBSection.restype = ctypes.c_void_p
_gdi32.SelectObject.restype = ctypes.c_void_p
_user32.GetDC.restype = ctypes.c_void_p
_user32.DestroyIcon.argtypes = [ctypes.c_void_p]
_user32.DrawIconEx.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
                               ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
                               ctypes.c_uint, ctypes.c_void_p, ctypes.c_uint]
_gdi32.DeleteObject.argtypes = [ctypes.c_void_p]
_gdi32.DeleteDC.argtypes = [ctypes.c_void_p]
_user32.ReleaseDC.argtypes = [ctypes.c_void_p, ctypes.c_void_p]

# ⚠️ 光有 restype 不够 —— **入参也得声明**。不声明时 ctypes 按 Python int 猜成 c_int，
#    64 位句柄一旦超过 2^31 就抛 "int too long to convert"（或更糟：静默截断）。
#    第一次调用侥幸成功、第二次就炸，是最容易被当成"偶发"的那种坑。
_shell32.SHGetFileInfoW.argtypes = [ctypes.c_wchar_p, wintypes.DWORD,
                                    ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint]
_gdi32.CreateCompatibleDC.argtypes = [ctypes.c_void_p]
_user32.GetDC.argtypes = [ctypes.c_void_p]
_gdi32.SelectObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
_gdi32.CreateDIBSection.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint,
                                    ctypes.POINTER(ctypes.c_void_p),
                                    ctypes.c_void_p, ctypes.c_uint]


def _png_rgba(w, h, rgba_topdown):
    """零依赖写 PNG（8 位 RGBA）。PIL 那 3MB 不值得为这张图拖进来。"""
    raw = b"".join(b"\x00" + rgba_topdown[y * w * 4:(y + 1) * w * 4] for y in range(h))

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def icon_png(ext):
    """ext 不带点（如 'docx'）。成功返回 PNG bytes，失败返回 None。"""
    ext = (ext or "").lstrip(".").strip().lower()
    if not ext or len(ext) > 20 or not ext.isalnum():
        return None

    shfi = _SHFILEINFOW()
    res = _shell32.SHGetFileInfoW(ctypes.c_wchar_p("probe." + ext),
                                  FILE_ATTRIBUTE_NORMAL, ctypes.byref(shfi),
                                  ctypes.sizeof(shfi),
                                  SHGFI_ICON | SHGFI_USEFILEATTRIBUTES)
    hicon = shfi.hIcon
    if not res or not hicon:
        return None

    buf = None
    hdc = _user32.GetDC(None)
    memdc = _gdi32.CreateCompatibleDC(hdc)
    try:
        bmi = _BITMAPINFO()
        bmi.bmiHeader.biSize = ctypes.sizeof(_BITMAPINFOHEADER)
        bmi.bmiHeader.biWidth = _SIZE
        bmi.bmiHeader.biHeight = -_SIZE          # 负数 = 自上而下，省得后面翻转
        bmi.bmiHeader.biPlanes = 1
        bmi.bmiHeader.biBitCount = 32
        bmi.bmiHeader.biCompression = DIB_RGB_COLORS
        bits = ctypes.c_void_p()
        hbmp = _gdi32.CreateDIBSection(hdc, ctypes.byref(bmi), DIB_RGB_COLORS,
                                       ctypes.byref(bits), None, 0)
        old = _gdi32.SelectObject(memdc, hbmp)
        try:
            _user32.DrawIconEx(memdc, 0, 0, hicon, _SIZE, _SIZE, 0, None, DI_NORMAL)
            buf = ctypes.string_at(bits, _SIZE * _SIZE * 4)     # BGRA，自上而下
        finally:
            _gdi32.SelectObject(memdc, old)
            if hbmp:
                _gdi32.DeleteObject(hbmp)
    finally:
        if memdc:
            _gdi32.DeleteDC(memdc)
        if hdc:
            _user32.ReleaseDC(None, hdc)
        _user32.DestroyIcon(hicon)

    if not buf:
        return None
    # BGRA → RGBA。DrawIconEx 画出来的 32bpp 是**预乘**的，透明度要用 alpha 反推，
    # 否则边缘会有一圈黑（图标是带透明通道的）。
    out = bytearray(len(buf))
    for i in range(0, len(buf), 4):
        b, g, r, a = buf[i], buf[i + 1], buf[i + 2], buf[i + 3]
        if a and a != 255:
            b = min(255, b * 255 // a)
            g = min(255, g * 255 // a)
            r = min(255, r * 255 // a)
        out[i], out[i + 1], out[i + 2], out[i + 3] = r, g, b, a
    return _png_rgba(_SIZE, _SIZE, bytes(out))
