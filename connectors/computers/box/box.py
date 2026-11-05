#!/usr/bin/env python3
"""Runs on each computer the Computers connector manages: commands as jobs with a lease, idle shutdown, and (on Fly) file transfer.

The connector installs this file at /var/lib/mcp-computer/box.py and calls it through the provider's own exec.
It is run as root (directly, or with sudo); commands run as the computer's own user.

  box.py run <id> <timeout_sec> <user> <cwd_b64> <command_b64>   start a command as a job
  box.py wait <id> <wait_sec> <offset>                            wait for a job, renew its lease
  box.py cancel <id>                                              end a job and everything it started
  box.py watch <id>                                               (internal) the job's watchdog
  box.py idle <minutes> <shutdown_b64>                            stop the computer when idle
  box.py serve <port>                                             file transfer over HTTPS (Fly)
  box.py daemons <minutes> <shutdown_b64> <port|0>                start idle (and serve) unless running
  box.py close-browser                                            close the browser so its profile is saved
  box.py end-all                                                  end every job (before a stop)

Every job runs in its own cgroup when the kernel offers one, so ending it ends background and
root processes too; without a cgroup it falls back to the process group. A job whose lease is not
renewed for LEASE_SEC (nobody is waiting for it: the turn was stopped, the connector exited) is
ended, so a stopped turn never leaves work running.
"""
import base64, hmac, http.server, json, os, shutil, signal, subprocess, sys, time

ROOT = os.environ.get('COMPUTER_BOX_ROOT', '/var/lib/mcp-computer')
JOBS = os.path.join(ROOT, 'jobs')
LAST = os.path.join(ROOT, 'last-activity')
LEASE_SEC = 180
MAX_OUTPUT = 60_000
# Pure cgroup v2 first; on hybrid hosts (Fly) v2 is mounted at unified/.
CGROUP_BASES = ['/sys/fs/cgroup', '/sys/fs/cgroup/unified']


def boot_id():
    return read('/proc/sys/kernel/random/boot_id', '')


def touch(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'a'):
        os.utime(path, None)


def job_dir(job_id):
    if not job_id.replace('-', '').isalnum():
        raise SystemExit('bad job id')
    return os.path.join(JOBS, job_id)


def read(path, default=None):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return default


def cgroup_for(job_id):
    """A fresh cgroup v2 for the job, or None when the kernel doesn't offer one we can kill."""
    for base in CGROUP_BASES:
        if not os.path.exists(os.path.join(base, 'cgroup.controllers')):
            continue
        path = os.path.join(base, 'mcp-computer', job_id)
        try:
            os.makedirs(path, exist_ok=True)
            if os.path.exists(os.path.join(path, 'cgroup.kill')):
                return path
            os.rmdir(path)
        except OSError:
            continue
    return None


