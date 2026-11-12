# Assignment 1 — Mads-Lens

A web page that drives Claude Code in headless mode and shows the trajectory live.

## Run it

```bash
pip install -r requirements.txt        # fastapi + uvicorn
python server.py                       # http://127.0.0.1:8765
```

Environment variables (all optional):

| var | default | meaning |
|---|---|---|
| `PORT` / `HOST` | `8765` / `127.0.0.1` | where to listen |
| `DEFAULT_CWD` | empty | pre-filled working directory |
| `CLAUDE_PERMISSION_ARGS` | `--dangerously-skip-permissions` | e.g. `--allowedTools Edit Read "Bash(pytest:*)"` |
| `REPLAY_DELAY` | `0.12` | seconds between events at the *Normal* replay speed |
| `ACCESS_TOKEN` | unset | if set, every request needs `?token=…` (use when exposing the server) |

Uses your stored Claude Code login. `ANTHROPIC_API_KEY` is removed from the agent's environment on purpose.
Point it at a scratch directory, not your home directory.

## Replay mode

The **Live | Replay** toggle in the header picks the mode. **Live** runs the agent on your prompt in the working directory.
**Replay** visualizes a recorded stream-json `.jsonl` file instead of starting the agent, which
makes it fast and free for working on the rendering. Replay needs no prompt or working directory, so
those inputs are only shown in Live mode.

In replay mode, a **trace** picker lists your uploaded files and every `fixtures/*.jsonl` example.
Picking a trace starts it right away and shows every event recorded in it; **▶ Replay** at the bottom
plays it again. The bottom bar also sets the speed (*Instant* shows the whole trace at once, *Fast*,
*Normal*; remembered in the browser, and changeable mid-replay) and has **Pause / Resume** and
**Stop** while a replay plays. Record fixtures with:

```bash
cd ~/scratch/demo-repo
claude -p "find the bug that makes test_parse fail and fix it" \
  --output-format stream-json --verbose --dangerously-skip-permissions > path/to/assignment1/fixtures/events.jsonl
```

To visualize a file without copying it into `fixtures/`, upload it in replay mode: drop it anywhere
on the page, or use the drop zone or the **upload .jsonl** button. It is added to the trace picker as
"name (uploaded)", selected and replayed. Uploads are only accepted in replay mode; in live mode a
dropped file is refused. The browser sends the file's contents with the run, so nothing is saved on
the server, and uploads are gone when the tab is reloaded. A run's **stream .jsonl** download works
as such a file.

`fixtures/sample-handmade.jsonl` is a synthetic stream (with one subagent) for smoke tests.
`fixtures/sample-parallel.jsonl` has two subagents running in parallel, then one on its own.
Two madsLoop traces, written by scripted runs of the real assignment 2 harness (no API key needed):

- `madsloop_review_demo.jsonl` (`assignment2/scripts/review_demo.py`): every kind of harness
  action. It has a checklist free turn, read-only calls run early, a loop-guard refusal, a nudge,
  a `done` refused for open checklist items, and the reviewer subagent. The reviewer is nudged,
  warned that it is running low on calls, and gets its verdict through the tool-free fallback
  request. Its "fail" verdict sends the main agent back to work. Every request is recorded in full.
- `madsloop_context_demo.jsonl` (`assignment2/scripts/context_demo.py`): context management.
  Old tool results are trimmed, then cleared, then compacted into a summary (the summarizer's
  call is its own round).

## Subagents as a tree

Events with a `parent_tool_use_id` nest under the call that spawned them.

- **Names:** every subagent is named. The main agent's subagents are A, B, C… in the order they
  started; subagents started by subagent A are A.1, A.2, and so on. Each subagent's events sit in a
  tinted body labelled with who started it.
- **Dispatch:** subagent calls issued in the same turn (same assistant message id) are drawn as
  one dispatch node owned by whoever started them: MAIN AGENT, or SUBAGENT A. Each subagent is a
  branch off a tree rail, and each branch folds on its own.
- **Return and join:** a line under each branch shows its report returning ("A still working…" or
  "never returned" when the run ends first). The rail ends in a join node: "waiting · k/N back",
  then "joins all N reports and continues".
- **Outline:** a dispatch forks into side-by-side columns that rejoin at a "join k/N" marker. When
  the columns don't fit (many parallel agents, or the narrow drawer), the branches are stacked on a
  tree rail instead.

## Event recording and inspection

Every line the server sends is recorded per run with a sequence number, its time, which agent sent it
(main or a subagent) and its model turn. Nothing is dropped.

- **Run card:** the top of each run shows its status (running, finished, failed, stopped) and its size:
  duration, turns, tool calls, cost. If any tool call failed, **jump to first** scrolls to it.
- **Dialogue:** event kinds without special rendering show as grey `kind summary` lines; click one to see
  its raw JSON. Hover a card to see its `#n`, which opens that event in the inspector (on touch screens
  `#n` is always shown).
