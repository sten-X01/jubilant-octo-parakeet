#!/usr/bin/env python3
"""
Phone-friendly REAL terminal (PTY) in the browser.

- Asli bash session: nano, top, htop, pm2 logs, sab chalta hai.
- Typing ek normal text box se hoti hai, isliye Android keyboard ki
  xterm.js wali "kuch type nahi hota" problem nahi aati.
- Ctrl+C, Tab, Esc, arrows ke buttons neeche milte hain.

Login: admin / PANEL_PASS (environment variable)
Sirf standard library use hoti hai, kuch install nahi karna.
"""
import base64
import fcntl
import hmac
import os
import pty
import signal
import struct
import termios
import threading
import time
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

warnings.filterwarnings("ignore")

USER = "admin"
# Password env se le kar hata dete hain, taaki terminal ke andar `env` mein na dikhe
PASSWORD = os.environ.pop("PANEL_PASS", "")
PORT = int(os.environ.get("WEBTERM_PORT", "7681"))
MAXBUF = 400000
START_DIR = os.getcwd()
RC_FILE = "/tmp/webterm.bashrc"

RC_TEXT = r"""[ -f ~/.bashrc ] && . ~/.bashrc
export PS1='\[\e[1;32m\]VPS\[\e[0m\]:\[\e[1;34m\]\W\[\e[0m\] ❯ '
"""

cond = threading.Condition()
buf = bytearray()
base = 0  # absolute offset of buf[0]
sess = {"pid": None, "fd": None, "cols": 80, "rows": 24}
spawn_lock = threading.Lock()


def append(data):
    global base
    with cond:
        buf.extend(data)
        if len(buf) > MAXBUF:
            cut = len(buf) - MAXBUF
            del buf[:cut]
            base += cut
        cond.notify_all()


def read_from(off, wait):
    with cond:
        if off > base + len(buf):
            off = base
        if off >= base + len(buf) and wait > 0:
            cond.wait(timeout=wait)
        if off < base:
            off = base
        if off > base + len(buf):
            off = base
        chunk = bytes(buf[off - base: off - base + 200000])
        return chunk, off + len(chunk)


def set_winsize(fd, rows, cols):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def spawn():
    with spawn_lock:
        old_fd, old_pid = sess["fd"], sess["pid"]
        if old_fd is not None:
            try:
                os.close(old_fd)
            except OSError:
                pass
        if old_pid:
            try:
                os.waitpid(old_pid, os.WNOHANG)
            except OSError:
                pass
        env = dict(
            os.environ,
            TERM="xterm-256color",
            COLORTERM="truecolor",
            LANG="C.UTF-8",
            LC_ALL="C.UTF-8",
        )
        pid, fd = pty.fork()
        if pid == 0:
            try:
                # `&` / nohup se start hone par SIGINT/SIGHUP "ignore" inherit ho jaate hain,
                # tab Ctrl+C kaam nahi karta. Sab default par reset karo.
                for s in (signal.SIGINT, signal.SIGQUIT, signal.SIGHUP,
                          signal.SIGPIPE, signal.SIGTERM):
                    signal.signal(s, signal.SIG_DFL)
                os.chdir(START_DIR)
                os.execvpe("bash", ["bash", "--rcfile", RC_FILE, "-i"], env)
            finally:
                os._exit(1)
        set_winsize(fd, sess["rows"], sess["cols"])
        sess["pid"], sess["fd"] = pid, fd


def reader():
    while True:
        try:
            data = os.read(sess["fd"], 65536)
        except OSError:
            data = b""
        if not data:
            append(b"\r\n\x1b[33m[shell band ho gaya, naya shell shuru ho raha hai]\x1b[0m\r\n")
            time.sleep(0.5)
            spawn()
            continue
        append(data)


