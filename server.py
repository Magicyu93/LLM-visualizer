"""LLM Visualizer backend: spawns `claude -p ... --output-format stream-json` and streams its
events to the browser as NDJSON (one JSON object per line).

Besides Claude Code's own events, the server emits a few events of its own, all with
"type": "_server":
  start  {run_id, cwd, resume}      the run was accepted
  spawn  {argv, pid}                the exact command that was started
  error  {message}                  the run could not start (bad directory, no claude binary, ...)
  stdout {text}                     a stdout line that was not JSON
  stderr {text}                     one stderr line, forwarded as it arrives
  exit   {code, stderr, stopped}    the subprocess exited (always the last line)
"""

import asyncio
import json
import os
import shutil
import signal
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT / "fixtures"
STATIC = ROOT / "static"

DEFAULT_CWD = os.environ.get("DEFAULT_CWD", "")
REPLAY_DELAY = float(os.environ.get("REPLAY_DELAY", "0.12"))
# seconds between replayed events, per speed the page offers; "normal" is REPLAY_DELAY
SPEED_DELAYS = {"instant": 0.0, "fast": 0.03, "normal": REPLAY_DELAY}
# Headless runs cannot answer permission prompts. Point the agent at a scratch directory.
PERMISSION_ARGS = os.environ.get(
    "CLAUDE_PERMISSION_ARGS", "--dangerously-skip-permissions"
).split()
# Optional: set ACCESS_TOKEN when the server is reachable from other machines.
ACCESS_TOKEN = os.environ.get("ACCESS_TOKEN")

app = FastAPI(title="LLM Visualizer")

# run_id -> live subprocess, so a run can be stopped
RUNS: dict[str, asyncio.subprocess.Process] = {}
STOPPED: set[str] = set()
# run_id -> {"paused": bool, "speed": str} for replays in progress, changed by POST .../replay
REPLAYS: dict[str, dict] = {}


@app.middleware("http")
async def require_token(request: Request, call_next):
    if ACCESS_TOKEN:
        given = request.headers.get("x-access-token") or request.query_params.get("token")
        if given != ACCESS_TOKEN:
            return JSONResponse({"detail": "missing or wrong access token"}, status_code=401)
    return await call_next(request)


class RunRequest(BaseModel):
    prompt: str = ""  # live runs only; a replay shows the file's events and uses neither field
    cwd: str = ""
    session_id: str | None = None
    replay: str | None = None  # fixture file name; replays it instead of spawning claude
    replay_text: str | None = None  # a file's contents, loaded in the browser; replayed the same way
    replay_speed: str = "normal"  # a key of SPEED_DELAYS


class ReplayControl(BaseModel):
    paused: bool | None = None
    speed: str | None = None


def line(obj: dict) -> str:
    return json.dumps(obj) + "\n"


def server_event(subtype: str, **fields) -> str:
    return line({"type": "_server", "subtype": subtype, **fields})


def kill(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)  # claude may have children (Bash tool)
        except ProcessLookupError:
            pass


async def run_live(req: RunRequest, run_id: str, cwd: str):
    claude = shutil.which("claude")
    if not claude:
        yield server_event("error", message="`claude` was not found on PATH")
        return

    args = [claude, "-p", req.prompt, "--output-format", "stream-json", "--verbose", *PERMISSION_ARGS]
    if req.session_id:
        args += ["--resume", req.session_id]

    # An exported API key would take precedence over your Claude Code login and bill that key.
    env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}

    proc = await asyncio.create_subprocess_exec(
        *args,
        cwd=cwd,
        env=env,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        limit=64 * 1024 * 1024,  # tool results can be one very long line
        start_new_session=True,
    )
    RUNS[run_id] = proc
    yield server_event("spawn", argv=args, pid=proc.pid)

    # Merge stdout and stderr into one queue so both are forwarded in arrival order.
    queue: asyncio.Queue = asyncio.Queue()

    async def pump(stream, name):
        async for raw in stream:
            await queue.put((name, raw))
        await queue.put((name, None))

    tasks = [
        asyncio.create_task(pump(proc.stdout, "stdout")),
        asyncio.create_task(pump(proc.stderr, "stderr")),
    ]
    stderr_lines: list[str] = []
    try:
        open_streams = 2
        while open_streams:
            name, raw = await queue.get()
            if raw is None:
                open_streams -= 1
                continue
            text = raw.decode(errors="replace").rstrip("\r\n")
            if name == "stderr":
                stderr_lines.append(text)
                yield server_event("stderr", text=text)
                continue
            text = text.strip()
            if not text:
                continue
            try:
                json.loads(text)
            except json.JSONDecodeError:
                yield server_event("stdout", text=text)
                continue
            yield text + "\n"
        code = await proc.wait()
        yield server_event(
            "exit", code=code, stderr="\n".join(stderr_lines)[-4000:], stopped=run_id in STOPPED
        )
    finally:
        # Also reached when the browser disconnects mid-run: don't leave the agent running.
        kill(proc)
        for t in tasks:
            t.cancel()
        RUNS.pop(run_id, None)
        STOPPED.discard(run_id)


