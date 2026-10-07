' claude-ui launcher -- double-click to open, no console window
'
' NOTE: keep this file pure ASCII. VBScript parses .vbs as the machine's ANSI
' codepage (GBK here); a UTF-8 file with CJK comments gets mangled and the
' parser eats the next line.
'
' This is the OLD path (Edge app window) -- kept as a fallback for when the
' packaged exe is unavailable. The normal way to run claude-ui is the exe.
'
' 1) start the local server silently (if the port is already taken the second
'    pythonw just errors out and dies -- harmless)
' 2) open an Edge "app window": no tabs, no address bar -> looks standalone
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set env = sh.Environment("PROCESS")

base = fso.GetParentFolderName(WScript.ScriptFullName)

' --- edit these two if your install lives elsewhere ---
pyw  = env("LOCALAPPDATA") & "\Programs\Python\Python312\pythonw.exe"
edge = env("ProgramFiles(x86)") & "\Microsoft\Edge\Application\msedge.exe"
' port 8765 is the default; if you changed it in claude-ui.config.json,
' change it here too
' ------------------------------------------------------

sh.Run """" & pyw & """ """ & base & "\server.py""", 0, False
WScript.Sleep 1800

sh.Run """" & edge & """ --app=http://127.0.0.1:8765/ --window-size=1500,950", 1, False