def run(job_id, timeout_sec, user, cwd_b64, command_b64):
    d = job_dir(job_id)
    os.makedirs(d, exist_ok=False)
    with open(os.path.join(d, 'command'), 'wb') as f:
        f.write(base64.b64decode(command_b64))
    with open(os.path.join(d, 'cwd'), 'wb') as f:
        f.write(base64.b64decode(cwd_b64))
    cg = cgroup_for(job_id) or ''
    with open(os.path.join(d, 'meta.json'), 'w') as f:
        json.dump({'started': time.time(), 'timeout': int(timeout_sec), 'cgroup': cg, 'boot': boot_id()}, f)
    touch(os.path.join(d, 'lease'))
    out = os.path.join(d, 'output')
    import pwd
    user = user or 'root'
    as_user = '' if user in ('root', pwd.getpwuid(os.getuid()).pw_name) else f'runuser -u {user} -- '
    setup_env = ('export HOME="$(getent passwd "$(id -un)" | cut -d: -f6)" PATH="$HOME/.mcp-computer/bin:$PATH" '
                 'AGENT_BROWSER_PROFILE="$HOME/.mcp-computer/browser-profile"; '
                 'cd "$(cat "$1")" 2>/dev/null || { echo "The folder $(cat "$1") does not exist on this computer; nothing was run." >&2; exit 2; }; '
                 'exec bash -l "$0"')
    script = (
        f'[ -n "{cg}" ] && echo $$ > "{cg}/cgroup.procs"; '
        f'{as_user}bash -c \'{setup_env}\' "{d}/command" "{d}/cwd" > "{out}" 2>&1 < /dev/null; '
        f'echo $? > "{d}/exit.tmp" && mv "{d}/exit.tmp" "{d}/exit"'
    )
    wrapper = subprocess.Popen(['bash', '-c', script], start_new_session=True,
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with open(os.path.join(d, 'pid'), 'w') as f:
        f.write(str(wrapper.pid))
    subprocess.Popen([sys.executable, os.path.abspath(__file__), 'watch', job_id], start_new_session=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def kill_group(d, meta):
    cg = meta.get('cgroup')
    if cg and os.path.exists(os.path.join(cg, 'cgroup.kill')):
        with open(os.path.join(cg, 'cgroup.kill'), 'w') as f:
            f.write('1')
        return
    pid = int(read(os.path.join(d, 'pid'), '0') or 0)
    if pid:
        try:
            os.killpg(pid, signal.SIGKILL)
        except OSError:
            pass


def end_job(job_id, reason):
    d = job_dir(job_id)
    meta = json.loads(read(os.path.join(d, 'meta.json'), '{}'))
    if os.path.exists(os.path.join(d, 'exit')):
        kill_group(d, meta)  # anything it left running in the background
        return
    with open(os.path.join(d, 'stopped'), 'w') as f:
        f.write(reason)
    cg = meta.get('cgroup')
    if cg and os.path.exists(os.path.join(cg, 'cgroup.kill')):
        with open(os.path.join(cg, 'cgroup.kill'), 'w') as f:
            f.write('1')
    else:
        pid = int(read(os.path.join(d, 'pid'), '0') or 0)
        if pid:
            try:
                os.killpg(pid, signal.SIGKILL)
            except OSError:
                pass
    time.sleep(0.5)
    if not os.path.exists(os.path.join(d, 'exit')):
        with open(os.path.join(d, 'exit'), 'w') as f:
            f.write('137')


def watch(job_id):
    d = job_dir(job_id)
    meta = json.loads(read(os.path.join(d, 'meta.json'), '{}'))
    while not os.path.exists(os.path.join(d, 'exit')):
        now = time.time()
        if now - os.path.getmtime(os.path.join(d, 'lease')) > LEASE_SEC:
            end_job(job_id, 'lease')
        elif now - meta.get('started', now) > meta.get('timeout', 1800):
            end_job(job_id, 'timeout')
        time.sleep(2)
    # The command has finished: whatever it left running in the background ends with it,
    # except a browser command's browser, which later browser commands reuse (it is closed
    # before every stop, and an explicit cancel still ends it).
    if not job_id.startswith('browser-'):
        kill_group(d, meta)
    cg = meta.get('cgroup')
    for _ in range(10):
        try:
            if cg:
                os.rmdir(cg)
            break
        except OSError:
            time.sleep(0.5)


def wait(job_id, wait_sec, offset):
    d = job_dir(job_id)
    if not os.path.isdir(d):
        print(json.dumps({'state': 'unknown'}))
        return
    reconcile(job_id)
    touch(os.path.join(d, 'lease'))
    deadline = time.time() + float(wait_sec)
    while time.time() < deadline and not os.path.exists(os.path.join(d, 'exit')):
        time.sleep(0.3)
    touch(os.path.join(d, 'lease'))
    exit_text = read(os.path.join(d, 'exit'))
    stopped = read(os.path.join(d, 'stopped'))
    size = os.path.getsize(os.path.join(d, 'output')) if os.path.exists(os.path.join(d, 'output')) else 0
    start = min(int(offset), size)
    with open(os.path.join(d, 'output'), 'rb') if size else open(os.devnull, 'rb') as f:
        f.seek(start)
        chunk = f.read(MAX_OUTPUT)
    meta = json.loads(read(os.path.join(d, 'meta.json'), '{}'))
    print(json.dumps({
        'state': 'running' if exit_text is None else ('stopped' if stopped else 'finished'),
        'exit_code': None if exit_text is None or stopped else int(exit_text or 0),
        'stopped_reason': stopped,
        'output_b64': base64.b64encode(chunk).decode(),
        'next_offset': start + len(chunk),
        'more_output': start + len(chunk) < size,
        'elapsed_sec': int(time.time() - meta.get('started', time.time())),
    }))


def reconcile(job_id):
    """A job from before the last restart can't still be running: record that it was stopped."""
    d = job_dir(job_id)
    if os.path.exists(os.path.join(d, 'exit')):
        return
    meta = json.loads(read(os.path.join(d, 'meta.json'), '{}'))
    if meta.get('boot') and meta['boot'] != boot_id():
        with open(os.path.join(d, 'stopped'), 'w') as f:
            f.write('restart')
        with open(os.path.join(d, 'exit'), 'w') as f:
            f.write('137')


def jobs():
    return [j for j in os.listdir(JOBS) if os.path.isdir(os.path.join(JOBS, j))] if os.path.isdir(JOBS) else []


def running_jobs():
    for j in jobs():
        reconcile(j)
    return sum(1 for j in jobs() if not os.path.exists(os.path.join(JOBS, j, 'exit')))


def end_all():
    """Ends every job (before the computer stops), so nothing resumes later on its own."""
    for j in jobs():
        end_job(j, 'computer stopped')


def close_browser():
    """Closes the browser through agent-browser so it writes cookies and sign-ins to the profile."""
    import glob, pwd
    for home in ['/root'] + glob.glob('/home/*'):
        tool = os.path.join(home, '.mcp-computer', 'bin', 'agent-browser')
        if not os.path.exists(tool):
            continue
        owner = pwd.getpwuid(os.stat(home).st_uid).pw_name
        argv = ['env', f'HOME={home}', f'AGENT_BROWSER_PROFILE={home}/.mcp-computer/browser-profile', tool, 'close']
        if owner != 'root':
            argv = ['runuser', '-u', owner, '--'] + argv
        subprocess.call(argv, timeout=20, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def idle(minutes, shutdown_b64):
    shutdown = base64.b64decode(shutdown_b64).decode()
    touch(LAST)
    remember_pid('idle')

    def close_browser_and_exit(*_):
        close_browser()
        sys.exit(0)

    signal.signal(signal.SIGTERM, close_browser_and_exit)
    signal.signal(signal.SIGINT, close_browser_and_exit)
    while True:
        time.sleep(30)
        if running_jobs() == 0 and time.time() - os.path.getmtime(LAST) > float(minutes) * 60:
            close_browser()
            subprocess.call(['bash', '-c', shutdown])
            sys.exit(0)


class Files(http.server.BaseHTTPRequestHandler):
    key = b''

    def log_message(self, *_):
        pass

    def authorised(self):
        given = self.headers.get('Authorization', '').removeprefix('Bearer ').encode()
        if not self.key or not hmac.compare_digest(given, self.key):
            self.send_response(401)
            self.end_headers()
            return None
        touch(LAST)
        from urllib.parse import parse_qs, urlparse
        q = parse_qs(urlparse(self.path).query)
        return q.get('path', [''])[0], q.get('mode', ['replace'])[0]

    def do_GET(self):
        got = self.authorised()
        if not got:
            return
        try:
            size = os.path.getsize(got[0])
            with open(got[0], 'rb') as f:
                self.send_response(200)
                self.send_header('Content-Length', str(size))
                self.end_headers()
                shutil.copyfileobj(f, self.wfile)
        except OSError as e:
            self.send_response(404 if isinstance(e, FileNotFoundError) else 400)
            self.end_headers()

    def do_PUT(self):
        got = self.authorised()
        if not got:
            return
        path, mode = got
        length = int(self.headers.get('Content-Length', '0'))
        try:
            if mode == 'new' and os.path.exists(path):
                raise FileExistsError(path)
            os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
            tmp = f'{path}.computer-upload'
            with open(tmp, 'wb') as f:
                remaining = length
                while remaining:
                    chunk = self.rfile.read(min(remaining, 1 << 20))
                    if not chunk:
                        raise OSError('short upload')
                    f.write(chunk)
                    remaining -= len(chunk)
            os.replace(tmp, path)
            self.send_response(200)
        except FileExistsError:
            self.send_response(409)
        except OSError:
            self.send_response(400)
        self.end_headers()


def serve(port):
    Files.key = (read(os.path.join(ROOT, 'key'), '') or '').encode()
    remember_pid('serve')
    http.server.ThreadingHTTPServer(('0.0.0.0', int(port)), Files).serve_forever()


def alive(name):
    pid = read(os.path.join(ROOT, f'{name}.pid'))
    try:
        os.kill(int(pid), 0)
        return True
    except (TypeError, ValueError, OSError):
        return False


def remember_pid(name):
    with open(os.path.join(ROOT, f'{name}.pid'), 'w') as f:
        f.write(str(os.getpid()))


def daemons(minutes, shutdown_b64, port):
    me = [sys.executable, os.path.abspath(__file__)]
    detached = dict(start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if not alive('idle'):
        subprocess.Popen(me + ['idle', minutes, shutdown_b64], **detached)
    if port != '0' and not alive('serve'):
        subprocess.Popen(me + ['serve', port], **detached)


if __name__ == '__main__':
    command, args = sys.argv[1], sys.argv[2:]
    if command not in ('watch', 'serve', 'idle', 'daemons'):
        touch(LAST)
    {'run': run, 'wait': wait, 'cancel': lambda job_id: end_job(job_id, 'cancelled'), 'watch': watch,
     'idle': idle, 'serve': serve, 'daemons': daemons,
     'close-browser': close_browser, 'end-all': end_all}[command](*args)