PAGE = r"""<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,interactive-widget=resizes-content">
<title>VPS Terminal</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
<style>
 html,body{height:100%;margin:0;background:#1c1c1c;color:#e6e6e6;font-family:monospace}
 #app{display:flex;flex-direction:column;height:100vh;height:100dvh}
 #term{flex:1;min-height:0;overflow:auto;padding:4px;box-sizing:border-box}
 #fb{white-space:pre-wrap;word-break:break-all;font-size:13px;margin:0}
 #keys{display:flex;gap:6px;overflow-x:auto;padding:6px;background:#111}
 #keys button{flex:0 0 auto;font-size:14px;padding:9px 12px;border:0;border-radius:8px;
   background:#3a3a3a;color:#fff;font-family:monospace}
 #keys button.on{background:#2ea043}
 #row{display:flex;gap:6px;padding:6px;background:#111}
 #cmd{flex:1;min-width:0;font-size:16px;padding:12px;background:#2b2b2b;color:#fff;
   border:1px solid #555;border-radius:8px;font-family:monospace}
 #send{font-size:15px;padding:0 16px;border:0;border-radius:8px;background:#2ea043;color:#fff;font-weight:bold}
</style></head><body>
<div id="app">
 <div id="term"></div>
 <div id="keys"></div>
 <form id="row" autocomplete="off">
  <input id="cmd" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off"
         enterkeyhint="send" placeholder="command likho, Enter dabao">
  <button id="send" type="submit">Enter</button>
 </form>
</div>
<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
<script>
(function () {
  var off = 0, ctrl = false, dec = new TextDecoder();
  var termEl = document.getElementById('term');
  var cmd = document.getElementById('cmd');
  var term = null, fit = null, fb = null;

  if (window.Terminal) {
    term = new Terminal({fontSize: 14, cursorBlink: false, disableStdin: true,
                         scrollback: 5000, theme: {background: '#1c1c1c'}});
    if (window.FitAddon) { fit = new FitAddon.FitAddon(); term.loadAddon(fit); }
    term.open(termEl);
  } else {
    fb = document.createElement('pre'); fb.id = 'fb'; termEl.appendChild(fb);
  }

  function strip(s) {
    return s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r/g, '');
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function send(s) { return fetch('/in', {method: 'POST', body: s}).catch(function () {}); }

  function doFit() {
    if (!term || !fit) return;
    try {
      fit.fit();
      fetch('/resize?cols=' + term.cols + '&rows=' + term.rows, {method: 'POST'}).catch(function () {});
    } catch (e) {}
  }
  window.addEventListener('resize', function () { setTimeout(doFit, 150); });

  var keys = [
    ['Ctrl+C', '\x03'], ['Tab', '\t'], ['Esc', '\x1b'],
    ['\u2191', '\x1b[A'], ['\u2193', '\x1b[B'], ['\u2190', '\x1b[D'], ['\u2192', '\x1b[C'],
    ['Ctrl+D', '\x04'], ['Ctrl+Z', '\x1a'], ['Ctrl+X', '\x18'], ['Ctrl+O', '\x0f'],
    ['Ctrl+L', '\x0c'], ['Home', '\x1b[H'], ['End', '\x1b[F'], ['PgUp', '\x1b[5~'], ['PgDn', '\x1b[6~']
  ];
  var keysEl = document.getElementById('keys');
  var ctrlBtn = document.createElement('button');
  ctrlBtn.type = 'button'; ctrlBtn.textContent = 'Ctrl+';
  ctrlBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
  ctrlBtn.addEventListener('click', function () {
    ctrl = !ctrl; ctrlBtn.className = ctrl ? 'on' : ''; cmd.focus();
  });
  keysEl.appendChild(ctrlBtn);
  keys.forEach(function (k) {
    var b = document.createElement('button');
    b.type = 'button'; b.textContent = k[0];
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('click', function () { send(k[1]); cmd.focus(); });
    keysEl.appendChild(b);
  });

  document.getElementById('row').addEventListener('submit', function (e) {
    e.preventDefault();
    var t = cmd.value; cmd.value = '';
    if (ctrl && t.length) {
      send(String.fromCharCode(t[0].toUpperCase().charCodeAt(0) & 31));
      ctrl = false; ctrlBtn.className = '';
    } else {
      send(t + '\r');
    }
    cmd.focus();
  });

  async function poll() {
    for (;;) {
      try {
        var r = await fetch('/out?o=' + off);
        if (r.status === 401) { location.reload(); return; }
        if (!r.ok) { await sleep(1500); continue; }
        var n = r.headers.get('X-Next');
        var b = new Uint8Array(await r.arrayBuffer());
        if (n !== null) off = parseInt(n, 10);
        if (b.length) {
          if (term) { term.write(b); }
          else { fb.textContent += strip(dec.decode(b, {stream: true})); termEl.scrollTop = termEl.scrollHeight; }
        }
      } catch (e) { await sleep(1500); }
    }
  }

  setTimeout(doFit, 300);
  poll();
})();
</script></body></html>
"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def authed(self):
        header = self.headers.get("Authorization", "")
        if not PASSWORD or not header.startswith("Basic "):
            return False
        try:
            user, _, pw = base64.b64decode(header[6:]).decode("utf-8").partition(":")
        except Exception:
            return False
        ok_user = hmac.compare_digest(user.encode(), USER.encode())
        ok_pass = hmac.compare_digest(pw.encode(), PASSWORD.encode())
        return ok_user and ok_pass

    def reply(self, code, body=b"", ctype="text/plain; charset=utf-8", extra=None):
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if body:
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def deny(self):
        time.sleep(1)
        self.reply(401, b"", extra={"WWW-Authenticate": 'Basic realm="VPS Terminal"'})

    def do_GET(self):
        if not self.authed():
            return self.deny()
        url = urlparse(self.path)
        if url.path == "/out":
            try:
                off = int(parse_qs(url.query).get("o", ["0"])[0])
            except ValueError:
                off = 0
            data, end = read_from(off, 20)
            return self.reply(200, data, "application/octet-stream", {"X-Next": str(end)})
        self.reply(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")

    def do_POST(self):
        if not self.authed():
            return self.deny()
        url = urlparse(self.path)
        try:
            n = min(int(self.headers.get("Content-Length") or 0), 100000)
        except ValueError:
            n = 0
        body = self.rfile.read(n) if n else b""
        if url.path == "/in":
            try:
                os.write(sess["fd"], body)
            except OSError:
                pass
        elif url.path == "/resize":
            q = parse_qs(url.query)
            try:
                cols = max(10, min(int(q["cols"][0]), 400))
                rows = max(3, min(int(q["rows"][0]), 200))
                sess["cols"], sess["rows"] = cols, rows
                set_winsize(sess["fd"], rows, cols)
            except (KeyError, ValueError, IndexError):
                pass
        self.reply(200)


if __name__ == "__main__":
    if not PASSWORD:
        raise SystemExit("PANEL_PASS khaali hai, terminal start nahi hoga")
    with open(RC_FILE, "w", encoding="utf-8") as f:
        f.write(RC_TEXT)
    spawn()
    threading.Thread(target=reader, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    print("Web terminal on 127.0.0.1:%d" % PORT, flush=True)
    server.serve_forever()
