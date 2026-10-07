#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""claude-ui 的本地数据服务。

只干两件事：
  1. serve 本目录的静态文件 —— 这样 index.html 从 http://127.0.0.1:8765 打开，
     跟 /api/* 同源，fetch 不会被 CORS 挡（file:// 下会被挡）。
  2. GET /api/hardware → 硬件实时数据。

跑法:
    python server.py
    然后浏览器开 http://127.0.0.1:8765/
"""
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

import psutil

import config                       # 所有"可以改的东西"都在那儿（见 config.py）

# ── 文件类型图标（/file-icon/）────────────────────────────────
# 拖进来的文件要在底栏显示成"它本来的样子"（Word 就 Word 的图标）。详见 shellicon.py。
try:
    import shellicon
except Exception as _e:                       # 装坏了也别拖垮本体，前端会退回色块
    print("[server] 文件图标模块加载失败：%s" % _e)
    shellicon = None

_icon_cache = {}                    # ext -> PNG bytes（取不到时缓存 None，免得反复重试）

# ── 附加模块：画布 ────────────────────────────────────────────
# addons/canvas/ 里是一个自足的小模块（界面 + 后端 + 手写识别）。
# 目录不在就当没这回事 —— 本体照样跑，只是没有画布。
_ADDON_DIR = os.path.join(config.ROOT, "addons", "canvas")
canvas = None
if os.path.isdir(_ADDON_DIR) and os.path.isfile(os.path.join(_ADDON_DIR, "canvas_server.py")):
    sys.path.insert(0, _ADDON_DIR)
    try:
        import canvas_server as canvas            # noqa: E402
    except Exception as _e:                       # 装坏了也别拖垮本体
        print("[server] 画布模块加载失败：%s" % _e)
        canvas = None

HOST, PORT = config.HOST, config.PORT

# 静态文件（index.html）放哪 —— 没打包 = 本文件旁边；打包 = exe 旁边。
# （算法在 config.py 的 _root()，那儿注释写了为什么不能用 _MEIPASS）
ROOT = config.ROOT

# ─────────────────────────────────────────────────────────────
# UI 里那个"我"：一个常驻的 Claude Code 子进程
# ─────────────────────────────────────────────────────────────
# 这三样现在都从 config.py 来：写的就听写的，没写就自动探测
# （CC_EXE 找不到会是 None —— _cc_start 里会给一句人话，不是抛栈）
CC_EXE    = config.CC_EXE
CC_CWD    = config.CC_CWD
CC_RESUME = config.CC_RESUME

# 正文角标的"教法" —— **只加在 claude-ui 这个子进程上**，终端里那个我照旧、行为不变。
#
# 机制：前端把本回合每次工具调用按顺序编了号（index.html 的 `S.turnTools`），
# CC 只要在"有依据的那句话"末尾写一个 `[[eN]]`，前端就把它换成可点的角标。
# 难点在 CC 不知道前端的编号 —— 所以约定 N = **本回合第几次工具调用**，这个它能自己数。
#
# ⚠️ 代价（知情的）：改了 system prompt ⇒ **缓存前缀打掉一次**，新会话第一轮全价。
#    关掉它：config 里写 `"cite": false`，或把环境变量 CC_UI_NO_CITE 设成任意值。
CITE_PROMPT = "" if not config.CITE else (
    "【依据角标】你的回复显示在一个带「过程流」侧栏的界面里：你这一回合每调用一次工具，"
    "侧栏就按顺序留一条记录。当某句结论**直接来自**你刚做的某次工具调用时，"
    "在那句话末尾写一个标记 [[eN]]，N 是本回合第几次工具调用（从 1 开始数）。"
    "只在真有依据的地方写，没工具依据的句子不写，不要每句都写。"
)

_cc = {"proc": None, "lock": threading.Lock(), "subs": [], "init": None,
       "after": None, "after_timer": None, "used": False}


def _cc_start():
    """起（或复用）那个常驻 CC。stdin 喂 stream-json，stdout 收 stream-json。"""
    if _cc["proc"] and _cc["proc"].poll() is None:
        return
    if not CC_EXE:
        # 找不到 claude.exe —— 报一句人话，别让用户面对一个栈
        raise RuntimeError(config.cc_missing_hint())
    _cc["used"] = False          # 新进程 = 干净会话，还没被真正用过
    args = [CC_EXE, "-p",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose"]
    if CITE_PROMPT:
        args += ["--append-system-prompt", CITE_PROMPT]
    if CC_RESUME:
        args += ["--resume", CC_RESUME]
    p = subprocess.Popen(
        args, cwd=CC_CWD,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
        creationflags=_CREATE_NO_WINDOW)
    _cc["proc"] = p
    threading.Thread(target=_cc_reader, args=(p,), daemon=True).start()


def _cc_broadcast(line):
    """把一行事件推给所有挂着的前端。"""
    for q in list(_cc["subs"]):
        try:
            q.put_nowait(line)
        except Exception:
            pass


def _cc_reader(p):
    """把子进程 stdout 的每一行广播给所有挂着的前端。"""
    for line in p.stdout:
        line = line.strip()
        if not line:
            continue
        # init 只发一次，后连上来的页面（刷新、第二个窗口）会错过 —— 留一份补发
        if _cc["init"] is None:
            try:
                o = json.loads(line)
                if o.get("type") == "system" and o.get("subtype") == "init":
                    _cc["init"] = line
            except Exception:
                pass
        _cc_broadcast(line)
        # 有收尾动作挂着 → 等这一轮真正跑完（result 事件）再动手。
        # 顺序是硬的：记忆没写完就关，这段上下文就白丢了。
        if _cc.get("after"):
            try:
                o = json.loads(line)
            except Exception:
                o = None
            if o and o.get("type") == "result":
                act = _cc["after"]
                _cc["after"] = None
                threading.Thread(target=_finish, args=(act,), daemon=True).start()


def cc_send(text, kind="user"):
    _cc_start()
    if kind == "user":
        _cc["used"] = True       # 这个会话真的被用过（收尾指令不算）
    msg = json.dumps(
        {"type": "user",
         "message": {"role": "user", "content": [{"type": "text", "text": text}]}},
        ensure_ascii=False)
    with _cc["lock"]:
        _cc["proc"].stdin.write(msg + "\n")
        _cc["proc"].stdin.flush()

def cc_interrupt():
    """中断当前正在跑的回合（等价终端里按 Esc）。2026-10-07 实测评过帧格式：
    request_id 放顶层有效；回 control_response(still_queued)，子进程不退出。"""
    p = _cc.get("proc")
    if not p or p.poll() is not None:
        return False
    req = json.dumps({
        "type": "control_request",
        "request_id": "req_ui_%d" % int(time.time() * 1000),
        "request": {"subtype": "interrupt"},
    })
    with _cc["lock"]:
        p.stdin.write(req + "\n")
        p.stdin.flush()
    return True


FINISH_PROMPT = (
    "【收尾动作】把你刚才参与的这个对话里、值得以后记住的东西写进记忆库。\n\n"
    "1. 一条记忆 = 一个文件，用 memory\\ 里现有的 frontmatter 格式；"
    "写完在 MEMORY.md 加一行指针。\n"
    "2. 只记『以后还用得上的』：项目状态、做过的决定、踩过的坑。琐碎细节不记。\n"
    "3. 已有条目能覆盖的，改那一条，别新建重复的。\n"
    "4. 做完就停，不要做别的。最后回一句『记忆已写完』。\n\n"
    "记忆目录：" + config.MEMORY_DIR + os.sep
)


def _arm_finish(act, timeout=240):
    """挂上收尾动作 + 一个超时闸。子进程要是卡死，别让这个标记永挂 ——
    否则下一轮对话的 result 会把它误触发。"""
    _cc["after"] = act
    t = threading.Timer(timeout, _finish_timeout, args=(act,))
    t.daemon = True
    _cc["after_timer"] = t
    t.start()


def _finish_timeout(act):
    if _cc.get("after") == act:
        _cc["after"] = None
        _cc["after_timer"] = None
        _finish(act)                      # 超时也照做：用户点了按钮，不能把他卡在那


def _finish(act):
    """收尾：记忆写完之后执行 —— rest 全退，fresh 只换一个干净的新会话。"""
    t = _cc.get("after_timer")
    if t:
        t.cancel()
        _cc["after_timer"] = None
    _cc["after"] = None
    time.sleep(0.4)                       # 让最后那点输出先流出去
    p = _cc.get("proc")
    if p:
        try:
            p.terminate()
        except Exception:
            pass
    _cc["proc"] = None
    _cc["init"] = None
    _cc["used"] = False                   # 换过档了，重新算
    if act == "rest":
        _cc_broadcast(json.dumps({"type": "_ui", "event": "rest_done"}))
        time.sleep(1.2)                   # 给前端一点时间把那句话显示出来
        os._exit(0)                       # 直接退：连 server 一起关
    _cc_broadcast(json.dumps({"type": "_ui", "event": "fresh_done"}))


_CREATE_NO_WINDOW = 0x08000000
_temp_cache = {"t": 0.0, "v": None}
_net_cache = {"t": 0.0, "sent": 0, "recv": 0}


def _cpu_temp():
    """CPU 温度 —— Windows 上只能走 WMI 热区计数器（根单位是十分之一开尔文）。
    查询慢(约 300ms)，所以缓存 5 秒。读不到就返回 None，页面显示 '—'。"""
    now = time.time()
    if now - _temp_cache["t"] < 5:
        return _temp_cache["v"]
    v = None
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "(Get-CimInstance -ClassName Win32_PerfFormattedData_Counters_"
             "ThermalZoneInformation -ErrorAction SilentlyContinue | "
             "Select-Object -First 1).HighPrecisionTemperature"],
            capture_output=True, text=True, timeout=8,
            creationflags=_CREATE_NO_WINDOW)
        s = (r.stdout or "").strip()
        if s.isdigit() and int(s) > 2000:
            v = round(int(s) / 10 - 273.15, 1)
    except Exception:
        v = None
    _temp_cache["t"], _temp_cache["v"] = now, v
    return v


def _net():
    """网速(字节/秒) —— psutil 只给累计值，速率得自己按两次采样差算。"""
    now = time.time()
    c = psutil.net_io_counters()
    pt, ps, pr = _net_cache["t"], _net_cache["sent"], _net_cache["recv"]
    _net_cache.update(t=now, sent=c.bytes_sent, recv=c.bytes_recv)
    if pt == 0 or now - pt < 0.01:
        return {"down": 0, "up": 0}
    dt = now - pt
    return {
        "down": max(0, round((c.bytes_recv - pr) / dt)),
        "up": max(0, round((c.bytes_sent - ps) / dt)),
    }


def _battery():
    b = psutil.sensors_battery()
    if not b:
        return None
    secs = b.secsleft
    unknown = (psutil.POWER_TIME_UNLIMITED, psutil.POWER_TIME_UNKNOWN)
    return {
        "percent": round(b.percent, 1),
        "plugged": bool(b.power_plugged),
        "secsleft": None if secs in unknown else int(secs),
    }


def hardware():
    m = psutil.virtual_memory()
    return {
        "ts": time.time(),
        "cpu": {
            "percent": psutil.cpu_percent(interval=None),
            "cores": psutil.cpu_count(logical=False),
            "threads": psutil.cpu_count(),
            "temp": _cpu_temp(),
        },
        "mem": {
            "percent": m.percent,
            "used": round(m.used / 1024 ** 3, 1),
            "total": round(m.total / 1024 ** 3, 1),
        },
        "battery": _battery(),
        "net": _net(),
    }




class Server(ThreadingHTTPServer):
    # 端口被占就报错 —— 别让多个实例偷偷叠在同一个端口上
    # （Windows 上 allow_reuse_address=1 会让好几个进程都 bind 成功）
    allow_reuse_address = False
    daemon_threads = True


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_GET(self):
        if self.path.split("?")[0] == "/api/stream":
            # SSE：把 CC 子进程吐的每一行原样推给前端
            q = queue.Queue()
            if _cc["init"]:                  # 补发 init，刷新后也认得出是哪个 session
                q.put_nowait(_cc["init"])
            _cc["subs"].append(q)
            _cc_start()                      # 顺手把子进程拉起来
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            try:
                while True:
                    try:
                        line = q.get(timeout=15)
                        self.wfile.write(f"data: {line}\n\n".encode("utf-8"))
                        self.wfile.flush()
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")   # 心跳，防中间层掐断
                        self.wfile.flush()
            except Exception:
                pass
            finally:
                if q in _cc["subs"]:
                    _cc["subs"].remove(q)
            return
        if self.path.split("?")[0] == "/api/canvas":
            # 默认 = 给 AI 的精简版；?full=1 = 给前端恢复用的完整版
            full = "full=1" in self.path
            data = canvas._canvas_load() if full else canvas._canvas_brief()
            body = json.dumps(data if data is not None else {},
                              ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.split("?")[0].startswith("/canvas-file/"):
            name = os.path.basename(self.path.split("?")[0][len("/canvas-file/"):])
            p = os.path.join(canvas.CANVAS_FILES, name)
            if not os.path.isfile(p):
                self.send_error(404)
                return
            with open(p, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.split("?")[0].startswith("/shot/"):
            # 截图原图（给前端的框选遮罩当底图用）—— 文件在 canvas.SHOT_DIR，不在 ROOT 里
            name = os.path.basename(self.path.split("?")[0][len("/shot/"):])
            p = os.path.join(canvas.SHOT_DIR, name)
            if not os.path.isfile(p):
                self.send_error(404)
                return
            with open(p, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.split("?")[0].startswith("/file-icon/"):
            # 文件类型图标：/file-icon/docx → 系统里那个 Word 图标
            ext = os.path.basename(self.path.split("?")[0][len("/file-icon/"):])
            if ext not in _icon_cache:
                _icon_cache[ext] = shellicon.icon_png(ext) if shellicon else None
            body = _icon_cache[ext]
            if not body:
                self.send_error(404)          # 认不出来 —— 让前端退回画色块
                return
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.split("?")[0] == "/api/hardware":
            body = json.dumps(hardware(), ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] == "/api/interrupt":
            try:
                ok = cc_interrupt()
                out = json.dumps({"ok": ok,
                                  "err": None if ok else "没有正在跑的子进程"}).encode()
                self.send_response(200)
            except Exception as e:
                out = json.dumps({"ok": False, "err": str(e)}).encode()
                self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return

        if self.path.split("?")[0] == "/api/finish":
            try:
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) or b"{}"
                try:
                    body = json.loads(raw.decode("utf-8"))
                except UnicodeDecodeError:
                    body = json.loads(raw.decode("gbk", errors="replace"))
                act = str(body.get("action", ""))
                if act not in ("rest", "fresh"):
                    raise ValueError("bad action: " + act)
                if _cc["used"]:
                    _arm_finish(act)              # 先挂上再发指令，免得抢跑
                    cc_send(FINISH_PROMPT, kind="finish")
                else:
                    # 空会话：没东西可记。不发指令（免得它去翻别人的会话），直接换档。
                    threading.Thread(target=_finish, args=(act,), daemon=True).start()
                out = b'{"ok":true}'
                self.send_response(200)
            except Exception as e:
                _cc["after"] = None
                out = json.dumps({"ok": False, "err": str(e)}).encode()
                self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return

        if self.path.split("?")[0] == "/api/capture":
            try:
                name, w, h = canvas._grab_screen()
                out = json.dumps({"ok": True, "name": name,
                                  "url": "/shot/" + name,
                                  "w": w, "h": h}).encode()
                self.send_response(200)
            except Exception as e:
                out = json.dumps({"ok": False, "err": str(e)}).encode()
                self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return

        if self.path.split("?")[0] == "/api/crop":
            try:
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) or b"{}"
                try:
                    body = json.loads(raw.decode("utf-8"))
                except UnicodeDecodeError:
                    body = json.loads(raw.decode("gbk", errors="replace"))
                path, url_name, cw, ch = canvas._crop_shot(
                    body.get("name", ""), body.get("x", 0),
                    body.get("y", 0), body.get("w", 0), body.get("h", 0))
                out = json.dumps({"ok": True, "path": path, "url": "/shot/" + url_name,
                                  "w": cw, "h": ch},
                                 ensure_ascii=False).encode("utf-8")
                self.send_response(200)
            except Exception as e:
                out = json.dumps({"ok": False, "err": str(e)}, ensure_ascii=False).encode("utf-8")
                self.send_response(500)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return

        if self.path.split("?")[0] == "/api/canvas":
            try:
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) or b"{}"
                try:
                    state = json.loads(raw.decode("utf-8"))
                except UnicodeDecodeError:
                    state = json.loads(raw.decode("gbk", errors="replace"))
                rev = canvas._canvas_save(state)
                out = json.dumps({"ok": True, "rev": rev}).encode()
                self.send_response(200)
            except Exception as e:
                out = json.dumps({"ok": False, "err": str(e)}).encode()
                self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return

        if self.path.split("?")[0] == "/api/send":
            try:
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) or b"{}"
                try:
                    body = json.loads(raw.decode("utf-8"))
                except UnicodeDecodeError:
                    body = json.loads(raw.decode("gbk", errors="replace"))
                text = str(body.get("text", ""))
                # （原来这里会"替画布说话"：画布一变过，就往消息尾巴挂一句指针，
                #   告诉模型画布上有东西、去哪儿取。2026-10-08 拆掉了 ——）
                #
                #   「AI 能看见画布」是**画布自己的能力**，不是本体的职责。
                #   画布自己暴露 /api/canvas，画布界面上有个「给 AI 看」的按钮，
                #   用户把它贴给模型就行。本体从此不知道画布存在。
                cc_send(text)
                out = b'{"ok":true}'
                self.send_response(200)
            except Exception as e:
                out = json.dumps({"ok": False, "err": str(e)}).encode()
                self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return
        self.send_error(404)

    def log_message(self, *a):
        pass  # 安静点，别刷屏


if __name__ == "__main__":
    psutil.cpu_percent(interval=None)  # 预热：第一次调用必定返回 0
    try:
        srv = Server((HOST, PORT), Handler)
    except OSError:
        # 已经有一个在跑 —— 静默退出，启动器只管开窗口就是了
        sys.exit(0)
    print(f"claude-ui server -> http://{HOST}:{PORT}/")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("stopped")
