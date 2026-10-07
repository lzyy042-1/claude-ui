#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""claude-ui 的桌面壳。

把现有的本地服务（server.py）丢进子线程，主线程交给 pywebview 开原生窗口
（Windows 上走 WebView2 / Chromium 内核）。窗口加载的还是
http://127.0.0.1:8765/ —— 所以 index.html 一行都不用改。

跟 launch.vbs 的区别：那个是借 Edge 开个窗口，这个是自己的窗口。
好处是 Python 侧能摸到浏览器摸不到的东西（比如拖拽文件的完整路径）。

跑法:
    python app.py
"""
import json
import os
import sys
import threading
import time

import webview
from webview.dom import DOMEventHandler

import server  # 复用 server.py 里的 Server / Handler / HOST / PORT
import config  # 窗口尺寸这类"可以改的东西"（见 config.py）


# 注：DPI 感知**不用自己设** —— pywebview 起窗口时已经设成 PER_MONITOR_AWARE
# （2026-10-07 用 GetProcessDpiAwareness 实测回 2）。但那只改进程的坐标含义，
# **不改 create_window 收的参数**：那套 width/height/x/y 它一律当逻辑像素再乘一次
# 系统缩放 —— 这才是窗口跑到屏幕外的根因。详见 _fit_window。


def _fix_headless_streams():
    """打包后的 exe 没有控制台，print 出来的东西**哪儿也去不了** ——
    接到 exe 旁边的 claude-ui.log 上，出了事至少能翻。

    ⚠️ 2026-10-07 实测推翻旧写法：原来靠 `sys.stdout is None` 判断要不要接，
    结果日志文件**从来没生成过**。原因：**PyInstaller 6.x 的 --windowed 下
    sys.stdout 不是 None**（是个有效的 TextIOWrapper，只是背后没有控制台），
    所以那句判断每次都提前 return。老版本 PyInstaller 才给 None。
    判据改成「是不是冻结的」——这也正是我们真正关心的那件事。"""
    if not getattr(sys, "frozen", False):
        return                       # 开发模式：输出留在终端里，看得见
    try:
        base = os.path.dirname(os.path.abspath(sys.executable))
        f = open(os.path.join(base, "claude-ui.log"), "w",
                 encoding="utf-8", buffering=1)
    except Exception:
        return                       # 开不了就算了，别为了日志把程序搞崩
    sys.stdout = sys.stderr = f


_fix_headless_streams()

# 默认跟现有服务同一个端口；设 CC_UI_PORT 可以换个端口单跑（不打扰正开着的那个）
PORT = int(os.environ.get("CC_UI_PORT", server.PORT))


def _serve(ready):
    """在子线程里把 HTTP 服务跑起来 —— webview.start() 会阻塞主线程，必须让位。"""
    try:
        srv = server.Server((server.HOST, PORT), server.Handler)
    except OSError as e:
        # 端口已被占：多半是 launch.vbs 那个还开着。让窗口直接连过去就是了。
        print("[app] 端口 %d 已被占用，直接连现有服务：%s" % (PORT, e))
        ready.set()
        return
    ready.set()
    srv.serve_forever()


def _shutdown_cc():
    """窗口关掉之后，把那个常驻的 CC 子进程一起收掉。

    不收的话它会变成孤儿进程赖在后台 —— 这是最容易留下垃圾的地方。
    （Python 里的子进程不会随父进程自动死。）
    """
    p = server._cc.get("proc")
    if p and p.poll() is None:
        try:
            p.terminate()
            print("[app] CC 子进程已收掉")
        except Exception as e:
            print("[app] 收 CC 子进程失败:", e)


_MIC_BRIDGE_DONE = False


def _install_mic_bridge(window):
    """放行 WebView2 的麦克风权限请求 —— 语音识别靠它才能起来。

    为什么非做不可：WebView2 宿主如果不处理 CoreWebView2.PermissionRequested，
    页面的 getUserMedia promise 会**永远挂着**（既不 resolve 也不 reject）——
    前端看起来就是"点了没反应"。pywebview 的 winforms 后端一行权限代码都没有
    （Qt 后端有，Windows 这边没有），所以只能宿主自己挂。

    两个硬约束，都踩过：
      1. CoreWebView2 是 thread-affine 的，**必须在 UI 线程上访问** —— 后台线程
         读它的属性直接抛异常，所以走 native.Invoke。
      2. 要等 CoreWebView2 就绪；挂在窗口的 loaded 事件上时它一定已经好了。
    """
    try:
        import System
        from System import Action
    except Exception as e:                       # 拿不到 .NET，语音就用不了，但别影响别的
        print("[app] 麦克风权限桥跳过（.NET 不可用）:", e)
        return

    def work():                                  # ← 这个函数跑在 UI 线程
        global _MIC_BRIDGE_DONE
        if _MIC_BRIDGE_DONE:                     # loaded 每次导航都会触发，只装一次
            return
        _MIC_BRIDGE_DONE = True
        try:
            wv = window.native.webview
            core = None
            for _ in range(80):
                try:
                    core = wv.CoreWebView2
                    if core is not None:
                        break
                except Exception:
                    core = None
                time.sleep(0.1)
            if core is None:
                print("[app] 麦克风权限桥失败：CoreWebView2 没就绪")
                return

            def on_permission(sender, args):
                try:
                    args.State = System.Enum.Parse(args.State.GetType(), "Allow")
                    print("[app] 权限已放行:", args.PermissionKind)
                except Exception as e:
                    print("[app] 权限桥回调报错:", e)

            core.PermissionRequested += on_permission
            print("[app] 麦克风权限桥已装")
        except Exception as e:
            print("[app] 麦克风权限桥失败:", e)

    try:
        window.native.Invoke(Action(work))
    except Exception as e:
        print("[app] 麦克风权限桥 Invoke 失败:", e)


_FITTED = False


def _fit_window(win):
    """兜底：万一窗口还是伸到屏幕外，用 Win32 直接夹回来。

    ⚠️ 2026-10-07 实测（三条，别再踩）：
      · pywebview 把 `create_window` 的 width/height/x/y **一律当逻辑像素**，
        再乘一次系统缩放（本机 125%）。所以请求 1500×950 真正落地是 1875×1187，
        加上默认层叠位置 (192,192) ⇒ 窗口矩形 192,192 → 2067,1379，而屏幕只有
        1920×1200：**右下角那两个收尾按钮整片悬在屏幕外，鼠标永远点不到。**
      · 也不能用 `win.resize()` 补救 —— 它和 `webview.screens` 不是同一套单位
        （实测 resize(1804,1080) 反而变成 1942×1222，更大了）。
      · 这个进程是 PER_MONITOR_AWARE（`GetProcessDpiAwareness` 回 2，量过），
        所以 SetWindowPos 收的就是**物理**像素，跟 GetSystemMetrics 同一套。

    正常路径（create_window 里尺寸已经给对）下这里什么都不做，只留一道闸。
    """
    global _FITTED
    if _FITTED:                      # loaded 每次导航都会触发，只夹第一次
        return
    _FITTED = True
    try:
        import ctypes
        import ctypes.wintypes as WT
        u = ctypes.windll.user32
        hwnd = int(win.native.Handle.ToInt64())
        r = WT.RECT()
        if not u.GetWindowRect(hwnd, ctypes.byref(r)):
            return
        wa = WT.RECT()
        u.SystemParametersInfoW(0x0030, 0, ctypes.byref(wa), 0)     # SPI_GETWORKAREA
        pw, ph, px, py = r.right - r.left, r.bottom - r.top, r.left, r.top
        mw, mh = wa.right - wa.left, wa.bottom - wa.top
        nw, nh = min(pw, mw - 40), min(ph, mh - 40)
        nx = min(max(px, 10), max(10, mw - nw - 10))
        ny = min(max(py, 4), max(4, mh - nh - 4))
        if (nw, nh, nx, ny) != (pw, ph, px, py):
            u.SetWindowPos(hwnd, 0, nx, ny, nw, nh, 0x0004)          # SWP_NOZORDER
            print("[app] 窗口伸到屏幕外，夹回 → %dx%d @ (%d,%d)（原 %dx%d @ (%d,%d)）"
                  % (nw, nh, nx, ny, pw, ph, px, py), flush=True)
        else:
            print("[app] 窗口已在工作区内: %dx%d @ (%d,%d)" % (pw, ph, px, py), flush=True)
    except Exception as e:
        print("[app] 窗口夹取跳过:", e, flush=True)


def _bind(window):
    """窗口起来之后才绑 DOM 事件。

    这里就是换壳的意义所在：拖进来的文件，**完整路径只有 Python 这边拿得到**
    （浏览器出于安全只给文件名）。字段在 pywebview 5.0 起提供。
    """

    def _noop(e):
        return None

    def on_drop(e):
        # 字段名见过两种写法：官方 FAQ 用 dataTransfer，DOM 文档页写 domTransfer —— 都试
        dt = e.get("dataTransfer") or e.get("domTransfer") or {}
        files = dt.get("files") or []
        paths = [f["pywebviewFullPath"] for f in files
                 if isinstance(f, dict) and f.get("pywebviewFullPath")]
        print("[app] drop ->", paths)
        if not paths:
            return
        # 交给前端的附件卡片（2026-10-08 起：拖进来的文件显示成"它本来的样子"，
        # 不再往输入框里堆一串路径）。路径在发送时才接进消息正文。
        # ⚠️ 别改回"直接写 textarea" —— 那样框里既有一串路径又有一张卡片，两套说法。
        js = ("(function(){var f=window.__attach;if(!f)return;%s})();"
              % "".join("f(%s);" % json.dumps(p) for p in paths))
        try:
            window.evaluate_js(js)
        except Exception as ex:
            print("[app] evaluate_js 失败:", ex)

    # dragenter / dragover 必须 prevent_default，否则 WebView 可能压根不触发 drop
    window.dom.document.events.dragenter += DOMEventHandler(_noop, True, True)
    window.dom.document.events.dragover += DOMEventHandler(_noop, True, True, debounce=500)
    window.dom.document.events.drop += DOMEventHandler(on_drop, True, True)
    print("[app] drop 事件已绑定")


def main():
    ready = threading.Event()
    threading.Thread(target=_serve, args=(ready,), daemon=True).start()
    ready.wait(timeout=10)          # 等端口真的监听起来，不然窗口会白屏

    _w = config.WINDOW or {}        # 尺寸/位置可以从 claude-ui.config.json 改
    win = webview.create_window(
        "CLAUDE // CONSOLE",
        "http://%s:%d/" % (server.HOST, PORT),
        width=int(_w.get("width") or 1420),
        height=int(_w.get("height") or 840),
        x=_w.get("x", 16),          # 不写就用 16（避开左上角）；写 null 交给系统层叠
        y=_w.get("y", 8),
        text_select=True,           # 让界面里的字能选中复制
    )
    # 框选截图前把自己的窗口藏起来 —— 不然截到的是"软件自己挡住的桌面"。
    # 用 hide/show 而不是 minimize/restore：后者会把最大化的窗口还原成普通大小。
    # ⚠️ 这个开关现在住在画布模块里（它才是截图的那个）；没装画布就无处可设。
    if getattr(server, "canvas", None):
        server.canvas.WINDOW_HIDE = (win.hide, win.show)

    def _on_loaded():
        _fit_window(win)                # 夹进屏幕内（否则右下角的收尾按钮在屏幕外）
        _install_mic_bridge(win)        # 页面加载完 → 装麦克风权限桥
    win.events.loaded += _on_loaded
    webview.start(_bind, win)       # 阻塞，直到最后一个窗口被关掉
    _shutdown_cc()
    print("[app] 窗口已关，退出")


if __name__ == "__main__":
    main()
