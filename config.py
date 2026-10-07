#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""claude-ui 的配置 —— **全部可选，不写就自动探测**。

找配置文件的顺序（第一个找到的算）：
  1. 环境变量 `CLAUDE_UI_CONFIG` 指的路径
  2. `server.py` / exe 旁边的 `claude-ui.config.json`
  3. 用户主目录下的 `.claude-ui.json`

能写哪些字段（JSON 里不能写注释，说明见 README）：

    {
      "cc_exe":     "claude 可执行文件的全路径",
      "cc_cwd":     "Claude Code 的工作目录",
      "cc_resume":  "要接的会话 id（留空 = 开新会话）",
      "cite":       true,
      "host":       "127.0.0.1",
      "port":       8765,
      "memory_dir": "记忆库目录（收尾动作往这儿写）",
      "window":     { "width": 1420, "height": 840, "x": null, "y": null }
    }
"""
import json
import os
import shutil
import sys


def _root():
    """静态文件（index.html）所在的目录。
    没打包 = 本文件旁边；打包成 exe 后 = **exe 旁边**
    （__file__ 那时指向 PyInstaller 的解包目录，不能用）。"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


ROOT = _root()


def _load_file():
    cands = []
    env = os.environ.get("CLAUDE_UI_CONFIG")
    if env:
        cands.append(env)
    cands.append(os.path.join(ROOT, "claude-ui.config.json"))
    cands.append(os.path.join(os.path.expanduser("~"), ".claude-ui.json"))
    for p in cands:
        try:
            if os.path.isfile(p):
                with open(p, encoding="utf-8") as f:
                    d = json.load(f)
                if isinstance(d, dict):
                    d["_from"] = p
                    return d
        except Exception:
            pass                     # 配置坏了就当没写，别让整个程序起不来
    return {}


def find_cc_exe():
    """找一个能用的 claude 可执行文件。找不到返回 None（由调用方给提示）。"""
    # 1) PATH 里（官方安装器和 npm 都会把自己加进去）
    for name in ("claude.exe", "claude.cmd", "claude"):
        p = shutil.which(name)
        if p:
            return p
    # 2) 官方安装器的默认落点
    la = os.environ.get("LOCALAPPDATA")
    if la:
        p = os.path.join(la, "Programs", "claude", "claude.exe")
        if os.path.isfile(p):
            return p
    # 3) npm 全局 / 用户级安装
    for base in (os.environ.get("APPDATA"), os.path.expanduser("~")):
        if not base:
            continue
        for parts in (("npm", "claude.cmd"), ("npm", "claude"),
                      (".local", "bin", "claude"), (".local", "bin", "claude.exe")):
            p = os.path.join(base, *parts)
            if os.path.isfile(p):
                return p
    return None


def guess_memory_dir(cwd):
    """按 CC 的规则推记忆库位置：`~/.claude/projects/<cwd 里的符号全换成 - >/memory`。
    例：C:\\Users\\me  →  C--Users-me"""
    esc = "".join(c if (c.isalnum() or c == "-") else "-" for c in cwd)
    return os.path.join(os.path.expanduser("~"), ".claude", "projects", esc, "memory")


_cfg = _load_file()

# ── 下面这些就是全项目唯一该读配置的地方 ──────────────────────────
CONFIG_FROM = _cfg.get("_from", "")                    # 空 = 没配置文件，全走默认
CC_EXE      = _cfg.get("cc_exe") or find_cc_exe()
CC_CWD      = _cfg.get("cc_cwd") or os.path.expanduser("~")
CC_RESUME   = os.environ.get("CC_UI_RESUME", "") or _cfg.get("cc_resume", "")
CITE        = bool(_cfg.get("cite", True)) and not os.environ.get("CC_UI_NO_CITE")
HOST        = _cfg.get("host", "127.0.0.1")
PORT        = int(_cfg.get("port", 8765))
MEMORY_DIR  = _cfg.get("memory_dir") or guess_memory_dir(CC_CWD)
WINDOW      = _cfg.get("window") or {}


def cc_missing_hint():
    """CC 找不到时给一句人能看懂的话（而不是让它抛异常）。"""
    return (
        "找不到 Claude Code 可执行文件。\n"
        "  它一般装在 %LOCALAPPDATA%\\Programs\\claude\\claude.exe，\n"
        "  或者你可以在 claude-ui.config.json 里写死：\n"
        '      { "cc_exe": "C:\\\\完整\\\\路径\\\\claude.exe" }\n'
        "  下载：https://claude.ai/code"
    )