- **View** (header button **view**): what the dialogue shows. *Essentials* (the default) keeps text,
  thinking, tool calls and results, and subagent prompts. *Everything* adds bookkeeping such as session
  start, hooks, rate limits and server events. *Custom* lets you pick event kinds one by one. The choice
  is saved in the browser.
- **Keys:** `[` and `]` move to the previous / next run, `e` jumps to the next failed tool call (across
  all runs, wrapping around), `←` `→` step through rounds in the inspector, `Esc` closes the
  inspector and popovers.
- **Harness traces** (madsLoop `--trace`): the dialogue also shows the system prompt (folded), who
  each message to the model comes from (task, harness nudge, compacted context), and harness
  decisions as ⚙ lines, inside the card of the call they concern.
- **Who wrote what:** three colours, in the dialogue and in the chat view. **LLM** (violet) marks
  the model's words: thinking, text, tool-call requests. **Harness** (teal) marks what the harness
  wrote or decided: the system prompt, the task, nudges, compaction, refusals, notes appended to
  results. **Tool output** (grey) marks what a tool printed. A tool card shows the LLM's request on
  top and the result below, coloured by who wrote it. A refused call's "result" was written by the
  harness, so it is teal.
- **Model calls:** each model call starts with an "LLM · round *n*" divider showing its token
  counts. Clicking the divider, a tool call, or an **R*n*** link opens that round in the chat view.
  The **▸** caret on a tool card shows its input in place. A result's **→ R*n*** link opens the
  next call, scrolled to where that result reaches the model.
- **Inspector** (the **inspect** button on each prompt):
  - *Overview*: input (prompt, cwd, exact command, resumed session, model, tools) and output (status,
    final answer, cost, duration, token usage per model, permission denials, exit code, stderr).
  - *Rounds*, **chat** layout (the default): one model call drawn as the conversation the model
    received. The LLM is stateless: the harness rebuilds and resends the whole context on every
    call, so the view shows that call's exact input as bubbles. You see the system prompt, the
    tool definitions, and every message, coloured by who wrote it. The model's own earlier
    replies are marked as resent by the harness, and reasoning that is never resent is noted.
    Earlier messages unchanged since the previous call are folded into one line, and new ones
    are marked. Pruned tool results show what was actually sent, with the full text the harness
    still holds one click away. After a "model call" divider comes the reply, then what the
    harness did with each tool call, with links to the call where each result is seen. The
    compaction summarizer and the reviewer's verdict fallback are rounds of their own. For
    madsLoop traces, a banner says whether the rebuild matches the digest of what was really
    sent (**✓ Exact**). On a mismatch it shows the first differing message and, when the trace
    recorded it (`--trace-requests`), the request exactly as sent.
  - *Rounds*, **list** layout: the same round as compact rows. One page per model call (◀ / ▶ or the ← → keys; filter by agent). **Sent to the
    model**: the system prompt, the tool definitions and the message history as that request
    carried it, with messages new since the previous round marked, old tool results shown as
    pruning shortened them, compaction summaries, and the context-window fill; **⤓ context.json**
    downloads the request. **Model output**: thinking, text, tool calls, stop reason, tokens.
    **Harness response**: each call's result, with what the harness decided about it (refused,
    blocked, run early, warning or note appended, review verdict), plus nudges and free turns.
    Exact for madsLoop `--trace` files; for Claude Code's own stream the system prompt and tool
    definitions are not available, so only the conversation part is shown.
    The **R*n*** link on a tool card (on hover) opens the round that made that call. Each round
    also lists what changed in the context since the previous request (trimmed, cleared, or
    folded into a compaction summary).
  - *Context*: the main agent's context over the whole run. A chart of the context sent per
    request, stacked by message state (sent whole, trimmed, cleared, compaction summary), with the
    unpruned size, the trim / clear / compact thresholds and compaction markers; a map with one
    row per message and one column per request, showing when each message was trimmed, cleared or
    folded away; a list of every pruning and compaction step with the messages it touched and the
    summary written; and a table view. Click a bar or cell to open that round. Uses the ledger in
    madsLoop traces; older traces and Claude Code streams are rebuilt from the rounds.
  - *Events*: every raw event, searchable and filterable by kind.
  - Downloads: `stream .jsonl` (Claude Code's events only, can be used as a replay fixture) and `full log`.

## Layout

- `server.py`: FastAPI. `POST /api/run` starts `claude -p … --output-format stream-json --verbose [--resume id]`
  in the chosen directory and streams its stdout as NDJSON, plus a few `{"type":"_server"}` events
  (start / error / exit). `POST /api/runs/{id}/stop` kills a run. A replay (`replay` = a fixture name,
  or `replay_text` = an uploaded file's contents) streams the file instead; `POST /api/runs/{id}/replay`
  with `{"paused": …, "speed": …}` pauses, resumes or re-paces it.
- `static/app.js`: Preact + htm (no build step). Turns events into a tree keyed by `tool_use_id` /
  `parent_tool_use_id`, then renders the dialogue, the outline and the per-call and per-run status.
- `static/vendor/`: pinned copies of preact+htm 3.1.1, marked 12.0.2 and DOMPurify 3.1.6.
