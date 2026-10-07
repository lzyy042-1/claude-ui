#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""claude-ui 的「画布」附加模块 —— 后端那一半。

从 server.py 里整块搬出来的（截图/裁剪、画布状态、给 AI 的那句指针），
逻辑没改，只把"本体全局"换成了自己从 config 算。

它自己管：
  · 框选截图（PIL ImageGrab）和裁剪
  · canvas.json / canvas-files/ 的读写
  · 手写识别（同目录的 handwriting.py，走 Windows 自带 InkAnalyzer）
  · 把画布当**数据**报给 AI（精简版：包围盒 + 抽稀折线，不是截图）

对外只有几个函数：_grab_screen / _crop_shot / _canvas_load / _canvas_save /
_canvas_brief / _canvas_banner，以及 SHOT_DIR / CANVAS_FILES / WINDOW_HIDE。
"""
import json
import os
import shutil
import time

import config          # 所有"可以改的东西"都在那儿

# ─────────────────────────────────────────────────────────────
# 框选：截图 → 前端拖框 → 裁 → 递路径
#   ⚠️ 网页自己截不了屏（浏览器安全边界），截图只能在这边做。
# ─────────────────────────────────────────────────────────────
SHOT_DIR = os.path.join(os.environ.get("TEMP", config.CC_CWD), "claude-ui-shots")

# app.py 会把它设成「(最小化, 还原)」两个函数 —— 截图前先把窗口缩下去，
# 否则截出来的是"软件自己挡住的桌面"，框选就白框了。
# 单独跑 server.py 时留空：照样能截，只是窗口不闪。
WINDOW_HIDE = None

_SHOT_KEEP = 30          # 只留最近这么多张，别把临时目录堆成垃圾场


def _ensure_dpi_aware():
    """不设这个，GDI 抓屏拿到的是缩放后的图（本机 125% ⇒ 坐标全错）。
    进程已经设过（pywebview 会设）时这里返回失败，不影响 —— 那就已经是对的了。"""
    try:
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(2)      # PER_MONITOR_AWARE
    except Exception:
        try:
            import ctypes
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def _grab_screen():
    """全屏截图，存成 PNG，返回 (文件名, 宽, 高)。"""
    from PIL import ImageGrab
    _ensure_dpi_aware()
    hide, show = (WINDOW_HIDE or (None, None))
    if hide:
        try:
            hide()
            time.sleep(0.45)          # 等窗口真的缩下去，不然截到一半
        except Exception:
            pass
    try:
        img = ImageGrab.grab(all_screens=True)
    finally:
        if show:
            try:
                show()
            except Exception:
                pass
    os.makedirs(SHOT_DIR, exist_ok=True)
    name = "shot-%d.png" % int(time.time() * 1000)
    img.save(os.path.join(SHOT_DIR, name), "PNG")
    _prune_shots()
    return name, img.width, img.height


def _prune_shots():
    try:
        files = sorted(
            (f for f in os.listdir(SHOT_DIR) if f.endswith(".png")),
            key=lambda f: os.path.getmtime(os.path.join(SHOT_DIR, f)))
        for f in files[:-_SHOT_KEEP]:
            os.remove(os.path.join(SHOT_DIR, f))
    except Exception:
        pass


def _crop_shot(src, x, y, w, h):
    """按前端框出来的矩形裁一刀，返回新文件的绝对路径（给 CC 用的就是它）。"""
    from PIL import Image
    safe = os.path.basename(src)                       # 防 ../ 穿越
    p = os.path.join(SHOT_DIR, safe)
    if not os.path.isfile(p):
        raise FileNotFoundError(safe)
    im = Image.open(p)
    box = (max(0, int(x)), max(0, int(y)),
           min(im.width, int(x + w)), min(im.height, int(y + h)))
    if box[2] - box[0] < 2 or box[3] - box[1] < 2:
        raise ValueError("框太小了")
    out = "crop-%d.png" % int(time.time() * 1000)
    cut = im.crop(box)
    cut.save(os.path.join(SHOT_DIR, out), "PNG")
    # 同时返回绝对路径（给 CC 用）和 URL（给画布当图源用）——
    # 两条路走的是同一个文件，不会出现"画布上看到的和交出去的不是一张"
    return os.path.join(SHOT_DIR, out), out, cut.width, cut.height


# ─────────────────────────────────────────────────────────────
# 画布状态
#
# 这里就是「AI 用不着截图也能看见界面」那条路的落点：
# 前端把画布**当数据**报上来（不是位图），后端存下来，
# CC 想看的时候自己 curl 一下就拿到的坐标和形状 —— 不用视觉、不用 UI 树。
#
# 两个版本，别混：
#   · **完整版**（`?full=1`）= 笔迹的原始点 + 图片对象 —— 只给前端自己恢复用
#   · **精简版**（默认）    = 包围盒 + 抽稀到 12 个点的折线 —— 这才是给 AI 看的，
#                            烧 token 少，而且给的是**事实**不是估计
# ─────────────────────────────────────────────────────────────
CANVAS_FILE = os.path.join(config.ROOT, "canvas.json")
CANVAS_FILES = os.path.join(config.ROOT, "canvas-files")
_canvas = {"state": None, "rev": 0, "told": -1,
           "txt": None, "txt_rev": -1}   # txt = 手写认出来的文字（按 rev 缓存）


def _canvas_adopt_files(state):
    """画布上的图得活得比 %TEMP% 久。

    截图的原图存在 `%TEMP%\\claude-ui-shots\\`，那边只留最近 30 张会被清掉 ——
    一旦被清，画布上就是个裂图。所以搬一份到 exe 隔壁的 `canvas-files/`，
    对象里的 path 指向新家（这个路径也是以后丢给 CC 读的那个）。"""
    os.makedirs(CANVAS_FILES, exist_ok=True)
    for ob in state.get("objects", []):
        src = ob.get("path") or ""
        if not src or not os.path.isfile(src):
            continue
        try:
            if os.path.dirname(os.path.abspath(src)) == os.path.abspath(CANVAS_FILES):
                continue
            dst = os.path.join(CANVAS_FILES, os.path.basename(src))
            if not os.path.isfile(dst):
                shutil.copy2(src, dst)
            ob["path"] = dst
            ob["url"] = "/canvas-file/" + os.path.basename(dst)
        except Exception as e:
            print("[server] 画布取图失败:", e)


def _canvas_save(state):
    _canvas_adopt_files(state)
    _canvas["state"] = state
    _canvas["rev"] += 1
    try:
        with open(CANVAS_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False)
    except Exception as e:
        print("[server] 画布存盘失败:", e)
    return _canvas["rev"]


def _canvas_load():
    if _canvas["state"] is None:
        try:
            with open(CANVAS_FILE, encoding="utf-8") as f:
                _canvas["state"] = json.load(f)
        except Exception:
            _canvas["state"] = None
    return _canvas["state"]


def _canvas_text():
    """把画布上的手写认成文字。**按 rev 缓存** —— 画布没变就不重认。

    走 Windows 自带的 WinRT 墨迹识别（见 handwriting.py）。本地、离线、免费。
    ⚠️ 这条通了之后，设计文档里「手写还是位图 ⇒ 还得走截图」那句就作废了 ——
       手写也变成文本进结构，跟图形/符号同一条路。
    """
    st = _canvas_load()
    if not st:
        return []
    if _canvas.get("txt_rev") == _canvas["rev"] and _canvas.get("txt") is not None:
        return _canvas["txt"]
    try:
        import handwriting
        txt = handwriting.recognize(st.get("strokes") or [])
    except Exception as e:
        print("[server] 手写识别挂了:", type(e).__name__, e)
        txt = []
    _canvas["txt"] = txt
    _canvas["txt_rev"] = _canvas["rev"]
    if txt:
        print("[server] 认出 %d 行：%s" % (len(txt), " / ".join(t["text"] for t in txt)))
    return txt


def _canvas_brief():
    """给 AI 看的那一版：只要"什么在哪"，不要原始数据。"""
    st = _canvas_load()
    if not st:
        return None
    strokes, objects = st.get("strokes") or [], st.get("objects") or []
    if not strokes and not objects:
        return None
    out = {"canvas": st.get("size"), "strokes": [], "objects": []}
    for s in strokes:
        pts = s.get("pts") or []
        if not pts:
            continue
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        n = len(pts)
        step = max(1, n // 12)                       # 抽稀：最多 ~12 个点
        simp = [[round(pts[i][0]), round(pts[i][1])] for i in range(0, n, step)]
        last = [round(pts[-1][0]), round(pts[-1][1])]
        if simp[-1] != last:
            simp.append(last)
        out["strokes"].append({
            "bbox": [round(min(xs)), round(min(ys)), round(max(xs)), round(max(ys))],
            "points": n,
            "path_xy": simp,
        })
    for o in objects:
        out["objects"].append({
            "image": o.get("path"),
            "x": round(o.get("x", 0)), "y": round(o.get("y", 0)),
            "w": round(o.get("w", 0)), "h": round(o.get("h", 0)),
        })
    # 手写认出来的字。带上第二三候选 —— 手写识别会有认错的时候，
    # 让 AI 知道"还有别的可能"，比只给一个笃定的答案安全。
    txt = _canvas_text()
    if txt:
        out["text"] = [{"t": t["text"], "alt": t["cand"][1:], "box": t["bbox"]}
                       for t in txt]
    return out


def _canvas_banner(port):
    """挂在用户消息后面的**一句指针**，不是把画布整个推过去。

    跟「气泡是指针/门牌，不是内容」是同一个道理：告诉它画布上有东西、
    在哪儿能拿到，要不要看它自己决定。"""
    b = _canvas_brief()
    if not b:
        return ""
    bits = []
    if b["strokes"]:
        bits.append("%d 笔手写" % len(b["strokes"]))
    if b["objects"]:
        bits.append("%d 个图片对象" % len(b["objects"]))
    line = "\n\n[画布] 画布上有 " + "、".join(bits) + "。"
    # 认出来的字直接带上 —— 文本很便宜，而且这正是他写在画布上的原话。
    # 形状和坐标那些"要说清才说得清"的东西仍然只给指针，让它自己去拉。
    if b.get("text"):
        line += "认出来的文字：" + " / ".join(t["t"] for t in b["text"]) + "。"
    line += "要看每笔的坐标和形状：curl -s http://127.0.0.1:%d/api/canvas" % port
    return line
