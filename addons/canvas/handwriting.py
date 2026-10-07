#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""手写识别 —— 把画布上的笔迹坐标认成文字。

走 **Windows 自带的 WinRT 墨迹识别**（本机识别器名：`Microsoft 中文(简体)手写识别器`）。
本地、离线、免费、不调模型、不用联网、不用截图。

为什么这件事重要（2026-10-07 定的）：
    设计文档里原本写「手写/涂鸦还是位图 ⇒ 还得走截图」，**那条作废**。
    手写变成文本之后也走结构 ⇒ 跟图形/符号同一条路，便宜几十倍，还能命中缓存。
    那句「读结构模型不用『看』」—— 现在连"字是什么"都进数据了。

⚠️ 实测（2026-10-07，用**程序画的直线**测的，一点不像手写）：
    一 → 一 / 十 → 十 / 二 → 二 / 三 → 三   （第一候选全对）
    口 → 刁（这个不对）
    真手写只会更准，但**他的连笔潦草程度没测过**。

⚠️ 本机只有**一个**识别器（中文简体）。中英数字混写一整句会怎么样，没测。
"""

import threading

_lock = threading.Lock()
_state = {"checked": False, "ok": False, "err": None, "name": None}
# ⚠️ **必须留着这个容器**。踩过的坑（2026-10-07）：
#    探测时写成 `recs = InkRecognizerContainer().get_recognizers()` —— 容器是临时对象，
#    函数一返回就被回收了。**之后任何识别都会永久挂住**（进程不崩、不给栈，就是不返回）。
#    在别的脚本里显式命名再 del 就没事 ⇒ 差别在"临时对象立刻析构"。
#    所以这里把它存进模块级变量，活到进程结束。
_keep = {}


def available():
    """能不能用。不可用时返回 False，调用方照常跑（识别只是锦上添花，不该拖垮画布）。"""
    if _state["checked"]:
        return _state["ok"]
    _state["checked"] = True
    try:
        from winrt.windows.ui.input.inking import InkRecognizerContainer
        c = InkRecognizerContainer()          # ← 命名，别写成临时对象（见 _keep 上面的注释）
        _keep["container"] = c
        recs = c.get_recognizers()
        _keep["recognizers"] = recs
        if len(recs) == 0:
            _state["err"] = "系统里没有装任何手写识别器"
            return False
        _state["name"] = recs[0].name
        _state["ok"] = True
    except Exception as e:
        _state["err"] = "%s: %s" % (type(e).__name__, e)
    return _state["ok"]


def info():
    available()
    return {"ok": _state["ok"], "recognizer": _state["name"], "err": _state["err"]}


def recognize(strokes, timeout=8):
    """笔迹 → 文字。**带超时护栏**。

    入参 strokes: [{"pts": [[x, y], ...]}, ...]（画布坐标，单位 px）
    返回           [{"text": "第一候选", "cand": [前三候选], "bbox": [x, y, w, h]}, ...]

    ⚠️ 为什么非要套一层线程：这套 WinRT API **会静默挂死**（进程不崩、不给栈、
       就是不返回）。在服务器里挂死等于占住一个请求线程，所以：
       跑在守护线程里、等 timeout 秒，超时就把识别整个关掉，别再拖累画布。
       （跑飞的线程会泄漏，但那时识别已经停用，不会再起新的。）
    """
    if not available():
        return []
    box = {}
    t = threading.Thread(target=lambda: box.update(out=_recognize_inner(strokes)),
                         daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        _state["ok"] = False
        _state["err"] = "识别超时挂死，已停用"
        print("[handwriting] 识别超过 %ss 没返回，停用识别" % timeout)
        return []
    return box.get("out") or []


def _recognize_inner(strokes):
    if not available():
        return []
    from winrt.windows.ui.input.inking import (
        InkRecognizerContainer, InkStrokeBuilder, InkStrokeContainer, InkRecognitionTarget)
    from winrt.windows.foundation import Point

    builder = InkStrokeBuilder()
    box = InkStrokeContainer()
    n = 0
    for s in strokes or []:
        pts = s.get("pts") or []
        if len(pts) < 2:
            continue                       # 单点画不出线，识别器也不要
        try:
            box.add_stroke(builder.create_stroke(
                [Point(float(p[0]), float(p[1])) for p in pts]))
            n += 1
        except Exception:
            continue
    if n == 0:
        return []

    try:
        with _lock:                        # WinRT 这套东西不保证线程安全，串起来
            c = _keep.get("container") or InkRecognizerContainer()
            _keep["container"] = c         # 见文件上方 _keep 的注释：别让它成临时对象
            op = c.recognize_async(box, InkRecognitionTarget.ALL)
            res = op.get()                 # ⚠️ op 和 c 都必须活着跨过这一行
    except Exception as e:
        print("[handwriting] 识别失败:", type(e).__name__, e)
        return []

    out = []
    for r in res:
        try:
            cands = list(r.get_text_candidates())
        except Exception:
            continue
        if not cands:
            continue
        b = r.bounding_rect
        out.append({
            "text": cands[0],
            "cand": cands[:3],
            "bbox": [round(b.x), round(b.y), round(b.width), round(b.height)],
        })
    return out


if __name__ == "__main__":
    # 自测：程序画几笔，看认成什么
    import sys
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print("识别器:", info())

    def line(x0, y0, x1, y1, n=12):
        return [[x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n] for i in range(n + 1)]

    cases = {
        "一": [line(40, 100, 200, 100)],
        "十": [line(40, 110, 200, 110), line(120, 30, 120, 195)],
        "二": [line(50, 80, 190, 80), line(40, 150, 200, 150)],
        "三": [line(50, 70, 190, 70), line(60, 125, 180, 125), line(40, 180, 200, 180)],
    }
    for name, st in cases.items():
        got = recognize([{"pts": p} for p in st])
        print("  %-4s → %s" % (name, [g["text"] for g in got]))