async def run_replay(req: RunRequest, run_id: str):
    if req.replay_text is not None:
        lines = req.replay_text.split("\n")   # not splitlines(): JSON may hold a raw U+2028
    else:
        path = (FIXTURES / req.replay).resolve()
        if path.parent != FIXTURES or not path.is_file():
            yield server_event("error", message=f"no such fixture: {req.replay}")
            return
        lines = path.read_text(encoding="utf-8").split("\n")
    ctrl = REPLAYS[run_id] = {"paused": False, "speed": req.replay_speed}
    try:
        for raw in lines:
            while ctrl["paused"] and run_id not in STOPPED:
                await asyncio.sleep(0.1)
            if run_id in STOPPED:
                STOPPED.discard(run_id)
                yield server_event("exit", code=-15, stderr="", stopped=True)
                return
            if raw.strip():
                yield raw.strip() + "\n"
                delay = SPEED_DELAYS.get(ctrl["speed"], REPLAY_DELAY)
                if delay:
                    await asyncio.sleep(delay)
        yield server_event("exit", code=0, stderr="", stopped=False)
    finally:
        REPLAYS.pop(run_id, None)


@app.post("/api/run")
async def run(req: RunRequest):
    run_id = uuid.uuid4().hex[:12]
    replaying = bool(req.replay) or req.replay_text is not None

    async def stream():
        if replaying:
            # A replay only streams the recorded events: no prompt, no working directory.
            yield server_event("start", run_id=run_id, cwd=None, resume=None, replay=True)
            async for chunk in run_replay(req, run_id):
                yield chunk
            return
        cwd = os.path.abspath(os.path.expanduser(req.cwd.strip() or "."))
        yield server_event("start", run_id=run_id, cwd=cwd, resume=req.session_id)
        if not req.prompt.strip():
            yield server_event("error", message="empty prompt")
            return
        if not os.path.isdir(cwd):
            yield server_event("error", message=f"{cwd} is not a directory")
            return
        async for chunk in run_live(req, run_id, cwd):
            yield chunk

    return StreamingResponse(
        stream(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/runs/{run_id}/stop")
async def stop(run_id: str):
    STOPPED.add(run_id)
    proc = RUNS.get(run_id)
    if proc:
        kill(proc)
    return {"ok": True}


@app.post("/api/runs/{run_id}/replay")
async def control_replay(run_id: str, ctl: ReplayControl):
    """Pause, resume or change the speed of a replay in progress."""
    ctrl = REPLAYS.get(run_id)
    if not ctrl:
        return {"ok": False}
    if ctl.paused is not None:
        ctrl["paused"] = ctl.paused
    if ctl.speed in SPEED_DELAYS:
        ctrl["speed"] = ctl.speed
    return {"ok": True}


@app.get("/api/config")
async def config():
    fixtures = sorted(p.name for p in FIXTURES.glob("*.jsonl")) if FIXTURES.is_dir() else []
    return {"default_cwd": DEFAULT_CWD, "fixtures": fixtures}


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "8765")))
