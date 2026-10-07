# -*- mode: python ; coding: utf-8 -*-
"""claude-ui 的 PyInstaller 打包配置（onedir）。

三条刻意的选择：
  - **index.html 不打进去** —— 放 exe 旁边，改界面刷新就行，不用重新打包。
  - **addons/ 也不打进去** —— 画布是个附加模块，整个目录放 exe 旁边。
    它在不在，决定这个 exe 有没有画布（server.py 里那段探测）。
  - **console=False** —— 不带黑框窗口（app.py 里处理了 stdout 的坑）。

⚠️ 但 `winrt` **必须打进来**：addons/canvas/handwriting.py 虽然是外置的，
   可它是被 exe 里的解释器动态加载的，用的还是 exe 里这套库。
"""
from PyInstaller.utils.hooks import collect_all

# pywebview 自带 pyinstaller hook，一般能自动找到平台后端；collect_all 再兜一层底。
wv_datas, wv_binaries, wv_hidden = collect_all("webview")

# ⚠️ 手写识别那套 —— **必须显式收**，两个原因：
#   ① `winrt` 是**命名空间包**（没有 __init__.py），静态扫描容易漏；
#   ② 全是**延迟 import**（canvas_server.py 里 `import handwriting`、
#      handwriting.py 里 `from winrt... import`）—— PyInstaller 看不见函数体内的 import。
#   不写这几行，打包后不会报错，只是**识别静默失效**（最难查的那种）。
rt_datas, rt_binaries, rt_hidden = collect_all("winrt")

# ⚠️ PIL（框选用的截图 / 裁剪）—— **同一个坑的第二例**，2026-10-08 在跑着的 exe 里实测踩到：
#    框选那套搬到 addons/canvas/canvas_server.py 之后，是**函数体内**的
#    `from PIL import ImageGrab`，PyInstaller 看不见 ⇒ PIL 被静默丢出 bundle ⇒
#    点「框选」直接回 {"ok": false, "err": "No module named 'PIL'"}（HTTP 500）。
#    **凡是搬到 addons/ 里的依赖，都得在这里显式收一遍**（winrt 那次也是）。
pil_datas, pil_binaries, pil_hidden = collect_all("PIL")

a = Analysis(
    ["app.py"],
    pathex=[],                      # 空 = 用当前目录（原来写死了绝对路径）
    binaries=wv_binaries + rt_binaries + pil_binaries,
    datas=wv_datas + rt_datas + pil_datas,
    hiddenimports=wv_hidden + rt_hidden + pil_hidden + [
        # ⚠️ 这里**不写** handwriting / canvas_server —— 它们在 addons/ 里，是外置的。
        #    写进来会试图塞进 bundle，运行时却又去 addons/ 找，两套打架。
        "winrt.windows.ui.input.inking",
        "winrt.windows.foundation",
        "winrt.windows.foundation.collections",
        "winrt.windows.storage.streams",
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=["PyQt5", "PyQt6", "PySide2", "PySide6", "gi",
              "tkinter", "matplotlib", "numpy", "pandas"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="claude-ui",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,         # 不带黑框窗口（app.py 里已处理 stdout=None 的坑）
    icon="claude-ui.ico",
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="claude-ui",
)
