import { html, render, useReducer, useState, useEffect, useLayoutEffect, useRef } from './vendor/preact-htm.js';
import { marked } from './vendor/marked.esm.js';
import DOMPurify from './vendor/purify.es.mjs';

// ---------------------------------------------------------------- store
// One mutable store; every change schedules a re-render on the next frame.

const TOKEN = new URLSearchParams(location.search).get('token');
const headers = { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Access-Token': TOKEN } : {}) };

const store = {
  runs: [],
  cwd: load('cwd', ''),
  mode: 'live',          // 'live' or 'replay'
  trace: '',             // replay source: a fixture filename, or FILE_MODE + the name of an uploaded file
  fixtures: [],
  speed: load('speed', 'normal'),  // replay speed: 'instant', 'fast' or 'normal'
  files: {},             // name -> text of .jsonl files the user dropped or picked (kept in this tab only)
  fileError: null,       // why the last loaded file was rejected
  sessionId: null,       // session to resume on the next run
  sessionDirs: [],       // the session's directory (as typed and resolved); a new cwd starts a new session
  // Event kinds hidden from the dialogue (still recorded and listed in the inspector). By default only
  // pure bookkeeping is hidden; the events panel changes this and remembers the choice.
  // What the dialogue shows: 'essentials' (the conversation and tool calls), 'everything', or
  // 'custom' (every kind except those in `hidden`). Every event is recorded either way.
  view: load('view', 'essentials'),
  hidden: new Set(loadJSON('hidden', ['server/start', 'server/spawn', 'server/exit', 'system/init'])),
  kindCounts: {},        // event kind -> count, across all runs
  ui: {
    agentOpen: {}, inputOpen: {}, resultOpen: {}, rawOpen: {},
    outlineOpen: false, filterOpen: false, dragging: false,
    inspect: null,      // { runId, tab, q, kind, open: {seq: true} }
    roundLayout: load('roundLayout', 'chat'),   // rounds as a 'chat' or a 'list'
  },
};

let rerender = () => {};
let frame = 0;
function changed() {
  if (!frame) frame = requestAnimationFrame(() => { frame = 0; rerender(); });
}

function load(k, d) { try { return localStorage.getItem('lens.' + k) ?? d; } catch { return d; } }
function loadJSON(k, d) { try { return JSON.parse(load(k, null)) ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem('lens.' + k, v); } catch {} }

let nextId = 1;
function newRun(prompt, cwd, resume, replay) {
  return {
    id: nextId++, prompt, cwd, resume, replay,
    status: 'running', error: null, result: null,
    root: [], calls: {}, absCwd: null, model: null, sessionId: null, init: null,
    serverRunId: null, argv: null, exit: null, stderr: '',
    startedAt: Date.now(), endedAt: null, folded: false,
    events: [],          // every event, in arrival order: { seq, t, ev, kinds, agent, turn, io }
    kindCounts: {},
    agents: {},          // per agent (main / tool_use id): turn tracking
    turns: [],           // model turns: { agent, n, inputs: [rec], outputs: [rec], usage, model, t }
  };
}

// ---------------------------------------------------------------- event kinds

// Kinds with dedicated rendering. Anything else still shows up, as a raw event line.
const KIND_INFO = {
  'system/init': 'session start: model, tools, cwd, permission mode',
  'assistant/text': "assistant's text, rendered as markdown",
  'assistant/thinking': 'extended thinking',
  'assistant/tool_use': 'tool call cards (hiding this also hides subagent contents)',
  'user/tool_result': 'tool results inside the cards',
  'user/prompt': 'the prompt handed to a subagent',
  'user/text': "text sent to the model as user input (a subagent's prompt, interruptions)",
  'result/success': 'final result: shown in the status line',
  'server/start': 'server accepted the run',
  'server/spawn': 'the exact command the server started',
  'server/stderr': "claude's stderr, line by line",
  'server/stdout': 'stdout lines that were not JSON',
  'server/exit': 'process exit code',
  'server/error': 'the run could not start: shown in the status line',
  'client/unparsed': 'a line the page could not parse as JSON',
  // harness traces (see "Harness trace format" in README.md)
  'system/system_prompt': 'the system prompt the agent was given (harness traces)',
  'system/harness': 'a harness decision: a refused, blocked or early call, an appended note, a nudge, a review',
  'system/context': 'what one request contained and what pruning shortened (shown in Rounds)',
  'system/compact_boundary': 'a compaction: older turns replaced by a summary',
  'system/context_overflow': 'the API rejected a request as too large',
  'system/api_retry': 'a transient API error and its backoff',
  'system/request': 'a one-off request outside the conversation (shown in Rounds)',
  'system/llm_request': 'a digest of exactly what one model call was sent, used to verify the chat view',
};
const ESSENTIAL = new Set(['assistant/text', 'assistant/thinking', 'assistant/tool_use', 'user/tool_result', 'user/prompt', 'user/text',
  'system/system_prompt', 'system/harness', 'system/compact_boundary', 'system/context_overflow']);
const isAlways = k => k.startsWith('result/') || k === 'server/error';
const shown = k => isAlways(k) || store.view === 'everything'
  || (store.view === 'custom' ? !store.hidden.has(k) : ESSENTIAL.has(k));

const VIEWS = [
  ['essentials', 'Essentials', 'the conversation: text, thinking, tool calls and results, subagent prompts'],
  ['everything', 'Everything', 'also bookkeeping: session start, hooks, rate limits, server events'],
  ['custom', 'Custom', 'choose event kinds one by one'],
];

// Custom starts from whatever the current view shows, so switching changes nothing on screen.
function setView(view) {
  if (view === 'custom' && store.view !== 'custom') {
    store.hidden = new Set(allKinds().filter(k => !shown(k)));
    save('hidden', JSON.stringify([...store.hidden]));
  }
  store.view = view;
  save('view', view);
  changed();
}

function setHidden(kinds, hide) {
  if (store.view !== 'custom') setView('custom');
  for (const k of kinds) hide ? store.hidden.add(k) : store.hidden.delete(k);
  save('hidden', JSON.stringify([...store.hidden]));
  changed();
}

function eventKinds(ev) {
  const t = ev.type === '_server' ? 'server' : ev.type === '_client' ? 'client' : String(ev.type);
  if (ev.type === 'assistant' || ev.type === 'user') {
    const c = ev.message?.content;
    if (typeof c === 'string') return [`${t}/prompt`];
    if (Array.isArray(c) && c.length) return [...new Set(c.map(b => `${t}/${b.type}`))];
    return [`${t}/empty`];
  }
  return [ev.subtype ? `${t}/${ev.subtype}` : t];
}

// ---------------------------------------------------------------- event handling

function containerFor(run, parentId) {
  const parent = parentId && run.calls[parentId];
  return parent ? parent.children : run.root;
}

function resultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(b => b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : JSON.stringify(b)).join('\n');
  }
  return JSON.stringify(content, null, 2);
}

// Group events into model turns: a new assistant message id starts a turn; the user events
// (tool results, subagent prompt) since the previous turn are that turn's input.
function trackTurn(run, rec, io) {
  const a = run.agents[rec.agent] ||= { n: 0, lastMsg: null, current: null, pending: [] };
  if (io === 'out') {
    const mid = rec.ev.message?.id || `seq${rec.seq}`;
    if (mid !== a.lastMsg) {
      a.n++;
      a.lastMsg = mid;
      a.current = { agent: rec.agent, n: a.n, inputs: a.pending, outputs: [], usage: null, model: null, t: rec.t };
      a.pending = [];
      run.turns.push(a.current);
    }
    a.current.outputs.push(rec);
    a.current.usage = rec.ev.message?.usage || a.current.usage;
    a.current.model = rec.ev.message?.model || a.current.model;
    rec.turn = a.n;
  } else {
    a.pending.push(rec);
    rec.turn = a.n + 1;
  }
  rec.io = io;
}

// When an event happened. A replay arrives at replay speed, so it uses the trace's own
// timestamps when it has them (harness traces do; Claude Code's stream mostly does not).
function eventTime(run, ev) {
  const ts = run.replay && ev.timestamp ? Date.parse(ev.timestamp) : NaN;
  if (Number.isNaN(ts)) return Date.now();
  run.t0 ??= ts;
  return run.startedAt + (ts - run.t0);
}

function handleEvent(run, ev) {
  const now = eventTime(run, ev);
  const rec = {
    seq: run.events.length + 1, t: now - run.startedAt, ev,
    kinds: eventKinds(ev), agent: ev.parent_tool_use_id || 'main', turn: null, io: null,
  };
  run.events.push(rec);
  for (const k of rec.kinds) {
    run.kindCounts[k] = (run.kindCounts[k] || 0) + 1;
    store.kindCounts[k] = (store.kindCounts[k] || 0) + 1;
  }

  const list = containerFor(run, ev.parent_tool_use_id);
  let part = 0;
  const raw = (ek, block) => list.push({ kind: 'raw', ek, rec, block, id: `${rec.seq}.${part++}` });

  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init') {
        run.init = ev;
        run.sessionId = ev.session_id;
        run.model = ev.model;
        run.absCwd = ev.cwd;
        raw(rec.kinds[0]);
      } else if (ev.subtype === 'system_prompt') {
        list.push({ kind: 'sysprompt', ek: 'system/system_prompt', text: ev.content || '', rec });
      } else if (ev.subtype === 'harness' && ev.tool_use_id && run.calls[ev.tool_use_id]) {
        (run.calls[ev.tool_use_id].harness ||= []).push(rec);    // shown inside that call's card
      } else if (ev.subtype === 'harness' && ev.action === 'nudge') {
        (run.nudge ||= {})[rec.agent] = ev.reason || 'nudge';   // labels the message that follows
      } else if (['harness', 'compact_boundary', 'context_overflow'].includes(ev.subtype)) {
        if (ev.subtype === 'compact_boundary') (run.compactNext ||= {})[rec.agent] = true;
        list.push({ kind: 'harness', ek: rec.kinds[0], rec });
      } else {
        raw(rec.kinds[0]);
      }
      break;

    case 'assistant': {
      trackTurn(run, rec, 'out');
      const content = ev.message?.content;
      if (!Array.isArray(content)) { raw(rec.kinds[0]); break; }
      // A new model call starts here (Claude Code splits one reply over several events with one id).
      if (run.agents[rec.agent].current.outputs.length === 1) list.push({ kind: 'turn', rec, id: `turn${rec.seq}` });
      for (const b of content) {
        if (b.type === 'text') {
          if (b.text.trim()) list.push({ kind: 'text', ek: 'assistant/text', text: b.text, rec });
        } else if (b.type === 'thinking') {
          list.push({ kind: 'thinking', ek: 'assistant/thinking', text: b.thinking || '', rec });
        } else if (b.type === 'tool_use') {
          const call = {
            kind: 'call', ek: 'assistant/tool_use', rec, id: b.id, name: b.name, input: b.input || {},
            parent: ev.parent_tool_use_id || null, children: [], result: null,
            startedAt: now, endedAt: null,
          };
          run.calls[b.id] = call;
          list.push(call);
        } else {
          raw(`assistant/${b.type}`, b);
        }
      }
      break;
    }

    case 'user': {
      trackTurn(run, rec, 'in');
      const content = ev.message?.content;
      if (typeof content === 'string') {
        // Who is speaking to the model: the task, a subagent's prompt, the harness (a nudge), or
        // the summary that replaces older turns after a compaction.
        const n = (run.promptCount ||= {})[rec.agent] = (run.promptCount[rec.agent] || 0) + 1;
        const nudge = run.nudge?.[rec.agent];
        const role = run.compactNext?.[rec.agent] ? 'compacted' : nudge ? 'nudge' : n > 1 ? 'harness' : rec.agent === 'main' ? 'task' : 'subagent';
        if (run.compactNext) run.compactNext[rec.agent] = false;
        if (nudge) run.nudge[rec.agent] = null;
        list.push({ kind: 'prompt', ek: 'user/prompt', text: content, rec, id: `${rec.seq}.0`, role, why: nudge });
        break;
      }
      if (!Array.isArray(content)) { raw(rec.kinds[0]); break; }
      for (const b of content) {
        const call = b.type === 'tool_result' && run.calls[b.tool_use_id];
        if (call) {
          call.result = { text: resultText(b.content), isError: !!b.is_error, rec };
          call.endedAt = now;
        } else if (b.type === 'text' && ev.parent_tool_use_id) {
          // a subagent's prompt can also arrive as a text block
          list.push({ kind: 'prompt', ek: 'user/text', text: b.text, rec, id: `${rec.seq}.${part++}` });
        } else {
          raw(`user/${b.type}`, b);   // incl. a tool_result whose call we never saw
        }
      }
      break;
    }

    case 'result':
      run.result = ev;
      run.sessionId = ev.session_id || run.sessionId;
      run.endedAt = Date.now();
      if (ev.is_error || ev.subtype !== 'success') {
        run.status = 'failed';
        run.error = ev.result || (ev.errors || []).join('\n') || ev.subtype;
      } else {
        run.status = 'finished';
      }
      break;   // rendered by the status line

    case '_server':
      if (ev.subtype === 'start') { run.serverRunId = ev.run_id; run.resolvedCwd = ev.cwd; }
      else if (ev.subtype === 'spawn') run.argv = ev.argv;
      else if (ev.subtype === 'stderr') run.stderr += ev.text + '\n';
      else if (ev.subtype === 'error') { fail(run, 'Error: ' + ev.message); break; }
      else if (ev.subtype === 'exit') {
        run.exit = ev;
        if (!run.result) {
          if (ev.stopped) fail(run, 'Stopped by you.');
          else fail(run, `Claude Code exited with code ${ev.code} before finishing.` + (ev.stderr ? '\n\n' + ev.stderr.trim() : ''));
        }
      }
      raw(rec.kinds[0]);
      break;

    default:
      raw(rec.kinds[0]);
  }
  // Only live runs create real sessions; a replayed fixture's session id doesn't exist on this
  // machine. A live run that crashed or was stopped after init still has a resumable session.
  if (run.sessionId && !run.replay) {
    store.sessionId = run.sessionId;
    store.sessionDirs = [run.cwd, run.resolvedCwd, run.absCwd].filter(Boolean).map(normDir);
  }
}

const normDir = d => (d || '').trim().replace(/\/+$/, '') || '/';
// Sessions belong to a directory: resume only when the typed directory is the session's,
// whether typed as before, or as its resolved absolute path.
const resumableIn = cwd => store.sessionId && store.sessionDirs.includes(normDir(cwd)) ? store.sessionId : null;

function fail(run, message) {
  run.status = 'failed';
  run.error = run.error || message;
  run.endedAt = run.endedAt || Date.now();
}

// ---------------------------------------------------------------- actions

const FILE_MODE = 'file:';

// Replay mode only: an uploaded file becomes a trace in the picker, is selected and replayed.
async function loadReplayFile(file) {
  if (!file || store.mode !== 'replay') return;
  let text;
  try { text = await file.text(); }
  catch (e) { store.fileError = `could not read ${file.name}: ${e.message || e}`; changed(); return; }
  const isJSON = l => { try { JSON.parse(l); return true; } catch { return false; } };
  if (!text.split('\n').some(l => l.trim() && isJSON(l))) {
    store.fileError = `${file.name} has no JSON lines: expected a stream-json .jsonl file`;
    changed();
    return;
  }
  store.files[file.name] = text;
  store.trace = FILE_MODE + file.name;
  store.fileError = null;
  changed();
  startReplay();
}

const replayName = trace => trace.startsWith(FILE_MODE) ? trace.slice(FILE_MODE.length) : trace;
const runTitle = run => run.replay ? `replay: ${run.replay}` : run.prompt;
const pickFile = () => document.getElementById('trace-file')?.click();

function setMode(mode) {
  store.mode = mode;
  store.fileError = null;
  changed();
}

function beginRun(run) {
  for (const r of store.runs) if (r.status !== 'running') r.folded = true;
  store.runs.push(run);
  stickToBottom = true;
  changed();
}

// Live mode: run the agent on the prompt, in the working directory.
async function submit(prompt) {
  const cwd = store.cwd.trim();
  const resume = resumableIn(cwd);
  save('cwd', cwd);
  const run = newRun(prompt, cwd, resume, null);
  beginRun(run);
  await streamRun(run, { prompt, cwd, session_id: resume });
}

// Replay mode: show every event recorded in the selected trace. No prompt, no working directory.
function startReplay() {
  if (store.mode !== 'replay' || !store.trace || store.runs.some(r => r.status === 'running')) return;
  const fromFile = store.trace.startsWith(FILE_MODE);
  const name = replayName(store.trace);
  const run = newRun('', '', null, name);
  run.replayFile = fromFile;
  beginRun(run);
  streamRun(run, { ...(fromFile ? { replay_text: store.files[name] } : { replay: name }), replay_speed: store.speed });
}

const SPEEDS = [['instant', 'Instant', 'show the whole trace at once'], ['fast', 'Fast', 'about 30 events a second'],
  ['normal', 'Normal', 'about 8 events a second']];
const replayInProgress = () => store.runs.find(r => r.status === 'running' && r.replay);

function controlReplay(run, ctl) {
  if (run?.serverRunId) fetch(`/api/runs/${run.serverRunId}/replay`, { method: 'POST', headers, body: JSON.stringify(ctl) });
}

function setSpeed(speed) {
  store.speed = speed;
  save('speed', speed);
  controlReplay(replayInProgress(), { speed });   // also applies to a replay already playing
  changed();
}

function togglePause(run) {
  run.paused = !run.paused;
  controlReplay(run, { paused: run.paused });
  changed();
}

async function streamRun(run, body) {
  try {
    const res = await fetch('/api/run', { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`server returned ${res.status}: ${await res.text()}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const lineText = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!lineText) continue;
        let ev;
        try { ev = JSON.parse(lineText); }
        catch { ev = { type: '_client', subtype: 'unparsed', text: lineText }; }
        try { handleEvent(run, ev); }
        catch (e) { console.error('failed to handle event', ev, e); }
      }
      changed();
    }
  } catch (e) {
    fail(run, 'Error: ' + (e.message || e));
  }
  if (run.status === 'running') fail(run, 'The event stream ended without a result.');
  changed();
}

function stop(run) {
  if (run.serverRunId) fetch(`/api/runs/${run.serverRunId}/stop`, { method: 'POST', headers });
}

function jumpTo(run, call) {
  run.folded = false;
  for (let p = call.parent; p; p = run.calls[p]?.parent) store.ui.agentOpen[p] = true;
  // open any parallel fork on the way down, so the call is on screen
  for (let c = call; c; c = run.calls[c.parent]) {
    const f = segments(containerFor(run, c.parent)).find(s => s.kind === 'fork' && s.calls.includes(c));
    if (f) store.ui.agentOpen[f.id] = true;
  }
  stickToBottom = false;
  rerender();
  requestAnimationFrame(() => {
    if (window.matchMedia('(max-width: 860px)').matches) store.ui.outlineOpen = false;
    rerender();
    const el = document.getElementById(callDomId(run, call));
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  });
}

function openInspector(run, seq) {
  const prev = store.ui.inspect;
  const same = prev && prev.runId === run.id;
  store.ui.inspect = {
    runId: run.id, tab: seq ? 'events' : (same ? prev.tab : 'overview'),
    q: same ? prev.q : '', kind: '', open: { ...(same ? prev.open : {}), ...(seq ? { [seq]: true } : {}) },
  };
  rerender();
  if (seq) requestAnimationFrame(() => document.getElementById('ev-' + seq)?.scrollIntoView({ block: 'center' }));
}

function downloadFile(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function toggle(map, key, def) { map[key] = !(map[key] ?? def); changed(); }

// ---------------------------------------------------------------- formatting helpers

const mdCache = new WeakMap();
function md(node) {
  if (!mdCache.has(node)) mdCache.set(node, DOMPurify.sanitize(marked.parse(node.text || '')));
  return mdCache.get(node);
}

function rel(path, run) {
  if (!path) return '';
  const base = run.absCwd;
  return base && path.startsWith(base + '/') ? path.slice(base.length + 1) : path;
}

function summarize(call, run) {
  const i = call.input || {};
  switch (call.name) {
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': return rel(i.file_path, run);
    case 'NotebookEdit': return rel(i.notebook_path, run);
    case 'Bash': return i.command;
    case 'Grep': return `"${i.pattern}"` + (i.path ? ` in ${rel(i.path, run)}` : '') + (i.glob ? ` (${i.glob})` : '');
    case 'Glob': return i.pattern + (i.path ? ` in ${rel(i.path, run)}` : '');
    case 'Task': case 'Agent': return i.description || i.prompt;
    case 'WebFetch': return i.url;
    case 'WebSearch': return i.query;
    case 'TodoWrite': return `${(i.todos || []).length} todos`;
    default: {
      const s = Object.values(i).find(v => typeof v === 'string');
      if (s != null) return s;
      // no string argument: "key: a · b" per argument instead of raw JSON
      const flat = v => Array.isArray(v) ? v.map(flat).join(' · ')
        : v && typeof v === 'object' ? Object.values(v).map(flat).join(' ') : String(v);
      return Object.entries(i).map(([k, v]) => `${k}: ${flat(v)}`).join('   ');
    }
  }
}

const oneLine = (s, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const shq = s => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;

function compactFields(o, skip = []) {
  return oneLine(Object.entries(o || {})
    .filter(([k]) => !skip.includes(k))
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join('  '), 220);
}

function blockSummary(run, b) {
  switch (b.type) {
    case 'text': return oneLine(b.text);
    case 'thinking': return oneLine(b.thinking);
    case 'tool_use': {
      const c = run.calls[b.id];
      return c ? `${callAction(c).label}: ${oneLine(summarize(c, run), 120)}` : b.name;
    }
    case 'tool_result': {
      const c = run.calls[b.tool_use_id];
      const n = resultText(b.content).split('\n').length;
      return `${b.is_error ? 'ERROR · ' : ''}result of ${c ? `${callAction(c).label}: ${oneLine(summarize(c, run), 80)}` : b.tool_use_id} · ${n} line${n === 1 ? '' : 's'}`;
    }
    default: return compactFields(b, ['type']);
  }
}

function eventSummary(run, rec, block) {
  if (block) return blockSummary(run, block);
  const ev = rec.ev;
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init') {
        return `${ev.model} · ${(ev.tools || []).length} tools · ${(ev.mcp_servers || []).length} MCP servers · ${ev.permissionMode || ''} · ${ev.cwd}`;
      }
      return compactFields(ev, ['type', 'subtype', 'session_id', 'uuid', 'parent_tool_use_id']);
    case 'assistant': case 'user': {
      const c = ev.message?.content;
      if (typeof c === 'string') return oneLine(c);
      return (c || []).map(b => blockSummary(run, b)).join('  |  ');
    }
    case 'result':
      return [ev.subtype, ev.total_cost_usd != null && fmtCost(ev.total_cost_usd),
        ev.num_turns != null && `${ev.num_turns} turns`, ev.duration_ms != null && fmtDuration(ev.duration_ms)]
        .filter(Boolean).join(' · ');
    case '_server':
      switch (ev.subtype) {
        case 'start': if (ev.replay) return `replay ${ev.run_id}`;
          return `run ${ev.run_id} in ${ev.cwd}${ev.resume ? ` · resume ${short(ev.resume)}` : ' · new session'}`;
        case 'spawn': return `pid ${ev.pid} · ` + (ev.argv || []).map(shq).join(' ');
        case 'stderr': case 'stdout': return ev.text;
        case 'exit': return `exit code ${ev.code}${ev.stopped ? ' (stopped)' : ''}`;
        case 'error': return ev.message;
      }
      return compactFields(ev, ['type', 'subtype']);
    case '_client': return ev.text;
    default: return compactFields(ev, ['type', 'subtype', 'session_id', 'uuid']);
  }
}

// ---- action labels: what a call *does*, so twenty Bash calls don't all read "Bash"

const TOOL_ACTIONS = {
  Read: ['Read', 'read'], NotebookRead: ['Read', 'read'],
  Write: ['Write', 'edit'], Edit: ['Edit', 'edit'], MultiEdit: ['Edit', 'edit'], NotebookEdit: ['Edit', 'edit'],
  Grep: ['Search', 'search'], Glob: ['Find files', 'search'], LS: ['List', 'read'],
  Task: ['Subagent', 'agent'], Agent: ['Subagent', 'agent'],
  WebFetch: ['Fetch', 'web'], WebSearch: ['Web search', 'web'],
  TodoWrite: ['Plan', 'plan'], ExitPlanMode: ['Plan', 'plan'],
  BashOutput: ['Shell output', 'run'], KillShell: ['Stop shell', 'run'], KillBash: ['Stop shell', 'run'],
};

const BASH_FIRST_WORD = {
  read: ['Read', 'read', 'cat head tail less more bat nl wc file stat diff cmp xxd hexdump'],
  list: ['List', 'read', 'ls tree pwd du df'],
  search: ['Search', 'search', 'grep egrep rg ag ack'],
  find: ['Find files', 'search', 'find fd locate which whereis'],
  files: ['Files', 'edit', 'mkdir rm rmdir mv cp touch chmod chown ln'],
  install: ['Install', 'install', 'pip pip3 apt apt-get brew poetry conda'],
  run: ['Run', 'run', 'python python3 node deno bun ruby go cargo make bash sh zsh java'],
};
const FIRST_WORD = {};
for (const [label, cat, words] of Object.values(BASH_FIRST_WORD)) for (const w of words.split(' ')) FIRST_WORD[w] = [label, cat];

function bashAction(cmd = '') {
  const segs = cmd.split(/&&|\|\||;|\n/).map(s => s.trim()).filter(Boolean);
  let seg = segs.find(s => !/^(cd|export|source|set|\.)\b/.test(s)) || segs[0] || '';
  seg = seg.replace(/^(\w+=\S*\s+)+/, '').replace(/^(sudo|time|nice|env|timeout\s+\S+)\s+/, '');
  const words = seg.split(/\s+/);
  const rawFirst = words[0] || '';
  const first = rawFirst.replace(/^.*\//, '');
  // output redirected into a file (ignoring 2>&1 and /dev/null)
  const writes = /[^0-9&]>>?\s*[\w./~"'-]/.test(' ' + cmd.replace(/\d?>&\d|\d?>\s*\/dev\/null/g, ''));

  if (/\b(pytest|unittest|jest|vitest|mocha|tox)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(go|cargo)\s+test\b|\bmake\s+(test|check)\b/.test(cmd)) return ['Test', 'test'];
  if (first === 'git') {
    let sub = '';
    for (let i = 1; i < words.length; i++) {
      if (/^-[Cc]$/.test(words[i])) { i++; continue; }  // -C <dir>, -c <key=val>
      if (!words[i].startsWith('-')) { sub = words[i]; break; }
    }
    return [`Git ${sub}`.trim(), 'git'];
  }
  if (/\bsed\s+(-\S+\s+)*-i|\bperl\s+-\S*i/.test(cmd)) return ['Edit', 'edit'];
  if (writes || /\btee\b/.test(cmd)) return ['Write', 'edit'];
  if (/\b(npm|pnpm|yarn|bun)\s+(install|add|ci)\b|\buv\s+(pip|add|sync)\b/.test(cmd)) return ['Install', 'install'];
  if (/\bpython3?\s+-c\b/.test(seg)) return ['Run', 'run'];
  if (FIRST_WORD[first]) return FIRST_WORD[first];
  if (/^\.{0,2}\//.test(rawFirst)) return ['Run', 'run'];
  return ['Shell', 'run'];
}

const actionCache = new WeakMap();
function callAction(call) {
  if (actionCache.has(call)) return actionCache.get(call);
  let label, cat, via = call.name;
  if (call.name === 'Bash') [label, cat] = bashAction(call.input?.command);
  else if (TOOL_ACTIONS[call.name]) [label, cat] = TOOL_ACTIONS[call.name];
  else if (call.name.startsWith('mcp__')) {
    const [, server, ...rest] = call.name.split('__');
    label = rest.join('__').replace(/[_-]+/g, ' '); cat = 'tool'; via = `tool call · ${server}`;
  } else { label = call.name; cat = 'tool'; via = 'tool call'; }
  const a = { label, cat, via: via === label ? null : via };
  actionCache.set(call, a);
  return a;
}

const callDomId = (run, call) => `call-${run.id}-${call.id}`;  // tool ids repeat across replays
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const isAgentCall = c => c.name === 'Task' || c.name === 'Agent' || c.children.length > 0;
// A call without a result is pending only while its run is still going; after the run ends
// (stopped, crashed, failed) it can never get one, so it reads as interrupted.
const callStatus = (c, run) => c.result ? (c.result.isError ? 'error' : 'ok')
  : run && run.status !== 'running' ? 'interrupted' : 'pending';

function agentLabel(run, agent) {
  if (agent === 'main') return 'main';
  const c = run.calls[agent];
  return 'sub: ' + oneLine(c ? summarize(c, run) : short(agent), 28);
}

// Subagent calls the model issued together (same assistant message, or the second started
// before the first finished) run in parallel. Group each such set into one 'fork' segment so
// the dialogue and the outline can draw them as parallel branches. Events without a parent
// (rate limits, hooks) that land between two parallel calls are moved after the fork.
const msgId = c => c.rec.ev.message?.id;
const parallelTo = (a, b) => msgId(a) && msgId(b) ? msgId(a) === msgId(b)
  : !a.result || b.rec.seq < a.result.rec.seq;
function segments(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (n.kind !== 'call' || !isAgentCall(n)) { out.push(n); continue; }
    const group = [n], between = [];
    let j = i + 1;
    for (; j < list.length; j++) {
      const m = list[j];
      if (m.kind === 'raw') { between.push(m); continue; }
      if (m.kind === 'call' && isAgentCall(m) && parallelTo(n, m)) { group.push(m); continue; }
      break;
    }
    if (group.length < 2) { out.push(n); continue; }
    out.push({ kind: 'fork', id: 'fork-' + n.id, calls: group }, ...between);
    i = j - 1;
  }
  return out;
}
const forkStatus = (f, run) => {
  const st = f.calls.map(c => callStatus(c, run));
  return st.includes('pending') ? 'pending' : st.includes('error') ? 'error'
    : st.includes('interrupted') ? 'interrupted' : 'ok';
};

function countNodes(list) {
  let n = 0;
  for (const x of list) { if (x.kind === 'turn') continue; n++; if (x.children) n += countNodes(x.children); }
  return n;
}
function allCalls(list, out = []) {
  for (const x of list) if (x.kind === 'call') { out.push(x); allCalls(x.children, out); }
  return out;
}

function fmtDuration(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  return `${Math.floor(s / 60)} m ${Math.round(s % 60)} s`;
}
function fmtCost(usd) { return '$' + (usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)); }
const fmtNum = n => n == null ? '–' : Number(n).toLocaleString();
const short = id => id ? id.slice(0, 8) + '…' : '';

// ---------------------------------------------------------------- dialogue components

function StatusIcon({ status }) {
  if (status === 'pending') return html`<span class="icon pending" title="pending"><span class="spin"></span></span>`;
  if (status === 'error') return html`<span class="icon bad" title="error">✕</span>`;
  if (status === 'interrupted') return html`<span class="icon interrupted" title="no result: the run ended first">⊘<span class="word"> interrupted</span></span>`;
  return html`<span class="icon ok" title="done">✓</span>`;
}

const PROMPT_LABELS = {
  task: 'task → agent', subagent: 'prompt → subagent', harness: 'harness → model', nudge: '⚙ harness nudge → model',
  compacted: 'compacted context → model (replaces the issue and older turns)',
};

function SeqLink({ run, seq }) {
  return html`<span class="seq" role="button" title="open this event in the inspector"
    onClick=${e => { e.stopPropagation(); openInspector(run, seq); }}>#${seq}</span>`;
}

// The round (model call) an event belongs to, as a link that opens it in the chat view.
function RoundGo({ run, rec, focus, label }) {
  const r = rec && roundOfRec(run, rec);
  if (!r) return null;
  return html`<span class="rd-go" role="button" title="open this model call: exactly what it was sent and what it returned"
    onClick=${e => { e.stopPropagation(); e.preventDefault(); openRound(run, r.n, focus ? focus(r) : `chat-${r.n}-out`); }}>${label || `R${r.n} ›`}</span>`;
}

// One model call starts: the harness has sent a request, and what follows is the reply.
function TurnDivider({ run, node }) {
  const r = roundOfRec(run, node.rec);
  const u = node.rec.ev.message?.usage || {};
  const who = node.rec.agent === 'main' ? null : r ? roundAgent(run, r) : 'subagent';
  return html`<div class="turn-div" role="button" onClick=${() => r && openRound(run, r.n, `chat-${r.n}-out`)}
    title="open this model call as a chat: the exact messages it was sent, and its reply">
    <${ActorChip} a="llm" /><b>${r ? `round ${r.n}` : 'model call'}</b>
    <span class="turn-meta">${who ? `${who} · ` : ''}${u.input_tokens != null ? `${fmtNum(u.input_tokens)} tokens in → ${fmtNum(u.output_tokens)} out` : ''}</span>
    <span class="turn-line"></span><span class="turn-open">view input & output ›</span>
  </div>`;
}

// Who wrote a message to the model that shows up in the dialogue as a prompt.
const promptActor = (run, role) => role === 'subagent' && !isHarnessTrace(run) ? 'llm' : 'harness';

function Items({ run, list }) {
  return segments(list).map(node => {
    if (node.kind === 'fork') return html`<${Fork} run=${run} fork=${node} key=${node.id} />`;
    if (node.kind === 'turn') return shown('assistant/tool_use') || shown('assistant/text') ? html`<${TurnDivider} run=${run} node=${node} key=${node.id} />` : null;
    if (!shown(node.ek)) return null;
    if (node.kind === 'text') return html`<div class="llm-say"><${RoundGo} run=${run} rec=${node.rec} /><div class="md" dangerouslySetInnerHTML=${{ __html: md(node) }} /></div>`;
    if (node.kind === 'thinking') return html`<details class="thinking llm"><summary>thinking <${RoundGo} run=${run} rec=${node.rec} /> <${SeqLink} run=${run} seq=${node.rec.seq} /></summary><pre>${node.text || '(empty)'}</pre></details>`;
    if (node.kind === 'prompt') {
      const a = promptActor(run, node.role);
      return html`<div class="sub-prompt actor-${a} ${node.role || ''}"><div class="sub-prompt-label"><${ActorChip} a=${a} /> ${PROMPT_LABELS[node.role] || 'prompt → subagent'}${node.why && node.why !== 'nudge' ? ` · ${node.why.replace(/_/g, ' ')}` : ''} <${SeqLink} run=${run} seq=${node.rec.seq} /></div><${Folded} id=${'p' + node.rec.seq} text=${node.text} /></div>`;
    }
    if (node.kind === 'sysprompt') return html`<details class="sysprompt"><summary><${ActorChip} a="harness" /> system prompt${node.rec.ev.agent ? ` · ${node.rec.ev.agent}` : ''} · ${plural(node.text.split('\n').length, 'line')} <${SeqLink} run=${run} seq=${node.rec.seq} /></summary><pre>${node.text}</pre></details>`;
    if (node.kind === 'harness') return html`<${HarnessLine} run=${run} rec=${node.rec} compact=${true} />`;
    if (node.kind === 'raw') return html`<${RawEvent} run=${run} node=${node} key=${node.id} />`;
    return html`<${Call} run=${run} call=${node} key=${node.id} />`;
  });
}

function RawEvent({ run, node }) {
  const open = store.ui.rawOpen[node.id];
  const obj = node.block || node.rec.ev;
  const group = node.ek.split('/')[0];
  return html`
    <div class="raw-ev g-${group} ${node.ek === 'server/stderr' ? 'stderr' : ''}">
      <div class="raw-head" role="button" onClick=${() => toggle(store.ui.rawOpen, node.id, false)}>
        <span class="raw-caret">${open ? '▾' : '▸'}</span>
        <span class="raw-kind">${node.ek}</span>
        <span class="raw-sum">${eventSummary(run, node.rec, node.block)}</span>
        <${SeqLink} run=${run} seq=${node.rec.seq} />
      </div>
      ${open && html`<pre class="json">${JSON.stringify(obj, null, 2)}</pre>`}
    </div>`;
}

function Call({ run, call }) {
  const status = callStatus(call, run);
  const agent = isAgentCall(call);
  const hasDiff = call.name === 'Edit' || call.name === 'MultiEdit';
  const inputOpen = store.ui.inputOpen[call.id] ?? hasDiff;
  const took = call.endedAt ? fmtDuration(call.endedAt - call.startedAt) : '';
  const act = callAction(call);
  const round = roundOfCall(run, call.id);
  const toggleInput = e => { e?.stopPropagation(); toggle(store.ui.inputOpen, call.id, hasDiff); };
  // Clicking a call opens the model call that asked for it; the caret shows its input in place.
  const open = () => round ? openRound(run, round.n, `chat-${round.n}-call-${call.id}`) : toggleInput();
  return html`
    <div class="call ${status} ${agent ? 'agent' : ''}" id=${callDomId(run, call)}>
      <div class="call-head" role="button" onClick=${open}
        title=${round ? `open round ${round.n}: the exact input the LLM was sent, its output, and what the harness did` : 'show / hide input'}>
        <button class="caret" title="show / hide the input here" onClick=${toggleInput}>${inputOpen ? '▾' : '▸'}</button>
        ${agent && html`<span class="lane" title=${`subagent ${laneOf(run, call)}, started by ${ownerText(ownerOf(run, call))}`}>${laneOf(run, call)}</span>`}
        <span class="action cat-${act.cat}">${act.label}</span>
        ${act.via && html`<span class="via">${act.via === 'Bash' ? 'via Bash' : act.via}</span>`}
        <span class="summary">${summarize(call, run)}</span>
        ${took && html`<span class="took">${took}</span>`}
        ${round && html`<span class="rd-go" title="the round (model call) that made this call">R${round.n}</span>`}
        <${SeqLink} run=${run} seq=${call.rec.seq} />
        <${StatusIcon} status=${status} />
      </div>
      ${inputOpen && html`<${InputDetail} call=${call} />`}
      ${call.harness?.length > 0 && shown('system/harness') && html`<div class="call-harness">
        ${call.harness.map(rec => html`<${HarnessLine} run=${run} rec=${rec} />`)}</div>`}
      ${agent && html`<${AgentGroup} run=${run} call=${call} />`}
      ${call.result && shown('user/tool_result') && html`<${Result} run=${run} call=${call} />`}
    </div>`;
}

function InputDetail({ call }) {
  const i = call.input;
  if (call.name === 'Edit' || call.name === 'MultiEdit') {
    const edits = call.name === 'Edit' ? [i] : (i.edits || []);
    return html`<div class="detail">${edits.map(e => html`<${Diff} oldText=${e.old_string} newText=${e.new_string} />`)}</div>`;
  }
  if (call.name === 'TodoWrite') {
    const mark = { completed: '☑', in_progress: '◐', pending: '☐' };
    return html`<ul class="detail todos">${(i.todos || []).map(t =>
      html`<li class=${t.status}>${mark[t.status] || '☐'} ${t.content}</li>`)}</ul>`;
  }
  if (call.name === 'Bash' && i.description) {
    return html`<div class="detail"><div class="desc">${i.description}</div><pre>${i.command}</pre></div>`;
  }
  return html`<div class="detail"><${ArgsBox} k=${'in' + call.id} open=${store.ui.rawOpen} value=${i}
    raw=${call.rec.ev.message?.content?.find?.(b => b.id === call.id)?.raw_arguments} /></div>`;
}

// Tool-call arguments for reading: one row per argument, strings with their real line breaks
// (no \n or \" escapes). The exact JSON stays one click away.
function ArgValue({ v }) {
  if (v === null || typeof v !== 'object') {
    if (typeof v !== 'string') return html`<span class="av-lit">${JSON.stringify(v)}</span>`;
    if (v === '') return html`<span class="av-lit">""</span>`;
    return v.includes('\n') || v.length > 90 ? html`<pre class="av-text">${v}</pre>` : html`<span class="av-str">${v}</span>`;
  }
  if (Array.isArray(v)) {
    if (!v.length) return html`<span class="av-lit">[]</span>`;
    return html`<ol class="av-list">${v.map(x => html`<li><${ArgValue} v=${x} /></li>`)}</ol>`;
  }
  const keys = Object.keys(v);
  if (!keys.length) return html`<span class="av-lit">{}</span>`;
  return html`<div class="args">${keys.map(k => html`<div class="av-k">${k}</div><div class="av-v"><${ArgValue} v=${v[k]} /></div>`)}</div>`;
}

function ArgsBox({ k, open, value, raw }) {
  const showRaw = open[k];
  const exact = typeof raw === 'string' ? raw : JSON.stringify(value, null, 2);
  return html`<div class="args-box">
    ${showRaw ? html`<pre class="json">${exact}</pre>`
      : value && typeof value === 'object' && !Array.isArray(value) ? html`<${ArgValue} v=${value} />`
      : html`<div class="args"><div class="av-k">value</div><div class="av-v"><${ArgValue} v=${value} /></div></div>`}
    <button class="link small av-raw" onClick=${e => { e.stopPropagation(); toggle(open, k, false); }}>
      ${showRaw ? 'readable view' : typeof raw === 'string' ? 'raw JSON, exactly as sent' : 'raw JSON'}</button>
  </div>`;
}

function Diff({ oldText = '', newText = '' }) {
  const cap = (s) => { const l = s.split('\n'); return l.length > 40 ? [...l.slice(0, 40), `… ${l.length - 40} more lines`] : l; };
  return html`<pre class="diff">${cap(oldText).map(l => html`<div class="del">- ${l}</div>`)}${cap(newText).map(l => html`<div class="add">+ ${l}</div>`)}</pre>`;
}

// Parallel subagents: one 'Tasks' node, each subagent a branch hanging off a tree rail.
const LANES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
// Every subagent gets a name: A, B, C... in the order the main agent started them, and
// A.1, A.2... for the subagents subagent A started. Cached until the run gets new events.
function agentNames(run) {
  if (run._names?.len === run.events.length) return run._names.map;
  const map = new Map();
  const walk = (list, owner) => {
    let k = 0;
    for (const n of list) {
      if (n.kind !== 'call') continue;
      if (isAgentCall(n)) {
        const name = owner ? `${owner}.${k + 1}` : (k < 26 ? LANES[k] : 'Z' + (k - 25));
        k++;
        map.set(n.id, name);
        walk(n.children, name);
      } else walk(n.children, owner);
    }
  };
  walk(run.root, null);
  run._names = { len: run.events.length, map };
  return map;
}
const laneOf = (run, c) => agentNames(run).get(c.id) || '?';
// who dispatched this call: the main agent, or the subagent it runs inside
function ownerOf(run, c) {
  for (let p = run.calls[c.parent]; p; p = run.calls[p.parent]) if (isAgentCall(p)) return { main: false, name: laneOf(run, p) };
  return { main: true, name: 'main agent' };
}
const ownerText = o => o.main ? 'the main agent' : `subagent ${o.name}`;
function OwnerBadge({ o }) {
  return o.main ? html`<span class="who-main">main agent</span>`
    : html`<span class="who-main who-sub">subagent <span class="lane">${o.name}</span></span>`;
}
const subType = c => c.input?.subagent_type || 'general-purpose';
const tookOf = c => c.endedAt ? fmtDuration(c.endedAt - c.startedAt) : '';

// Parallel subagents. The main agent dispatches them in one turn (fork node), each runs as its
// own branch (lane A, B, ...), each branch's report returns to the main agent, and the branches
// converge in a join node after which the main agent continues.
function Fork({ run, fork }) {
  if (!shown('assistant/tool_use')) return html`<${Items} run=${run} list=${fork.calls.flatMap(c => c.children)} />`;
  const open = store.ui.agentOpen[fork.id] ?? true;
  const status = forkStatus(fork, run);
  const k = fork.calls.length;
  const back = fork.calls.filter(c => c.result).length;
  const n = fork.calls.reduce((m, c) => m + 1 + countNodes(c.children), 0);
  const ended = run.status !== 'running';
  const owner = ownerOf(run, fork.calls[0]);
  return html`
    <div class="fork ${status} ${open ? 'open' : ''}">
      <div class="fork-head" role="button" onClick=${() => toggle(store.ui.agentOpen, fork.id, true)}
        title=${`${ownerText(owner)} started these subagents in one turn; they run in parallel`}>
        <span class="fork-caret">${open ? '▾' : '▸'}</span>
        <${OwnerBadge} o=${owner} />
        <span class="fork-verb">⑂ dispatches ${k} <span class="long">subagents </span>in parallel</span>
        <span class="fork-lanes">${fork.calls.map(c => html`<span class="lane">${laneOf(run, c)}</span>`)}</span>
        ${open ? html`<span class="summary"></span>` : html`<span class="summary fork-collapsed">· ${plural(n, 'event')} collapsed</span>`}
        <${SeqLink} run=${run} seq=${fork.calls[0].rec.seq} />
        <${StatusIcon} status=${status} />
      </div>
      ${open && html`<div class="fork-branches">
        ${fork.calls.map(c => {
          const st = callStatus(c, run), L = laneOf(run, c);
          return html`<div class="branch" key=${c.id}>
            <${Call} run=${run} call=${c} />
            <div class="branch-ret ${st}">${
              st === 'ok' || st === 'error' ? html`↩ ${L} returned its report to ${ownerText(owner)}${tookOf(c) && ` · after ${tookOf(c)}`}${st === 'error' ? ' (error)' : ''}`
              : st === 'pending' ? html`<span class="spin"></span> ${L} still working…`
              : html`⊘ ${L} never returned (run ended)`}</div>
          </div>`;
        })}
      </div>`}
      <div class="fork-join ${status}">
        <span class="join-dot"></span>
        <${OwnerBadge} o=${owner} />
        ${back === k ? html`<span>⤶ joins all ${k} reports and continues</span>`
          : ended ? html`<span>⤶ got ${back} of ${k} reports before the run ended</span>`
          : html`<span>⤶ waiting for reports · ${back}/${k} back</span>`}
      </div>
    </div>`;
}

function AgentGroup({ run, call }) {
  const lane = laneOf(run, call);
  const open = store.ui.agentOpen[call.id] ?? !call.result; // open while it runs (or if cut off), folds when done
  const n = countNodes(call.children);
  const who = `subagent ${lane}`;
  return html`
    <div class="agent-group ${open ? 'open' : ''}">
      <button class="agent-toggle" onClick=${() => toggle(store.ui.agentOpen, call.id, !call.result)}>
        ${open ? '▾' : '▸'} ${who}'s own events · ${plural(n, 'event')}${open ? '' : ' collapsed'}
      </button>
      ${open && html`<div class="agent-body">
        <div class="lane-tag"><span class="lane">${lane}</span> inside ${who} (${subType(call)}), started by ${ownerText(ownerOf(run, call))}</div>
        <${Items} run=${run} list=${call.children} />
      </div>`}
    </div>`;
}

const HEAD = 6, TAIL = 4, LIMIT = 14, MAXLINE = 300;

// Long text: first HEAD and last TAIL lines, with the middle folded.
function Folded({ id, text, cls = '' }) {
  const raw = (text || '').replace(/\n+$/, '');
  if (!raw) return html`<div class="folded empty ${cls}">(empty)</div>`;
  const lines = raw.split('\n');
  const open = store.ui.resultOpen[id];
  const clip = l => l.length > MAXLINE ? l.slice(0, MAXLINE) + ' …' : l;
  if (lines.length <= LIMIT) return html`<pre class="folded ${cls}">${open ? raw : lines.map(clip).join('\n')}</pre>`;
  if (open) {
    return html`<div class="folded ${cls}">
      <pre class="full">${raw}</pre>
      <button class="fold-btn" onClick=${() => toggle(store.ui.resultOpen, id)}>▴ fold ${lines.length} lines</button>
    </div>`;
  }
  return html`<div class="folded ${cls}">
    <pre>${lines.slice(0, HEAD).map(clip).join('\n')}</pre>
    <button class="fold-btn" onClick=${() => toggle(store.ui.resultOpen, id)}>▸ ${lines.length - HEAD - TAIL} more lines, folded</button>
    <pre>${lines.slice(-TAIL).map(clip).join('\n')}</pre>
  </div>`;
}

// Where a tool result went: the next model call of the same agent, if the result was in it.
function resultDest(run, call) {
  const r = roundOfCall(run, call.id);
  const m = r?.results[call.id];
  const nr = m && nextRound(run, r);
  return nr && nr.msgs.includes(m) ? { r: nr, id: msgDomId(nr, m, run) } : null;
}

function Result({ run, call }) {
  const r = call.result;
  const dest = resultDest(run, call);
  const actor = resultActor(run, call.id);
  const link = html`<span class="result-seq">${dest && html`<span class="rd-go" role="button"
      title=${`this result is sent back to the model in round ${dest.r.n}: open that call`}
      onClick=${e => { e.stopPropagation(); openRound(run, dest.r.n, dest.id); }}>→ R${dest.r.n}</span>`}<${SeqLink} run=${run} seq=${r.rec.seq} /></span>`;
  const subReport = isAgentCall(call) && !isHarnessTrace(run);
  if (subReport && !r.isError && r.text.trim()) {
    // Long reports are clipped to a few lines (markdown can't be cut mid-way safely, so clip visually).
    const long = r.text.split('\n').length > LIMIT || r.text.length > 900;
    const open = store.ui.resultOpen[call.id];
    return html`<div class="result agent-report actor-${actor}">${link}
      <div class="report-label">↩ subagent ${laneOf(run, call)}'s report, handed back to ${ownerText(ownerOf(run, call))}</div>
      <div class="md ${long && !open ? 'clipped' : ''}" dangerouslySetInnerHTML=${{ __html: md(r) }} />
      ${long && html`<button class="fold-btn" onClick=${() => toggle(store.ui.resultOpen, call.id)}>
        ${open ? '▴ fold report' : `▸ full report (${r.text.split('\n').length} lines), folded`}</button>`}
    </div>`;
  }
  return html`<div class="result actor-${actor} ${r.isError ? 'error' : ''}">${link}
    ${actor === 'harness' ? html`<div class="report-label harness-label">⚙ written by the harness in place of the tool's result${isAgentCall(call) ? ` (after subagent ${laneOf(run, call)}'s review)` : ''}</div>`
      : subReport && html`<div class="report-label">↩ subagent ${laneOf(run, call)}'s ${r.isError ? 'error' : 'report'}, handed back to ${ownerText(ownerOf(run, call))}</div>`}
    <${NotedText} id=${call.id} text=${r.text || '(no output)'} /></div>`;
}

function Numbers({ run }) {
  const r = run.result;
  if (!r) return null;
  return html`<span class="numbers">
    ${r.total_cost_usd != null && html`<b>${fmtCost(r.total_cost_usd)}</b> · `}
    ${r.duration_ms != null && html`<b>${fmtDuration(r.duration_ms)}</b> · `}
    ${r.num_turns != null && html`<b>${r.num_turns}</b> turns · `}
    <button class="sid" title=${'copy ' + r.session_id} onClick=${() => navigator.clipboard?.writeText(r.session_id)}>session ${short(r.session_id)}</button>
  </span>`;
}

function RunStatus({ run }) {
  if (run.status === 'running') {
    const calls = allCalls(run.root);
    const pending = calls.filter(c => !c.result).length;
    return html`<div class="run-status running">
      ${run.paused ? '⏸ paused' : html`<span class="spin"></span> running`} · ${fmtDuration(Date.now() - run.startedAt)} · ${plural(calls.length, 'tool call')}${pending ? ` · ${pending} pending` : ''} · ${plural(run.events.length, 'event')}
      <button class="stop" onClick=${() => stop(run)}>Stop</button>
    </div>`;
  }
  if (run.status === 'finished') {
    return html`<div class="run-status finished"><span class="badge">✓ finished</span> <${Numbers} run=${run} /></div>`;
  }
  return html`<div class="run-status failed">
    <div><span class="badge">✕ failed</span> <${Numbers} run=${run} /></div>
    <pre class="err">${run.error}</pre>
  </div>`;
}

function StatusChip({ run }) {
  if (run.status === 'running' && run.paused) return html`<span class="chip stopped">⏸ paused</span>`;
  if (run.status === 'running') return html`<span class="chip running"><span class="spin"></span> running</span>`;
  if (run.status === 'finished') return html`<span class="chip finished">✓ finished</span>`;
  if (run.exit?.stopped) return html`<span class="chip stopped">stopped</span>`;
  return html`<span class="chip failed">✕ failed</span>`;
}

// The run's outcome at a glance, at the top of the run: status, size, cost, and any failures.
function RunStats({ run }) {
  const calls = allCalls(run.root);
  const failed = calls.filter(c => callStatus(c, run) === 'error');
  const r = run.result;
  // A replay's own wall clock is just the replay speed; only the recorded duration means anything.
  const ms = r?.duration_ms ?? (run.replay ? null : (run.endedAt || Date.now()) - run.startedAt);
  const turns = r?.num_turns ?? (run.turns.filter(t => t.agent === 'main').length || null);
  return html`<div class="stats">
    ${ms != null && html`<span><b>${fmtDuration(ms)}</b> duration</span>`}
    ${turns != null && html`<span><b>${turns}</b> ${turns === 1 ? 'turn' : 'turns'}</span>`}
    <span><b>${calls.length}</b> tool ${calls.length === 1 ? 'call' : 'calls'}</span>
    ${r?.total_cost_usd != null && html`<span><b>${fmtCost(r.total_cost_usd)}</b> cost</span>`}
    ${failed.length
      ? html`<button class="stat-err" onClick=${() => jumpTo(run, failed[0])} title="scroll to the first failed tool call">
          ✕ ${plural(failed.length, 'failed tool call')} · jump to first ›</button>`
      : run.status !== 'running' && calls.length > 0 && html`<span class="stat-ok">✓ no failed tool calls</span>`}
  </div>`;
}

function Run({ run }) {
  const n = countNodes(run.root);
  const finalText = run.result?.result;
  return html`
    <section class="run" id=${'run-' + run.id}>
      <div class="you">
        <div class="you-top">
          <div class="who">${run.replay ? 'Replay' : 'You'}</div>
          <${StatusChip} run=${run} />
          <span class="grow"></span>
          <button class="inspect-btn" onClick=${() => openInspector(run)} title="inputs, outputs and every raw event of this run">
            inspect · ${plural(run.events.length, 'event')}
          </button>
        </div>
        <div class="prompt">${run.replay ? html`<code>${run.replay}</code>` : run.prompt}</div>
        <div class="meta">
          ${run.replay ? (run.replayFile ? 'uploaded file' : 'example in fixtures/') : run.cwd || '.'}
          ${run.resume && html` · resumed session ${short(run.resume)}`}
          ${run.model && html` · ${run.model}`}
        </div>
        <${RunStats} run=${run} />
        ${run.turns.length > 0 && html`<div class="actor-legend"><${ChatLegend} />
          <span class="small muted">Click a tool call or a round to see exactly what the LLM was sent and what it returned.</span></div>`}
      </div>
      ${run.folded
        ? html`
          ${n > 0 && html`<button class="fold-btn run-fold" onClick=${() => { run.folded = false; changed(); }}>▸ ${plural(n, 'event')}, folded</button>`}
          ${run.status === 'finished' && finalText && html`<div class="md" dangerouslySetInnerHTML=${{ __html: md({ text: finalText }) }} />`}`
        : html`
          ${run.status !== 'running' && n > 0 && html`<button class="fold-btn run-fold" onClick=${() => { run.folded = true; changed(); }}>▾ fold ${plural(n, 'event')}</button>`}
          <${Items} run=${run} list=${run.root} />`}
      <${RunStatus} run=${run} />
    </section>`;
}

const olName = c => c.name.startsWith('mcp__') ? c.name.split('__').slice(2).join('__') : c.name;

// Width (px) a fork needs when drawn as side-by-side columns: every column is at least one
// pill wide, or as wide as the widest fork nested anywhere inside it.
const COL_MIN = 64, COL_GAP = 6;
// rough pill width: monospace 11px name, padding, and the lane badge
const pillW = (run, c) => 24 + 7 * olName(c).length + (isAgentCall(c) ? 18 + 6.5 * laneOf(run, c).length : 0);
function nestedNeed(run, list) {
  let w = 0;
  for (const seg of segments(list)) {
    if (seg.kind === 'fork') w = Math.max(w, forkNeed(run, seg));
    else if (seg.kind === 'call') w = Math.max(w, Math.min(pillW(run, seg), 120), nestedNeed(run, seg.children));
  }
  return w;
}
const colNeed = (run, c) => Math.ceil(Math.max(COL_MIN, pillW(run, c), nestedNeed(run, c.children)));
const forkNeed = (run, f) => f.calls.reduce((w, c) => w + colNeed(run, c), 0) + COL_GAP * (f.calls.length - 1);

// Outline rows for one list of nodes. In the main column calls are rows indented by depth. A set
// of parallel subagents forks into side-by-side columns that join again below; when the columns
// would not fit in `room` px, the branches are stacked on a tree rail instead.
function olList(run, list, depth, compact, room, ctx) {
  const rows = [];
  const indent = compact ? 0 : depth * 14;
  for (const seg of segments(list)) {
    if (seg.kind === 'fork') {
      const status = forkStatus(seg, run);
      const need = forkNeed(run, seg);
      const cols = need <= room - indent;
      if (cols) ctx.width = Math.max(ctx.width, ctx.offset + indent + need);
      const head = html`<button class="ol-fork-head ${status}" title=${`${seg.calls.length} subagents in parallel`}
        onClick=${() => jumpTo(run, seg.calls[0])}><span class="dot"></span>${ownerOf(run, seg.calls[0]).main ? 'main' : html`<b class="ol-lane">${ownerOf(run, seg.calls[0]).name}</b>`} ⑂ <span class="ol-x">dispatch ×${seg.calls.length}</span></button>`;
      const back = seg.calls.filter(c => c.result).length;
      const join = html`<div class="ol-join ${status}" title="the subagents' reports return to the main agent">⤶ join ${back}/${seg.calls.length}</div>`;
      rows.push(html`<div class="ol-fork ${cols ? 'cols' : 'stack'}" key=${seg.id}
          style=${compact ? '' : `margin-left:${0.6 * 16 + indent}px`}>
        ${head}
        ${cols
          ? html`<div class="ol-cols">${seg.calls.map(c => html`
              <div class="ol-col" key=${c.id} style=${`min-width:${colNeed(run, c)}px`}><i class="ol-line"></i>
                ${olPill(run, c, laneOf(run, c))}${olList(run, c.children, 0, true, colNeed(run, c), { width: 0, offset: 0 })}</div>`)}</div>${join}`
          : html`<div class="ol-stack">${seg.calls.map(c => html`
              <div class="ol-branch" key=${c.id}>
                ${olPill(run, c, laneOf(run, c))}${olList(run, c.children, 0, true, room - indent - 22, ctx)}</div>`)}</div>${join}`}
      </div>`);
      continue;
    }
    if (seg.kind !== 'call') continue;
    if (compact) rows.push(olPill(run, seg, isAgentCall(seg) ? laneOf(run, seg) : null));
    else {
      const act = callAction(seg);
      rows.push(html`<button class="ol-call ${callStatus(seg, run)}" key=${seg.id} style=${`padding-left:${0.6 * 16 + indent}px`}
        title=${summarize(seg, run)} onClick=${() => jumpTo(run, seg)}>
        <span class="dot"></span>${isAgentCall(seg) && html`<b class="ol-lane">${laneOf(run, seg)}</b>`}<span class="ol-name">${olName(seg)}</span>
        ${act.label !== seg.name && html`<span class="ol-label cat-${act.cat}">${act.label}</span>`}</button>`);
    }
    rows.push(...olList(run, seg.children, depth + 1, compact, room, ctx));
  }
  return rows;
}

function olPill(run, c, lane) {
  const act = callAction(c);
  return html`<button class="ol-pill cat-${act.cat} ${callStatus(c, run)}" key=${c.id}
    title=${`${lane ? 'subagent ' + lane + ' · ' : ''}${olName(c)} · ${act.label}: ${summarize(c, run)}`} onClick=${() => jumpTo(run, c)}>${lane && html`<b class="ol-lane">${lane}</b>`}${olName(c)}</button>`;
}

// Outline width: 230px, widened (up to OL_MAX) so parallel columns fit; the narrow drawer is fixed.
const OL_MIN = 230, OL_MAX = 440, OL_PAD = 24 + 13;
function Outline() {
  const narrow = window.matchMedia('(max-width: 860px)').matches;
  const room = (narrow ? Math.min(280, window.innerWidth * 0.85) : OL_MAX) - OL_PAD;
  const ctx = { width: 0, offset: 0 };
  const rows = [];
  store.runs.forEach((run, ri) => {
    rows.push(html`<a class="ol-run ${run.status}" href=${'#run-' + run.id} title=${runTitle(run)}
      onClick=${e => { e.preventDefault(); document.getElementById('run-' + run.id)?.scrollIntoView({ behavior: 'smooth' }); stickToBottom = false; }}>
      ${ri + 1}. ${runTitle(run).slice(0, 40)}</a>`);
    if (shown('assistant/tool_use')) rows.push(...olList(run, run.root, 0, false, room, ctx));
  });
  const width = Math.min(OL_MAX, Math.max(OL_MIN, Math.ceil(ctx.width + OL_PAD + 6)));
  document.documentElement.style.setProperty('--ol-w', width + 'px');
  return html`<nav class="outline ${store.ui.outlineOpen ? 'shown' : ''}">
    <div class="ol-title">outline <button class="x ol-close" onClick=${() => toggle(store.ui, 'outlineOpen', false)}>×</button></div>
    ${rows.length ? rows : html`<div class="ol-empty">Tool calls will appear here.</div>`}
  </nav>`;
}

function Composer() {
  const ref = useRef();
  const running = store.runs.some(r => r.status === 'running');
  const go = () => {
    const v = ref.current.value.trim();
    if (!v || running) return;
    ref.current.value = '';
    submit(v);
  };
  const live = store.mode === 'live';
  const resuming = live && resumableIn(store.cwd);
  const fileError = store.fileError && html`<span class="load-err">${store.fileError} · </span>`;
  if (!live) {
    const name = store.trace && replayName(store.trace);
    const cur = replayInProgress();
    return html`
      <div class="composer">
        ${fileError && html`<div class="session-line">${fileError}</div>`}
        <div class="composer-row replay-row">
          ${cur
            ? html`<button class="run-btn" onClick=${() => togglePause(cur)} title=${cur.paused ? 'resume' : 'pause'} aria-label=${cur.paused ? 'resume' : 'pause'}>
                ${cur.paused ? '▶' : '⏸'}<span class="word"> ${cur.paused ? 'Resume' : 'Pause'}</span></button>
              <button class="hdr-btn" onClick=${() => stop(cur)} title="stop" aria-label="stop">■<span class="word"> Stop</span></button>`
            : name
              ? html`<button class="run-btn" disabled=${running} onClick=${startReplay} title=${'replay ' + name} aria-label="replay">▶<span class="word"> Replay</span></button>`
              : html`<span class="replay-hint">Choose a trace above, or upload one.</span>`}
          <div class="seg small" role="radiogroup" aria-label="replay speed">
            ${SPEEDS.map(([s, label, tip]) => html`<button class=${store.speed === s ? 'on' : ''} role="radio"
              aria-checked=${store.speed === s} title=${tip} onClick=${() => setSpeed(s)}>${label}</button>`)}
          </div>
          <button class="hdr-btn upload-btn" onClick=${pickFile}
            title="Visualize a stream-json .jsonl file: choose one, or drop it anywhere on the page">⤒ upload<span class="long"> .jsonl</span></button>
        </div>
      </div>`;
  }
  return html`
    <div class="composer">
      <div class="session-line">
        ${fileError}
        ${resuming
          ? html`continuing session ${short(store.sessionId)} · <button class="link" onClick=${() => { store.sessionId = null; changed(); }}>start new session</button>`
          : html`new session`}
      </div>
      <div class="composer-row">
        <textarea ref=${ref} rows="2" placeholder=${store.runs.length ? 'type a follow-up…' : 'ask the agent to do something in the working directory…'}
          onKeyDown=${e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); } }}></textarea>
        <button class="run-btn" disabled=${running} onClick=${go}>${running ? 'Running…' : 'Run'}</button>
      </div>
    </div>`;
}

// ---------------------------------------------------------------- event filter

function allKinds() {
  return [...new Set([...Object.keys(KIND_INFO), ...Object.keys(store.kindCounts)])].sort();
}

function KindTable({ counts }) {
  return html`<table class="kinds">
    <thead><tr><th>show</th><th>event kind</th><th>what it is</th><th class="num">count</th></tr></thead>
    <tbody>${(counts === store.kindCounts ? allKinds() : Object.keys(counts).sort()).map(k => html`
      <tr class=${counts[k] ? '' : 'unseen'}>
        <td><input type="checkbox" checked=${shown(k)} disabled=${isAlways(k)}
          title=${isAlways(k) ? 'always shown in the status line' : ''}
          onChange=${() => setHidden([k], shown(k))} /></td>
        <td class="mono">${k}</td>
        <td>${KIND_INFO[k] || 'no special rendering: shown as a raw event line'}</td>
        <td class="num">${counts[k] || 0}</td>
      </tr>`)}</tbody>
  </table>`;
}

function EventFilter() {
  if (!store.ui.filterOpen) return null;
  return html`<div class="filter-pop" onClick=${e => e.stopPropagation()}>
    <div class="fp-head">
      <b>What the dialogue shows</b>
      <button class="x" onClick=${() => toggle(store.ui, 'filterOpen', false)}>×</button>
    </div>
    <div class="view-opts" role="radiogroup">
      ${VIEWS.map(([v, label, desc]) => html`
        <button class="view-opt ${store.view === v ? 'on' : ''}" role="radio" aria-checked=${store.view === v} onClick=${() => setView(v)}>
          <b>${label}</b><span>${desc}</span>
        </button>`)}
    </div>
    ${store.view === 'custom' && html`<${KindTable} counts=${store.kindCounts} />`}
    <p class="fp-note">This only changes the dialogue: every event is still recorded and listed in each
      run's inspector.${store.view === 'custom' ? ' Kinds seen for the first time are shown until you hide them.' : ''}</p>
  </div>`;
}

// ---------------------------------------------------------------- inspector

function Inspector() {
  const st = store.ui.inspect;
  const run = st && store.runs.find(r => r.id === st.runId);
  if (!run) return null;
  const idx = store.runs.indexOf(run) + 1;
  const tab = (name, label) => html`<button class="tab ${st.tab === name ? 'on' : ''}" onClick=${() => { st.tab = name; changed(); }}>${label}</button>`;
  const stream = () => run.events.filter(r => !r.ev.type.startsWith('_')).map(r => JSON.stringify(r.ev)).join('\n') + '\n';
  const full = () => JSON.stringify({
    prompt: run.prompt, cwd: run.cwd, resume: run.resume, replay: run.replay, argv: run.argv,
    events: run.events.map(({ seq, t, kinds, agent, turn, io, ev }) => ({ seq, t, kinds, agent, turn, io, ev })),
  }, null, 2);
  return html`
    <aside class="inspector">
      <div class="ins-head">
        <div>
          <div class="ins-title">Run ${idx} · inspector</div>
          <div class="ins-sub">${oneLine(runTitle(run), 90)}</div>
        </div>
        <button class="x" onClick=${() => { store.ui.inspect = null; changed(); }} title="close (Esc)">×</button>
      </div>
      <div class="ins-tabs">
        ${tab('overview', 'Overview')}
        ${tab('rounds', `Rounds · ${buildRounds(run).length}`)}
        ${tab('context', 'Context')}
        ${tab('events', `Events · ${run.events.length}`)}
        <span class="grow"></span>
        <button class="dl" title="Claude Code's stream only, usable as a replay fixture"
          onClick=${() => downloadFile(`run${idx}-${(run.sessionId || 'nosession').slice(0, 8)}.jsonl`, stream(), 'application/x-ndjson')}>⤓ stream .jsonl</button>
        <button class="dl" title="every event with sequence number, timing, agent and turn"
          onClick=${() => downloadFile(`run${idx}-log.json`, full(), 'application/json')}>⤓ full log</button>
      </div>
      <div class="ins-body">
        ${st.tab === 'overview' && html`<${Overview} run=${run} />`}
        ${st.tab === 'rounds' && html`<${Rounds} run=${run} st=${st} />`}
        ${st.tab === 'context' && html`<${ContextTab} run=${run} st=${st} />`}
        ${st.tab === 'events' && html`<${EventLog} run=${run} st=${st} />`}
      </div>
    </aside>`;
}

function KV({ rows }) {
  return html`<table class="kv">${rows.filter(r => r && r[1] != null && r[1] !== '').map(([k, v]) => html`<tr><th>${k}</th><td>${v}</td></tr>`)}</table>`;
}

function Overview({ run }) {
  const r = run.result || {};
  const u = r.usage || {};
  const mu = r.modelUsage || {};
  return html`
    <h3>Input</h3>
    <${KV} rows=${[
      run.replay
        ? ['source', html`<code>${run.replayFile ? run.replay : 'fixtures/' + run.replay}</code>${run.replayFile ? ' (loaded file)' : ''}`]
        : ['prompt', html`<pre class="box">${run.prompt}</pre>`],
      !run.replay && ['working directory', html`<code>${run.cwd || '.'}</code>${run.absCwd && run.absCwd !== run.cwd ? html` → <code>${run.absCwd}</code>` : ''}`],
      ['mode', run.replay ? 'replay: the recorded events are shown, nothing is started' : 'live'],
      !run.replay && ['session', run.resume ? html`resumed <code>${run.resume}</code>: the model also sees the earlier conversation` : 'new session'],
      !run.replay && ['command', run.argv ? html`<pre class="box">${run.argv.map(shq).join(' ')}</pre>` : '–'],
      ['started', new Date(run.startedAt).toLocaleString()],
      run.init && ['model', run.init.model],
      run.init && ['permission mode', run.init.permissionMode],
      run.init && ['tools available', html`<span class="mono small">${(run.init.tools || []).join(', ')}</span>`],
      run.init?.mcp_servers?.length > 0 && ['MCP servers', html`<span class="mono small">${run.init.mcp_servers.map(s => `${s.name} (${s.status})`).join(', ')}</span>`],
      run.init?.claude_code_version && ['Claude Code', run.init.claude_code_version],
    ]} />

    <h3>Output</h3>
    <${KV} rows=${[
      ['status', html`<span class="st-${run.status}">${run.status}</span>${run.endedAt ? ` · ${fmtDuration(run.endedAt - run.startedAt)} wall clock in the page` : ''}`],
      run.error && ['error', html`<pre class="box err">${run.error}</pre>`],
      r.result && run.status === 'finished' && ['final answer', html`<div class="md box" dangerouslySetInnerHTML=${{ __html: md({ text: r.result }) }} />`],
      run.sessionId && ['session id', html`<code>${run.sessionId}</code>`],
      r.total_cost_usd != null && ['cost', fmtCost(r.total_cost_usd)],
      r.duration_ms != null && ['duration', `${fmtDuration(r.duration_ms)} total${r.duration_api_ms != null ? ` · ${fmtDuration(r.duration_api_ms)} waiting on the API` : ''}`],
      r.num_turns != null && ['turns', `${r.num_turns} reported · ${run.turns.filter(t => t.agent === 'main').length} main-agent model turns seen, ${run.turns.filter(t => t.agent !== 'main').length} subagent turns`],
      r.usage && ['tokens', html`
        <table class="mini">
          <tr><th>input</th><th>cache write</th><th>cache read</th><th>output</th></tr>
          <tr><td>${fmtNum(u.input_tokens)}</td><td>${fmtNum(u.cache_creation_input_tokens)}</td><td>${fmtNum(u.cache_read_input_tokens)}</td><td>${fmtNum(u.output_tokens)}</td></tr>
        </table>`],
      Object.keys(mu).length > 0 && ['per model', html`
        <table class="mini">
          <tr><th>model</th><th>input</th><th>cache write</th><th>cache read</th><th>output</th><th>cost</th></tr>
          ${Object.entries(mu).map(([m, x]) => html`<tr><td class="mono">${m}</td><td>${fmtNum(x.inputTokens)}</td><td>${fmtNum(x.cacheCreationInputTokens)}</td><td>${fmtNum(x.cacheReadInputTokens)}</td><td>${fmtNum(x.outputTokens)}</td><td>${x.costUSD != null ? fmtCost(x.costUSD) : '–'}</td></tr>`)}
        </table>`],
      r.permission_denials?.length > 0 && ['permission denials', html`<pre class="box">${JSON.stringify(r.permission_denials, null, 2)}</pre>`],
      run.exit && ['process exit', `code ${run.exit.code}${run.exit.stopped ? ' (stopped by you)' : ''}`],
      run.stderr && ['stderr', html`<pre class="box">${run.stderr}</pre>`],
    ]} />

    <h3>Events in this run</h3>
    <${KindTable} counts=${run.kindCounts} />`;
}

// ---------------------------------------------------------------- rounds

// One round is one model call. For each, rebuild what was sent (the system prompt, the tool
// definitions, and that agent's message history as it stood, with the harness's pruning applied),
// what came back, and what the harness did with it. harness traces carry everything needed for
// this; Claude Code's own stream lacks its system prompt and tool definitions, so there the
// context is the conversation part only.
function buildRounds(run) {
  if (run._rounds && run._rounds.n === run.events.length) return run._rounds.list;
  const convs = {}, last = {}, list = [], byCall = {}, bySeq = {}, blocks = {};
  let init = null;
  const conv = a => convs[a] ||= { system: null, tools: null, name: null, msgs: [], prevMsgs: null, ctx: null, before: [], keep: null, oneoff: null, req: null, summReq: null };
  // A live Claude Code run: the prompt typed in the page is the first message (the stream lacks it).
  if (!run.replay && run.prompt) conv('main').msgs.push({ role: 'user', text: run.prompt, fromPage: true });

  for (const rec of run.events) {
    const ev = rec.ev, a = rec.agent, c = conv(a);
    if (ev.type === 'system') {
      if (ev.subtype === 'init') init = ev;
      else if (ev.subtype === 'system_prompt') {
        c.system = ev.content;
        c.tools = ev.tool_schemas || (a === 'main' ? init?.tool_schemas : null) || null;
        c.name = ev.agent || null;
      }
      else if (ev.subtype === 'context') c.ctx = ev;
      // what the next model call is sent, as a digest (harness traces); the summarizer's own call
      // belongs to the compaction that follows it, not to the agent's next turn
      else if (ev.subtype === 'llm_request') { if (ev.purpose === 'compaction summary') c.summReq = ev; else c.req = ev; }
      // after a compaction the next user message replaces the issue and older turns
      else if (ev.subtype === 'compact_boundary') {
        c.keep = Math.max(0, (ev.messages_after ?? 2) - 2);
        c.before.push(rec);
        // The summarizer is a model call of its own: a fresh, tool-free request over the older turns.
        if (ev.summarizer_input != null) {
          const sr = {
            n: list.length + 1, agent: a, name: c.name, msgId: `summary@${rec.seq}`, rec, iteration: ev.iteration ?? null,
            kind: 'summarizer', oneoff: 'compaction summary: a fresh request, without tools, that condenses the older turns',
            system: ev.summarizer_system ?? null, tools: null, toolNames: null,
            msgs: [{ role: 'user', text: ev.summarizer_input, rec, summarizerInput: true }],
            prevMsgs: null, ctx: null, before: [], req: c.summReq, usage: ev.summarizer_usage || null,
            reply: { role: 'assistant', blocks: ev.summarizer_output != null ? [{ type: 'text', text: ev.summarizer_output }] : [], rec },
            out: [], harness: [], results: {}, pruning: null, resendsReasoning: false,
          };
          c.summReq = null;
          list.push(sr);
          bySeq[rec.seq] = sr;
        }
      }
      else if (ev.subtype === 'api_retry' || ev.subtype === 'context_overflow') c.before.push(rec);
      else if (ev.subtype === 'request') c.oneoff = ev;
      else if (ev.subtype === 'harness') (last[a] ? last[a].harness : c.before).push(rec);
      continue;
    }
    if (ev.type === 'user') {
      const content = ev.message?.content;
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content, whole: true }] : Array.isArray(content) ? content : [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const m = { role: 'tool', text: resultText(b.content), isError: !!b.is_error, toolUseId: b.tool_use_id, rec };
          c.msgs.push(m);
          if (last[a]) last[a].results[b.tool_use_id] = m;
        } else if (b.type === 'text') {
          const m = { role: 'user', text: b.text, rec };
          if (b.whole && c.keep != null) {
            m.compacted = true;
            c.msgs = [m, ...(c.keep ? c.msgs.slice(-c.keep) : [])];
            c.keep = null;
          } else c.msgs.push(m);
        }
      }
      continue;
    }
    if (ev.type !== 'assistant') continue;
    const mid = ev.message?.id || `seq${rec.seq}`;
    let r = last[a];
    if (!r || r.msgId !== mid) {     // Claude Code splits one reply over several events with one id
      const one = c.oneoff;
      c.oneoff = null;
      r = {
        n: list.length + 1, agent: a, name: c.name, msgId: mid, rec, iteration: ev.iteration ?? null,
        oneoff: one?.purpose || null,
        system: one ? one.messages.find(m => m.role === 'system')?.content ?? null : c.system,
        tools: one ? one.tool_schemas || null : c.tools,
        toolNames: a === 'main' && !one ? init?.tools || null : null,
        msgs: one ? one.messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, text: m.content ?? '' })) : [...c.msgs],
        prevMsgs: one ? null : c.prevMsgs, ctx: one ? null : c.ctx, before: c.before, req: c.req,
        reply: { role: 'assistant', blocks: [], rec }, out: [], harness: [], results: {},
        pruning: init?.pruning || null, resendsReasoning: init?.resends_reasoning !== false,
      };
      if (!one) { c.prevMsgs = r.msgs; c.msgs.push(r.reply); c.ctx = null; }
      c.before = [];
      c.req = null;
      list.push(r);
      bySeq[rec.seq] = r;
      last[a] = r;
    }
    r.out.push(rec);
    bySeq[rec.seq] = r;
    for (const b of Array.isArray(ev.message?.content) ? ev.message.content : []) {
      r.reply.blocks.push(b);
      if (b.type === 'tool_use') { byCall[b.id] = r; blocks[b.id] = b; }
    }
  }
  for (const r of list) r.blocks = blocks;
  run._rounds = { n: run.events.length, list, byCall, bySeq };
  return list;
}

const roundOfCall = (run, id) => (buildRounds(run), run._rounds.byCall[id]);
const roundOfRec = (run, rec) => (buildRounds(run), run._rounds.bySeq[rec.seq]);
const roundUsage = r => r.usage || r.out.map(x => x.ev.message?.usage).filter(Boolean).pop() || {};

// The next model call of the same agent, and whether this message was in it.
function nextRound(run, r) {
  const all = buildRounds(run);
  return all.slice(all.indexOf(r) + 1).find(x => x.agent === r.agent && !x.oneoff) || null;
}

// ---- request digests: proving the rebuilt request is what the model was sent
// Harness traces put a SHA-256 of each request's messages, in a canonical form, on the
// system/llm_request event before the call (see "Harness trace format" in README.md). The page rebuilds the
// same form from the round and compares.

// JSON with sorted keys and no spaces, as Python's json.dumps(sort_keys=True, separators=(',', ':'),
// ensure_ascii=False) writes it.
function canonJSON(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(canonJSON).join(',') + ']';
  return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonJSON(v[k])).join(',') + '}';
}
// Older traces lack `raw_arguments`; re-serializing `input` is then the best guess.
const canonArgs = b => typeof b.raw_arguments === 'string' ? b.raw_arguments
  : b.input && Object.keys(b.input).length === 1 && '_raw_arguments' in b.input
    ? String(b.input._raw_arguments ?? '') : canonJSON(b.input || {});
const sentId = b => 'sent_id' in b ? b.sent_id : b.id;

// The round's request as the API received it: system prompt, then the messages, pruning applied.
function canonRequest(r) {
  const out = [];
  if (r.system != null) out.push({ role: 'system', content: r.system });
  for (const m of r.msgs) {
    if (m.role === 'assistant') {
      const o = { role: 'assistant', content: replyText(m) };
      const calls = replyCalls(m);
      if (calls.length) o.tool_calls = calls.map(b => ({ id: sentId(b), name: b.name, arguments: canonArgs(b) }));
      out.push(o);
    } else if (m.role === 'tool') {
      const b = r.blocks?.[m.toolUseId];
      const id = b ? sentId(b) : m.toolUseId;
      out.push({ role: 'tool', content: sentText(r, m).text, ...(id == null ? {} : { tool_call_id: id }) });
    } else out.push({ role: m.role, content: m.text ?? '' });
  }
  return out;
}

const SHA_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);

// SHA-256, synchronous and in plain JS: crypto.subtle is async and missing outside secure contexts
// (the server may be reached over plain http on a LAN address).
function sha256hex(str) {
  const data = new TextEncoder().encode(str);
  const len = data.length;
  const buf = new Uint8Array(Math.ceil((len + 9) / 64) * 64);
  buf.set(data);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 8, Math.floor(len / 0x20000000));
  dv.setUint32(buf.length - 4, (len * 8) >>> 0);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const rot = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < buf.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2];
      W[i] = W[i - 16] + (rot(a, 7) ^ rot(a, 18) ^ (a >>> 3)) + W[i - 7] + (rot(b, 17) ^ rot(b, 19) ^ (b >>> 10));
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + W[i]) | 0;
      const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return [...H].map(x => x.toString(16).padStart(8, '0')).join('');
}

// Does the rebuilt request match what was sent? 'exact', 'differs', or 'none' (nothing to check
// against: an older harness trace, or Claude Code's own stream).
function verifyRound(r) {
  if (r._verify) return r._verify;
  const req = r.req;
  if (!req?.digest) return (r._verify = { status: 'none' });
  const canon = canonRequest(r);
  const ok = 'sha256:' + sha256hex(canonJSON(canon)) === req.digest;
  const v = { status: ok ? 'exact' : 'differs', recorded: req.messages || null, canon };
  if (!ok && req.messages) {
    v.firstDiff = req.messages.findIndex((m, i) => canonJSON(m) !== canonJSON(canon[i] ?? null));
    if (v.firstDiff < 0) v.firstDiff = Math.min(req.messages.length, canon.length);
  }
  return (r._verify = v);
}

// The text a message had in this round's request: old tool results may have been pruned.
function sentText(r, m) {
  const p = m.role === 'tool' && r.ctx ? (r.ctx.pruned || []).find(x => x.tool_use_id === m.toolUseId) : null;
  if (!p) return { text: m.text };
  const rule = r.pruning;
  if (p.action === 'cleared') {
    return rule ? { text: rule.cleared_text, pruned: p }
      : { text: `[cleared: replaced by a ${fmtNum(p.chars_sent)}-character placeholder this trace does not record]`, pruned: p, approx: true };
  }
  // Traces written before the rule was recorded: the reference harness keeps the head and the tail, split evenly.
  const sep = rule?.trim_separator ?? '\n...\n';
  const k = rule?.trim_keep_chars ?? Math.floor((p.chars_sent - sep.length) / 2);
  // The harness slices code points (Python); JS strings index UTF-16 units, which differ past the BMP
  const t = /[\uD800-\uDFFF]/.test(m.text) ? Array.from(m.text) : m.text;
  const cut = (a, b) => (typeof t === 'string' ? t.slice(a, b) : t.slice(a, b).join(''));
  return { text: cut(0, k) + sep + cut(-k), pruned: p };
}

const replyText = m => m.blocks.filter(b => b.type === 'text').map(b => b.text).join('');
const replyThinking = m => m.blocks.filter(b => b.type === 'thinking').map(b => b.thinking).join('\n');
const replyCalls = m => m.blocks.filter(b => b.type === 'tool_use');

// The request as data: what the "context.json" download contains.
function contextJSON(run, r) {
  const messages = [];
  if (r.system != null) messages.push({ role: 'system', content: r.system });
  for (const m of r.msgs) {
    if (m.role === 'assistant') {
      const o = { role: 'assistant', content: replyText(m) };
      if (r.resendsReasoning && replyThinking(m)) o.thinking = replyThinking(m);
      const calls = replyCalls(m);
      if (calls.length) o.tool_calls = calls.map(b => ({ id: b.id, name: b.name, input: b.input }));
      messages.push(o);
    } else if (m.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: m.toolUseId, content: sentText(r, m).text });
    } else {
      messages.push({ role: m.role, content: m.text });
    }
  }
  return { round: r.n, agent: roundAgent(run, r), iteration: r.iteration, one_off: r.oneoff,
    tools: r.tools || r.toolNames, messages };
}

function roundAgent(run, r) {
  if (r.agent === 'main') return 'main agent';
  if (r.name) return r.name;
  const c = run.calls[r.agent];
  return c ? `subagent ${laneOf(run, c)}` : 'subagent';
}

function roundSummary(r) {
  if (r.kind === 'summarizer') return 'compaction summary';
  if (r.oneoff) return oneLine(r.oneoff.split(':')[0], 40);
  const calls = replyCalls(r.reply);
  if (calls.length) return calls.map(b => b.name).join(', ');
  return replyText(r.reply).trim() ? 'text reply' : 'empty reply';
}

const HARNESS_ACTIONS = {
  batch_blocked: ['call blocked', 'err'],
  bad_arguments: ['bad arguments', 'err'],
  guard_refused: ['refused by loop guard', 'err'],
  prefetched: ['ran early', 'info'],
  warning: ['warning appended', 'warn'],
  note: ['note appended', 'info'],
  nudge: ['nudge', 'warn'],
  free_turn: ['free turn', 'info'],
  review_started: ['review started', 'info'],
  review_verdict: ['review verdict', 'ok'],
};

// One harness decision, or another harness-side event (compaction, overflow, retry), as a line.
function harnessInfo(ev) {
  if (ev.subtype === 'harness') {
    const [label, tone] = HARNESS_ACTIONS[ev.action] || [ev.action, 'info'];
    if (ev.action === 'review_verdict') {
      const v = ev.verdict || 'none';
      return { label: `review: ${v}${ev.done_refused ? ' · done refused' : ''}`, tone: v === 'pass' && !ev.done_refused ? 'ok' : 'err',
        text: ev.text || '' };
    }
    return { label, tone, text: ev.text || '' };
  }
  if (ev.subtype === 'compact_boundary') {
    return { label: `compaction (${ev.trigger || 'threshold'})`, tone: 'warn',
      text: `${ev.messages_before} → ${ev.messages_after} messages: older turns were replaced by a summary`, compaction: ev };
  }
  if (ev.subtype === 'context_overflow') {
    return { label: 'context overflow', tone: 'err', text: `the API rejected the request as too large; window is now ${fmtNum(ev.new_window)} tokens (attempt ${ev.attempt})` };
  }
  if (ev.subtype === 'api_retry') return { label: 'API retry', tone: 'warn', text: `${oneLine(ev.error, 140)} · waited ${ev.backoff_s} s` };
  return { label: ev.subtype, tone: 'info', text: '' };
}

function HarnessLine({ run, rec, compact }) {
  const h = harnessInfo(rec.ev);
  const r = rec.agent && (roundOfRec(run, rec) || buildRounds(run).find(x => x.harness.includes(rec) || x.before.includes(rec)));
  return html`<div class="hz ${h.tone}">
    <span class="hz-tag">⚙ ${h.label}</span>
    <span class="hz-text">${compact ? oneLine(h.text, 220) : h.text}</span>
    ${h.compaction && html`<details class="hz-more"><summary>summarizer input and output</summary>
      <div class="ti-k">summary written</div><${Folded} id=${'cs' + rec.seq} text=${h.compaction.summarizer_output || '(none)'} />
      <div class="ti-k">transcript it summarized</div><${Folded} id=${'ci' + rec.seq} text=${h.compaction.summarizer_input || '(none)'} /></details>`}
    ${compact && r && html`<span class="seq rd-link" role="button" title="open this round"
      onClick=${e => { e.stopPropagation(); openRound(run, r.n); }}>R${r.n}</span>`}
  </div>`;
}

// Open a round in the inspector; `focus` is the id of an element to scroll to and flash (chat view).
function openRound(run, n, focus = null) {
  const prev = store.ui.inspect;
  const same = prev && prev.runId === run.id;
  if (focus && store.ui.roundLayout !== 'chat') { store.ui.roundLayout = 'chat'; save('roundLayout', 'chat'); }
  store.ui.inspect = { runId: run.id, tab: 'rounds', round: n, agent: '', q: same ? prev.q : '', kind: '', open: same ? prev.open : {}, focus };
  rerender();
}

function stepRound(d) {
  const st = store.ui.inspect;
  const run = st && store.runs.find(x => x.id === st.runId);
  if (!run || st.tab !== 'rounds') return false;
  const rounds = buildRounds(run).filter(r => !st.agent || r.agent === st.agent);
  if (!rounds.length) return false;
  const i = Math.max(0, rounds.findIndex(r => r.n === st.round));
  st.round = rounds[Math.max(0, Math.min(rounds.length - 1, i + d))].n;
  changed();
  return true;
}

function Rounds({ run, st }) {
  const all = buildRounds(run);
  if (!all.length) return html`<p class="muted">No model calls yet.</p>`;
  const agents = [...new Set(all.map(r => r.agent))];
  const rounds = st.agent ? all.filter(r => r.agent === st.agent) : all;
  let i = rounds.findIndex(r => r.n === st.round);
  if (i < 0) i = 0;
  const r = rounds[i];
  const go = d => { st.round = rounds[Math.max(0, Math.min(rounds.length - 1, i + d))].n; changed(); };
  return html`
    <div class="rd-nav">
      <button onClick=${() => go(-1)} disabled=${i === 0} title="previous round (←)">◀</button>
      <select value=${r.n} onChange=${e => { st.round = +e.target.value; changed(); }}>
        ${rounds.map(x => html`<option value=${x.n}>Round ${x.n}${x.iteration != null ? ` · iter ${x.iteration}` : ''} · ${roundAgent(run, x)} · ${roundSummary(x)}</option>`)}
      </select>
      <button onClick=${() => go(1)} disabled=${i === rounds.length - 1} title="next round (→)">▶</button>
      ${agents.length > 1 && html`<select class="rd-agent" value=${st.agent || ''}
        onChange=${e => { st.agent = e.target.value; st.round = null; changed(); }}>
        <option value="">all agents</option>
        ${agents.map(a => html`<option value=${a}>${roundAgent(run, all.find(x => x.agent === a))}</option>`)}
      </select>`}
      <div class="seg small" role="radiogroup" aria-label="layout">
        ${[['chat', 'chat', 'the request and reply as a conversation, coloured by who wrote each message'],
          ['list', 'list', 'compact rows: sent to the model, model output, harness response']].map(([v, label, tip]) => html`
          <button class=${store.ui.roundLayout === v ? 'on' : ''} role="radio" aria-checked=${store.ui.roundLayout === v} title=${tip}
            onClick=${() => { store.ui.roundLayout = v; save('roundLayout', v); changed(); }}>${label}</button>`)}
      </div>
    </div>
    ${store.ui.roundLayout === 'list'
      ? html`<${Round} run=${run} r=${r} st=${st} key=${r.n} />`
      : html`<${ChatRound} run=${run} r=${r} st=${st} key=${r.n} />`}`;
}

function Round({ run, r, st }) {
  const prev = new Set(r.prevMsgs || []);
  const isNew = m => !r.prevMsgs || !prev.has(m);
  const kept = r.msgs.filter(m => !isNew(m));
  const fresh = r.msgs.filter(isNew);
  const usage = roundUsage(r);
  const ctx = r.ctx;
  const chars = ctx?.chars_sent ?? r.msgs.reduce((n, m) => n + (m.role === 'assistant' ? replyText(m).length : sentText(r, m).text.length), 0) + (r.system || '').length;
  const ratio = ctx?.estimated_usage_ratio;
  const prunedKept = kept.filter(m => sentText(r, m).pruned).length;
  const open = st.open;
  const keptKey = `kept${r.n}`;
  const calls = replyCalls(r.reply);
  const byCall = id => r.harness.filter(h => h.ev.tool_use_id === id);
  const general = r.harness.filter(h => !h.ev.tool_use_id || !calls.some(b => b.id === h.ev.tool_use_id));
  const lastMain = r.agent === 'main' && buildRounds(run).filter(x => x.agent === 'main').pop() === r;
  return html`
    <section class="rd-sec in">
      <h4>→ Sent to the model
        <span class="rd-stat">${plural(r.msgs.length + (r.system != null ? 1 : 0), 'message')} · ${fmtNum(chars)} chars${usage.input_tokens != null ? ` · ${fmtNum(usage.input_tokens)} input tokens` : ''}</span></h4>
      <div class="rd-body">
        ${r.oneoff && html`<div class="rd-banner">One-off request, outside the running conversation: ${r.oneoff}</div>`}
        ${r.system == null && !r.oneoff && html`<div class="rd-banner muted">${run.init?.pruning
          ? 'No system prompt was recorded for this agent.'
          : "Claude Code's stream does not include its system prompt or tool definitions, so this is the conversation part of the request only."}</div>`}
        ${ratio != null && html`<div class="small muted">context window: ${Math.round(ratio * 100)}% of ${fmtNum(ctx.window)} tokens (estimated)</div>
          <div class="usage-bar ${ratio >= 0.5 ? 'hi' : ''}"><span style=${`width:${Math.min(100, ratio * 100)}%`}></span></div>`}
        ${r.before.length > 0 && html`<div class="rd-before"><div class="ti-k">before this call</div>
          ${r.before.map(rec => html`<${HarnessLine} run=${run} rec=${rec} />`)}</div>`}
        <${RoundChanges} run=${run} r=${r} />
        ${r.system != null && html`<${CtxRow} run=${run} r=${r} st=${st} k=${'sys'} role="system" label="system prompt" text=${r.system} />`}
        ${(r.tools || r.toolNames) && html`<${ToolDefs} r=${r} st=${st} />`}
        ${kept.length > 0 && html`
          <button class="cm-group" onClick=${() => toggle(open, keptKey, false)}>
            ${open[keptKey] ? '▾' : '▸'} ${plural(kept.length, 'earlier message')}, as in the previous round${prunedKept ? html` · <b>${prunedKept} shortened by pruning</b>` : ''}</button>
          ${open[keptKey] && kept.map((m, i) => html`<${CtxMsg} run=${run} r=${r} st=${st} m=${m} k=${'k' + i} />`)}`}
        ${fresh.length > 0 && kept.length > 0 && html`<div class="ti-k">new since the previous round</div>`}
        ${fresh.map((m, i) => html`<${CtxMsg} run=${run} r=${r} st=${st} m=${m} k=${'n' + i} isNew=${!!r.prevMsgs} />`)}
        <button class="dl small" onClick=${() => downloadFile(`round${r.n}-context.json`, JSON.stringify(contextJSON(run, r), null, 2), 'application/json')}>⤓ context.json</button>
      </div>
    </section>

    <section class="rd-sec out">
      <h4>← Model output
        <span class="rd-stat">${r.reply.rec.ev.message?.stop_reason ? `stopped: ${r.reply.rec.ev.message.stop_reason} · ` : ''}${usage.output_tokens != null ? `${fmtNum(usage.output_tokens)} output tokens` : ''}</span></h4>
      <div class="rd-body">
        ${replyThinking(r.reply) && html`<div class="ti"><span class="ti-k">thinking${r.resendsReasoning ? '' : ' · not sent back next round'}</span>
          <${Folded} id=${'rt' + r.n} text=${replyThinking(r.reply)} cls="italic" /></div>`}
        ${replyText(r.reply).trim() && html`<div class="ti"><span class="ti-k">text</span><div class="md" dangerouslySetInnerHTML=${{ __html: md({ text: replyText(r.reply) }) }} /></div>`}
        ${calls.map(b => html`<div class="ti"><span class="ti-k">tool call</span> <b class="mono">${b.name}</b> <span class="muted small mono">${b.id}</span>
          <pre class="json box">${JSON.stringify(b.input, null, 2)}</pre></div>`)}
        ${!calls.length && !replyText(r.reply).trim() && !replyThinking(r.reply) && html`<p class="muted small">(empty reply)</p>`}
      </div>
    </section>

    <section class="rd-sec hz-sec">
      <h4>⚙ Harness response</h4>
      <div class="rd-body">
        ${calls.map(b => {
          const res = r.results[b.id];
          const c = run.calls[b.id];
          return html`<div class="rd-call">
            <div><b class="mono">${b.name}</b> <span class="muted small mono">${c ? oneLine(summarize(c, run), 90) : ''}</span>
              ${!res ? html` <span class="badge-sm pruned">no result</span>` : res.isError ? html` <span class="badge-sm err">error</span>` : html` <span class="badge-sm ok">ok</span>`}</div>
            ${byCall(b.id).map(h => html`<${HarnessLine} run=${run} rec=${h} />`)}
            ${res && html`<${ResultWithNotes} id=${'rr' + r.n + b.id} text=${res.text} />`}
            ${c && isAgentCall(c) && html`<button class="link small" onClick=${() => { st.agent = b.id; st.round = null; changed(); }}>open ${roundAgent(run, { agent: b.id, name: buildRounds(run).find(x => x.agent === b.id)?.name })}'s rounds ›</button>`}
          </div>`;
        })}
        ${general.map(h => html`<${HarnessLine} run=${run} rec=${h} />`)}
        ${!calls.length && !general.length && html`<p class="muted small">No tool calls, and no harness action was recorded.</p>`}
        ${lastMain && run.result && html`<div class="hz ${run.status === 'finished' ? 'ok' : 'err'}"><span class="hz-tag">⚙ run ended</span>
          <span class="hz-text">${run.result.stop_reason || run.result.subtype}</span></div>`}
      </div>
    </section>`;
}

// ---------------------------------------------------------------- rounds as a chat
// The same round, drawn as the conversation the model received: one bubble per message, coloured
// by who wrote it. The LLM is stateless, so everything in the input, including its own earlier
// replies, is chosen and resent by the harness on every call.

const ACTOR_LABEL = { llm: 'LLM', harness: 'harness', tool: 'tool output' };
const ActorChip = ({ a }) => html`<span class="actor-chip ${a}">${ACTOR_LABEL[a]}</span>`;
const isHarnessTrace = run => !!run.init?.pruning;

// Who wrote a tool result: the tool, or the harness when it answered in the tool's place
// (a refused or blocked call, bad arguments, a `done` refused by the reviewer), or a
// subagent's model for a subagent's report.
const HARNESS_WRITTEN = new Set(['guard_refused', 'batch_blocked', 'bad_arguments']);
function resultActor(run, id) {
  const c = run.calls[id];
  if (!c) return 'tool';
  if ((c.harness || []).some(h => HARNESS_WRITTEN.has(h.ev.action) || (h.ev.action === 'review_verdict' && h.ev.done_refused))) return 'harness';
  if (c.name === 'Task' || c.name === 'Agent') return 'llm';
  return 'tool';
}
const RESULT_WHO = {
  tool: 'tool output, delivered by the harness',
  harness: 'written by the harness in place of a tool result',
  llm: "the subagent's report",
};

function ChatLegend() {
  return html`<div class="chat-legend">
    <span><${ActorChip} a="llm" /> the model's own words</span>
    <span><${ActorChip} a="harness" /> written or decided by the harness</span>
    <span><${ActorChip} a="tool" /> output of a tool the harness ran</span>
  </div>`;
}

function Bubble({ actor, id, title, badges, children, cls = '' }) {
  return html`<div class="bub-row ${actor === 'llm' ? 'right' : 'left'}" id=${id}>
    <div class="bub ${actor} ${cls}">
      <div class="bub-head"><${ActorChip} a=${actor} /><span class="bub-title">${title}</span>${badges}</div>
      <div class="bub-body">${children}</div>
    </div></div>`;
}

// A message's text, verbatim, with the lines the harness appended to a tool's output picked out.
const APPENDED = /^\s*(\[harness[ :]|\[loop guard|Independent review: )/;
function NotedText({ id, text }) {
  const segs = [];
  for (const line of String(text ?? '').split('\n')) {
    const h = APPENDED.test(line);
    const last = segs[segs.length - 1];
    if (last && last.h === h) last.lines.push(line); else segs.push({ h, lines: [line] });
  }
  if (!segs.some(s => s.h)) return html`<${Folded} id=${id} text=${text} />`;
  return segs.filter(s => s.h || s.lines.join('').trim()).map((s, i) => s.h
    ? html`<div class="note-in"><span class="note-k">appended by the harness</span><pre>${s.lines.join('\n')}</pre></div>`
    : html`<${Folded} id=${id + '.' + i} text=${s.lines.join('\n')} />`);
}

const msgDomId = (r, m, run) => `chat-${r.n}-msg-${m.role === 'tool' ? m.toolUseId
  : m.role === 'assistant' ? 'a' + (buildRounds(run).find(x => x.reply === m)?.n ?? m.rec?.seq) : 'u' + (m.rec?.seq ?? 0)}`;

function ChatCalls({ calls, idp }) {
  return calls.map(b => html`<div class="bub-call" id=${idp ? `${idp}${b.id}` : null}>
    <div><span class="muted small">tool call</span> <b class="mono">${b.name}</b> <span class="muted small mono">${b.id}</span></div>
    <${ArgsBox} k=${'ca' + (idp || '') + b.id} open=${store.ui.rawOpen} value=${b.input} raw=${b.raw_arguments} /></div>`);
}

function ChatMsg({ run, r, st, m, isNew }) {
  const neu = isNew && html`<span class="badge-sm new">new</span>`;
  const id = msgDomId(r, m, run);
  if (m.role === 'assistant') {
    const pr = buildRounds(run).find(x => x.reply === m);
    const think = replyThinking(m);
    return html`<${Bubble} actor="llm" id=${id} badges=${neu}
      title=${`assistant · written by the LLM${pr ? ` in round ${pr.n}` : ''} · resent by the harness`}>
      ${replyText(m) && html`<${Folded} id=${`cx${r.n}.${id}`} text=${replyText(m)} />`}
      <${ChatCalls} calls=${replyCalls(m)} />
      ${!replyText(m) && !replyCalls(m).length && html`<div class="muted small">(empty)</div>`}
      ${think && !r.resendsReasoning && html`<div class="ghost">its reasoning in that round (${fmtNum(think.length)} chars) is not resent: the model never sees it again</div>`}
      ${pr && html`<button class="link small" onClick=${() => openRound(run, pr.n, `chat-${pr.n}-out`)}>open round ${pr.n} ›</button>`}
    </${Bubble}>`;
  }
  if (m.role === 'tool') {
    const s = sentText(r, m);
    const c = run.calls[m.toolUseId];
    const actor = resultActor(run, m.toolUseId);
    const from = roundOfCall(run, m.toolUseId);
    const key = `${r.n}.full.${m.toolUseId}`;
    const badges = html`${neu}${m.isError && html`<span class="badge-sm err">error</span>`}${s.pruned && html`<span class="badge-sm pruned"
      >${s.pruned.action} · ${fmtNum(s.pruned.chars_before)} → ${fmtNum(s.pruned.chars_sent)} chars</span>`}`;
    return html`<${Bubble} actor=${actor} id=${id} badges=${badges}
      title=${`tool · ${c ? c.name : 'call'} result${from ? ` (called in round ${from.n})` : ''} · ${RESULT_WHO[actor]}`}>
      <${NotedText} id=${`cx${r.n}.${id}`} text=${s.text} />
      ${s.pruned && html`<button class="link small" onClick=${() => toggle(st.open, key, false)}>
        ${st.open[key] ? 'hide' : 'show'} the full result the harness still holds (${fmtNum(m.text.length)} chars, not sent)</button>
        ${st.open[key] && html`<div class="held"><${Folded} id=${`cxf${r.n}.${id}`} text=${m.text} /></div>`}`}
    </${Bubble}>`;
  }
  const harness = isHarnessTrace(run);
  const first = r.msgs[0] === m;
  let actor = 'harness', title;
  if (m.summarizerInput) title = 'user · the older turns as a transcript, rendered by the harness for the summarizer';
  else if (m.compacted) title = 'user · compaction summary, written by the summarizer and placed here by the harness: it replaces the issue and older turns';
  else if (m.fromPage) title = 'user · your prompt';
  else if (r.oneoff) title = 'user · written by the harness for this one-off request';
  else if (first && r.agent === 'main') title = harness ? 'user · the task: the issue, wrapped by the harness' : 'user · the prompt';
  else if (first && harness) title = "user · the subagent's brief, written by the harness";
  else if (first) { actor = 'llm'; title = 'user · prompt written by the parent agent'; }
  else title = harness ? 'user · harness message (a nudge)' : 'user · message';
  return html`<${Bubble} actor=${actor} id=${id} title=${title}
    badges=${html`${neu}${m.compacted && html`<span class="badge-sm pruned">compacted</span>`}`}>
    <${Folded} id=${`cx${r.n}.${id}`} text=${m.text} />
  </${Bubble}>`;
}

function VerifyBanner({ run, r }) {
  const v = verifyRound(r);
  if (v.status === 'exact') {
    return html`<div class="vf ok">✓ <b>Exact.</b> This rebuild matches the digest the harness took of the request it sent
      (${plural(r.req.message_count ?? v.canon.length, 'message')}${r.req.tools?.length ? `, ${plural(r.req.tools.length, 'tool')}` : ', no tools'}).
      ${v.recorded && html`<button class="link small" onClick=${() => downloadFile(`round${r.n}-recorded-request.json`, JSON.stringify(v.recorded, null, 2), 'application/json')}>⤓ recorded request</button>`}</div>`;
  }
  if (v.status === 'differs') {
    return html`<div class="vf err">⚠ <b>The rebuild differs from what was sent</b>${v.firstDiff != null ? ` (first difference at message ${v.firstDiff + 1})` : ''}.
      ${v.recorded ? 'The recorded request is below, exactly as sent.' : 'This trace has only the digest; record full requests by logging each request in full (`system/llm_request` with `messages`).'}
      ${v.recorded && html`<details><summary>recorded request (${plural(v.recorded.length, 'message')})</summary><pre class="json">${JSON.stringify(v.recorded, null, 2)}</pre></details>`}</div>`;
  }
  return html`<div class="vf none">Rebuilt from the trace, not verified: ${isHarnessTrace(run)
    ? 'this trace was written before request digests were recorded.'
    : "Claude Code's stream has no request digests, system prompt or tool definitions."}</div>`;
}

function ChatRound({ run, r, st }) {
  const prev = new Set(r.prevMsgs || []);
  const isNew = m => !r.prevMsgs || !prev.has(m);
  const kept = r.msgs.filter(m => !isNew(m));
  const fresh = r.msgs.filter(isNew);
  const usage = roundUsage(r);
  const calls = replyCalls(r.reply);
  const think = replyThinking(r.reply), text = replyText(r.reply);
  const keptKey = `ckept${r.n}`;
  if (st.focus && kept.some(m => msgDomId(r, m, run) === st.focus)) st.open[keptKey] = true;
  const prunedKept = kept.filter(m => m.role === 'tool' && sentText(r, m).pruned).length;
  const prevR = r.prevMsgs && buildRounds(run).find(x => x.msgs === r.prevMsgs);
  const nr = nextRound(run, r);
  const ctx = r.ctx, ratio = ctx?.estimated_usage_ratio;
  const chars = canonRequest(r).reduce((n, m) => n + m.content.length + (m.tool_calls || []).reduce((k, c) => k + c.name.length + c.arguments.length, 0), 0);
  const byCall = id => r.harness.filter(h => h.ev.tool_use_id === id);
  const general = r.harness.filter(h => !h.ev.tool_use_id || !calls.some(b => b.id === h.ev.tool_use_id));
  const lastMain = r.agent === 'main' && !r.oneoff && buildRounds(run).filter(x => x.agent === 'main' && !x.oneoff).pop() === r;
  const goNext = (focus, label) => nr && html`<button class="link small" onClick=${() => openRound(run, nr.n, focus)}>${label || `→ next model call: round ${nr.n}`}</button>`;

  useEffect(() => {
    if (!st.focus) return;
    const el = document.getElementById(st.focus);
    st.focus = null;
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  });

  return html`<div class="chat">
    <${ChatLegend} />
    <${VerifyBanner} run=${run} r=${r} />
    ${r.oneoff && html`<div class="rd-banner">One-off request, outside the running conversation: ${r.oneoff}</div>`}

    <div class="chat-sec in"><span>→ Input · assembled by the harness</span>
      <span class="rd-stat">${plural(r.msgs.length + (r.system != null ? 1 : 0), 'message')} · ${fmtNum(chars)} chars${usage.input_tokens != null ? ` · ${fmtNum(usage.input_tokens)} input tokens` : ''}</span></div>
    ${ratio != null && html`<div class="small muted">context window: ${Math.round(ratio * 100)}% of ${fmtNum(ctx.window)} tokens (estimated)</div>
      <div class="usage-bar ${ratio >= 0.5 ? 'hi' : ''}"><span style=${`width:${Math.min(100, ratio * 100)}%`}></span></div>`}
    ${r.before.length > 0 && html`<div class="rd-before"><div class="ti-k">before this call</div>
      ${r.before.map(rec => html`<${HarnessLine} run=${run} rec=${rec} />`)}</div>`}
    <${RoundChanges} run=${run} r=${r} />
    ${r.system != null && html`<${Bubble} actor="harness" id=${`chat-${r.n}-sys`} title=${r.kind === 'summarizer' ? "system · the summarizer's instructions, written by the harness" : 'system prompt · written by the harness'}>
      <${Folded} id=${`cxs${r.n}`} text=${r.system} /></${Bubble}>`}
    ${(r.tools || r.toolNames) && html`<${Bubble} actor="harness" id=${`chat-${r.n}-tools`}
      title=${`tool definitions · ${plural((r.tools || r.toolNames).length, 'tool')} the model may call`}>
      <div class="mono small">${(r.tools ? r.tools.map(t => t.function?.name || t.name) : r.toolNames).join(', ')}</div>
      ${r.tools && html`<button class="link small" onClick=${() => toggle(st.open, `ctools${r.n}`, false)}>${st.open[`ctools${r.n}`] ? 'hide' : 'show'} the JSON schemas</button>
        ${st.open[`ctools${r.n}`] && html`<pre class="json">${JSON.stringify(r.tools, null, 2)}</pre>`}`}
    </${Bubble}>`}
    ${r.system == null && !r.oneoff && !isHarnessTrace(run) && html`<div class="rd-banner muted">Claude Code's stream does not include its system prompt or tool definitions: only the conversation part of the request is shown.</div>`}
    ${kept.length > 0 && html`
      <button class="cm-group" onClick=${() => toggle(st.open, keptKey, false)}>
        ${st.open[keptKey] ? '▾' : '▸'} ${plural(kept.length, 'earlier message')}, resent unchanged${prevR ? ` from round ${prevR.n}` : ''}${prunedKept ? html` · <b>${prunedKept} shortened by pruning</b>` : ''}</button>
      ${st.open[keptKey] && kept.map(m => html`<${ChatMsg} run=${run} r=${r} st=${st} m=${m} />`)}`}
    ${fresh.length > 0 && kept.length > 0 && html`<div class="ti-k">new since the previous call</div>`}
    ${fresh.map(m => html`<${ChatMsg} run=${run} r=${r} st=${st} m=${m} isNew=${!!r.prevMsgs} />`)}

    <div class="chat-call">▼ model call · the LLM sees only the messages above and keeps nothing afterwards</div>

    <${Bubble} actor="llm" id=${`chat-${r.n}-out`}
      title=${`assistant · round ${r.n} output${r.reply.rec.ev.message?.stop_reason ? ` · stopped: ${r.reply.rec.ev.message.stop_reason}` : ''}${usage.output_tokens != null ? ` · ${fmtNum(usage.output_tokens)} output tokens` : ''}`}>
      ${think && html`<div class="bub-think"><span class="note-k">reasoning${r.resendsReasoning ? '' : ' · never sent back'}</span>
        <${Folded} id=${'cot' + r.n} text=${think} cls="italic" /></div>`}
      ${text.trim() && html`<${Folded} id=${'coc' + r.n} text=${text} />`}
      <${ChatCalls} calls=${calls} idp=${`chat-${r.n}-call-`} />
      ${!calls.length && !text.trim() && !think && html`<div class="muted small">(empty reply)</div>`}
    </${Bubble}>

    <div class="chat-sec act"><span>⚙ The harness acts on the output</span></div>
    ${r.kind === 'summarizer' ? html`<div class="hz"><span class="hz-tag">⚙ compaction</span>
        <span class="hz-text">The harness puts this summary in place of the issue and the older turns. The next request starts from it.</span></div>
        ${goNext(nr && nr.msgs.find(m => m.compacted) ? msgDomId(nr, nr.msgs.find(m => m.compacted), run) : null, nr && `→ see the summary in round ${nr.n}'s input`)}`
    : r.oneoff ? html`<p class="muted small">The harness reads this reply. It is not added to any conversation.</p>`
    : html`
      ${calls.map(b => {
        const res = r.results[b.id];
        const c = run.calls[b.id];
        const actor = resultActor(run, b.id);
        const inNext = res && nr && nr.msgs.includes(res);
        return html`<div class="hz-step" id=${`chat-${r.n}-res-${b.id}`}>
          <div class="hz-step-h"><${ActorChip} a="harness" /> runs <b class="mono">${b.name}</b>
            <span class="muted small mono">${c ? oneLine(summarize(c, run), 70) : ''}</span>
            ${!res ? html`<span class="badge-sm pruned">no result</span>` : res.isError ? html`<span class="badge-sm err">error</span>` : html`<span class="badge-sm ok">ok</span>`}</div>
          ${byCall(b.id).map(h => html`<${HarnessLine} run=${run} rec=${h} />`)}
          ${c && isAgentCall(c) && html`<button class="link small" onClick=${() => { st.agent = b.id; st.round = null; changed(); }}>open ${roundAgent(run, { agent: b.id, name: buildRounds(run).find(x => x.agent === b.id)?.name })}'s rounds ›</button>`}
          ${res && html`<${Bubble} actor=${actor} title=${`result · ${RESULT_WHO[actor]}`}>
            <${NotedText} id=${'cr' + r.n + b.id} text=${res.text} /></${Bubble}>
            <div class="where">${inNext ? goNext(msgDomId(nr, res, run), `→ the model sees this in round ${nr.n}`)
              : nr ? 'not in the next request: compacted away first' : 'the run ended before another model call'}</div>`}
        </div>`;
      })}
      ${general.map(h => html`<${HarnessLine} run=${run} rec=${h} />`)}
      ${!calls.length && !general.length && html`<p class="muted small">No tool calls, and no harness action was recorded.</p>`}
      ${!calls.length && goNext()}
      ${lastMain && run.result && html`<div class="hz ${run.status === 'finished' ? 'ok' : 'err'}"><span class="hz-tag">⚙ run ended</span>
        <span class="hz-text">${run.result.stop_reason || run.result.subtype}</span></div>`}`}
    <button class="dl small" onClick=${() => downloadFile(`round${r.n}-context.json`, JSON.stringify(contextJSON(run, r), null, 2), 'application/json')}>⤓ context.json</button>
  </div>`;
}

// A tool result, with the lines the harness appended (`[harness: …]`) picked out.
function ResultWithNotes({ id, text }) {
  const notes = [], body = [];
  for (const line of String(text).split('\n')) (/^\[harness[ :]/.test(line.trim()) ? notes : body).push(line);
  return html`<div class="rd-result">
    <${Folded} id=${id} text=${body.join('\n').trimEnd() || '(no output)'} />
    ${notes.map(n => html`<div class="hz info"><span class="hz-tag">⚙ in result</span><span class="hz-text">${n.trim()}</span></div>`)}
  </div>`;
}

function CtxRow({ r, st, k, role, label, text, badges }) {
  const key = `${r.n}.${k}`;
  const open = st.open[key];
  return html`<div class="cm">
    <div class="cm-head" role="button" onClick=${() => toggle(st.open, key, false)}>
      <span class="role ${role}">${role}</span>${badges}
      <span class="cm-sum">${label ? html`<b>${label}</b> · ` : ''}${oneLine(text, 140)}</span>
      <span class="cm-chars">${fmtNum(String(text).length)} chars</span>
    </div>
    ${open && html`<div class="cm-body"><${Folded} id=${'cb' + key} text=${text || '(empty)'} /></div>`}
  </div>`;
}

function ToolDefs({ r, st }) {
  const key = `${r.n}.tools`;
  const names = r.tools ? r.tools.map(t => t.function?.name || t.name) : r.toolNames;
  return html`<div class="cm">
    <div class="cm-head" role="button" onClick=${() => toggle(st.open, key, false)}>
      <span class="role system">tools</span>
      <span class="cm-sum"><b>${plural(names.length, 'tool definition')}</b> · ${names.join(', ')}</span>
      ${!r.tools && html`<span class="cm-chars">names only</span>`}
    </div>
    ${st.open[key] && r.tools && html`<div class="cm-body"><pre class="json">${JSON.stringify(r.tools, null, 2)}</pre></div>`}
  </div>`;
}

function CtxMsg({ run, r, st, m, k, isNew }) {
  const neu = isNew && html`<span class="badge-sm new">new</span>`;
  if (m.role === 'assistant') {
    const calls = replyCalls(m);
    const text = replyText(m);
    const body = [text, ...calls.map(b => `→ ${b.name}(${JSON.stringify(b.input)})`)].filter(Boolean).join('\n');
    const prevRound = buildRounds(run).find(x => x.reply === m);
    return html`<${CtxRow} r=${r} st=${st} k=${k} role="assistant" text=${body || '(empty)'}
      label=${prevRound ? `round ${prevRound.n} output` : ''} badges=${neu} />`;
  }
  if (m.role === 'tool') {
    const s = sentText(r, m);
    const c = run.calls[m.toolUseId];
    const badges = html`${neu}${m.isError && html`<span class="badge-sm err">error</span>`}${s.pruned && html`<span class="badge-sm pruned"
      title=${`${fmtNum(s.pruned.chars_before)} → ${fmtNum(s.pruned.chars_sent)} chars`}>${s.pruned.action} · ${fmtNum(s.pruned.chars_before)} → ${fmtNum(s.pruned.chars_sent)}</span>`}`;
    return html`<${CtxRow} r=${r} st=${st} k=${k} role="tool" text=${s.text}
      label=${c ? `${c.name} result` : 'tool result'} badges=${badges} />`;
  }
  const label = m.compacted ? 'compacted summary (replaces the issue and older turns)'
    : m.fromPage ? 'your prompt' : r.msgs[0] === m && !r.oneoff ? 'task' : r.oneoff ? '' : 'harness message';
  return html`<${CtxRow} r=${r} st=${st} k=${k} role=${m.role} text=${m.text} label=${label}
    badges=${html`${neu}${m.compacted && html`<span class="badge-sm pruned">compacted</span>`}`} />`;
}

// ---------------------------------------------------------------- context over time

// How the main agent's context changed from request to request: which messages it held, in what
// state (sent whole, trimmed, cleared), and what compaction folded away for good. harness traces
// record this as a `ledger` on every system/context event; for older traces (and Claude Code's own
// stream) it is rebuilt from the rounds.
const CTX_STATES = {
  full: ['sent whole', 'var(--cx-full)'],
  summary: ['compaction summary', 'var(--cx-summary)'],
  trimmed: ['trimmed: head and tail kept', 'var(--cx-trim)'],
  cleared: ['cleared: placeholder only', 'var(--cx-clear)'],
};
const cellState = it => (it.state === 'full' && it.kind === 'summary' ? 'summary' : it.state);

function msgRef(run, m, taskSeq) {
  if (m.role === 'tool') return m.toolUseId;
  if (m.role === 'assistant') return buildRounds(run).find(x => x.reply === m)?.msgId || `a${m.rec?.seq}`;
  if (m.compacted) return `summary@${m.rec.seq}`;
  return m.rec?.seq === taskSeq || m.fromPage ? 'task' : `user@${m.rec?.seq}`;
}

function contextFrames(run) {
  if (run._frames && run._frames.n === run.events.length) return run._frames.list;
  const rounds = buildRounds(run).filter(r => r.agent === 'main' && !r.oneoff);
  const roundOf = new Map(rounds.filter(r => r.ctx).map(r => [r.ctx, r]));
  const list = [];
  const hasLedger = run.events.some(rec => rec.ev.subtype === 'context' && rec.ev.ledger);
  if (hasLedger) {
    let order = [], compaction = null;
    const items = new Map();
    for (const rec of run.events) {
      const ev = rec.ev;
      if (rec.agent !== 'main' || ev.type !== 'system') continue;
      if (ev.subtype === 'compact_boundary') { compaction = rec; continue; }
      if (ev.subtype !== 'context' || !ev.ledger) continue;
      const L = ev.ledger;
      const gone = new Set(L.removed);
      order = order.filter(ref => !gone.has(ref));
      for (const a of L.added) {
        // a summary takes the issue's place, right after the system prompt
        if (a.kind === 'summary') order.splice(Math.min(1, order.length), 0, a.ref); else order.push(a.ref);
        items.set(a.ref, { kind: a.kind, chars: a.chars, sent: a.chars_sent ?? a.chars, state: a.state });
      }
      for (const c of L.changed) {
        const it = items.get(c.ref);
        if (it) items.set(c.ref, { ...it, state: c.to, sent: c.chars_sent });
      }
      list.push({ rec, ev, round: roundOf.get(ev) || null, iteration: ev.iteration, ratio: ev.estimated_usage_ratio,
        window: ev.window, items: order.map(ref => ({ ref, ...items.get(ref) })), compaction,
        added: L.added.map(a => a.ref), removed: L.removed, changed: L.changed,
        hidden: L.chars_hidden_by_pruning, compacted: L.chars_compacted_away, reasoning: L.reasoning_chars_not_resent });
      compaction = null;
    }
  } else {
    const taskSeq = run.events.find(rec => rec.agent === 'main' && rec.ev.type === 'user' && typeof rec.ev.message?.content === 'string')?.seq;
    let prev = new Map(), compacted = 0, reasoning = 0;
    for (const r of rounds) {
      const items = [];
      if (r.system != null) items.push({ ref: 'system', kind: 'system', state: 'full', chars: r.system.length, sent: r.system.length });
      for (const m of r.msgs) {
        const full = m.role === 'assistant'
          ? replyText(m).length + replyCalls(m).reduce((n, b) => n + b.name.length + JSON.stringify(b.input).length, 0)
          : m.text.length;
        const s = m.role === 'tool' ? sentText(r, m) : null;
        items.push({ ref: msgRef(run, m, taskSeq), kind: m.compacted ? 'summary' : m.role,
          state: s?.pruned ? s.pruned.action : 'full', chars: full, sent: s ? s.text.length : full });
      }
      const now = new Map(items.map(it => [it.ref, it]));
      const removed = [...prev.keys()].filter(ref => !now.has(ref));
      compacted += removed.reduce((n, ref) => n + prev.get(ref).chars, 0);
      const changed = items.filter(it => prev.has(it.ref) && prev.get(it.ref).state !== it.state)
        .map(it => ({ ref: it.ref, from: prev.get(it.ref).state, to: it.state, chars: it.chars, chars_sent: it.sent }));
      list.push({ rec: r.rec, ev: r.ctx, round: r, iteration: r.iteration, ratio: r.ctx?.estimated_usage_ratio ?? null,
        window: r.ctx?.window ?? null, items, compaction: r.before.find(x => x.ev.subtype === 'compact_boundary') || null,
        added: items.filter(it => !prev.has(it.ref)).map(it => it.ref), removed, changed,
        hidden: items.reduce((n, it) => n + it.chars - it.sent, 0), compacted, reasoning });
      reasoning += replyThinking(r.reply).length;
      prev = now;
    }
  }
  for (const f of list) {
    f.sent = f.items.reduce((n, it) => n + it.sent, 0);
    f.full = f.items.reduce((n, it) => n + it.chars, 0);
  }
  run._frames = { n: run.events.length, list };
  return list;
}

function refLabel(run, ref) {
  if (ref === 'system') return 'system prompt';
  if (ref === 'task') return 'task (the issue)';
  if (/^summary/.test(ref)) return 'compaction summary (replaces the issue and older turns)';
  if (/^(nudge|user)/.test(ref)) return 'harness message (nudge)';
  const r = buildRounds(run).find(x => x.msgId === ref);
  if (r) return `round ${r.n} reply · ${roundSummary(r)}`;
  const c = run.calls[ref];
  if (c) {
    const rr = roundOfCall(run, ref);
    return `${c.name} result${rr ? ` from round ${rr.n}` : ''} · ${oneLine(summarize(c, run), 70)}`;
  }
  return ref;
}

const pct = x => `${Math.round(x * 100)}%`;
const frameLabel = f => (f.round ? `Round ${f.round.n}` : 'retried request') + (f.iteration != null ? ` · iter ${f.iteration}` : '');

function ContextTab({ run, st }) {
  const frames = contextFrames(run);
  if (!frames.length) return html`<p class="muted">No requests from the main agent yet.</p>`;
  const last = frames[frames.length - 1];
  const ratioMode = frames.some(f => f.ratio != null);
  const peak = frames.reduce((a, f) => (f.ratio ?? 0) > (a.ratio ?? 0) ? f : a, frames[0]);
  const nComp = frames.filter(f => f.compaction).length;
  const trimmedAt = frames.find(f => f.items.some(it => it.state === 'trimmed'));
  const clearedAt = frames.find(f => f.items.some(it => it.state === 'cleared'));
  const open = id => frames.find(f => f.round?.n === id) && openRound(run, id);
  return html`
    <p class="small muted">Each request resends the whole conversation: the model keeps nothing between calls.
      Before each one the harness may <b>trim</b> old tool results (keep the head and tail), <b>clear</b> them
      (leave a placeholder), or <b>compact</b> (replace older turns with a written summary). Trimmed and cleared
      text is still held by the harness; compacted text is gone for good.${!frames[0].ev?.ledger ? ' This trace has no ledger, so the view is rebuilt from the rounds.' : ''}</p>
    <div class="cx-stats">
      <div><b>${frames.length}</b><span>requests</span></div>
      ${ratioMode && html`<div><b>${pct(peak.ratio)}</b><span>peak window use (round ${peak.round?.n ?? '–'})</span></div>`}
      <div><b>${trimmedAt?.round ? 'R' + trimmedAt.round.n : '–'}</b><span>first trim</span></div>
      <div><b>${clearedAt?.round ? 'R' + clearedAt.round.n : '–'}</b><span>first clear</span></div>
      <div><b>${nComp}</b><span>compaction${nComp === 1 ? '' : 's'}</span></div>
      <div><b>${fmtNum(last.hidden)}</b><span>chars hidden by pruning now</span></div>
      <div><b>${fmtNum(last.compacted)}</b><span>chars compacted away</span></div>
      <div><b>${fmtNum(last.reasoning)}</b><span>reasoning chars never resent</span></div>
    </div>
    <h3>Context sent per request</h3>
    <${CtxLegend} withWould=${true} />
    <${CtxChart} frames=${frames} ratioMode=${ratioMode} onPick=${open} />
    <h3>Messages across requests</h3>
    <p class="small muted">One row per message, oldest at the top; one column per request. A row starts when the
      message is first sent and turns faint once compaction folds it away.</p>
    <${CtxLegend} withGone=${true} />
    <${CtxMap} run=${run} frames=${frames} onPick=${open} />
    <h3>What changed</h3>
    <${CtxChanges} run=${run} frames=${frames} st=${st} />
    <details class="cx-tablebox"><summary>Table view</summary><${CtxTable} frames=${frames} ratioMode=${ratioMode} /></details>`;
}

function CtxLegend({ withWould, withGone }) {
  return html`<div class="cx-legend">
    ${Object.entries(CTX_STATES).map(([, [label, color]]) => html`<span><i style=${`background:${color}`}></i>${label}</span>`)}
    ${withWould && html`<span><i class="would"></i>size without pruning</span>`}
    ${withGone && html`<span><i class="gone"></i>folded into a summary</span>`}
  </div>`;
}

function CtxChart({ frames, ratioMode, onPick }) {
  const [hover, setHover] = useState(null);
  const W = 680, H = 230, L = 36, R = 78, T = 8, B = 22;
  const val = f => ratioMode ? (f.ratio ?? 0) : f.sent;
  const would = f => f.sent ? val(f) * f.full / f.sent : 0;
  // Scaled to what was sent; the unpruned size may run off the top (it is clipped, and in the tooltip).
  const top = Math.max(...frames.map(val), ratioMode ? 0.8 : 1);
  const yMax = top * (ratioMode ? 1.15 : 1.04);
  const band = (W - L - R) / frames.length;
  const bw = Math.max(1, band - (band > 4 ? 2 : 0.5));
  const y = v => T + (H - T - B) * (1 - v / yMax);
  const x = i => L + i * band;
  const order = ['full', 'summary', 'trimmed', 'cleared'];
  const ticks = ratioMode ? [0, 0.25, 0.5, 0.75, 1, 1.5, 2].filter(t => t <= yMax)
    : [0, yMax / 2, yMax].map(Math.round);
  const lines = ratioMode ? [[0.3, 'trim'], [0.5, 'clear'], [0.75, 'compact']] : [];
  const wouldPts = frames.map((f, i) => `${x(i) + band / 2},${y(would(f))}`).join(' ');
  const h = hover != null ? frames[hover] : null;
  return html`<div class="cx-chart">
    <svg viewBox=${`0 0 ${W} ${H}`} role="img" aria-label="context size per request, stacked by message state"
      onMouseLeave=${() => setHover(null)}>
      ${ticks.map(t => html`<g><line class="cx-grid" x1=${L} x2=${W - R} y1=${y(t)} y2=${y(t)} />
        <text class="cx-axis" x=${L - 4} y=${y(t) + 3} text-anchor="end">${ratioMode ? pct(t) : fmtNum(t)}</text></g>`)}
      ${frames.map((f, i) => {
        let acc = 0;
        const v = val(f);
        const segs = order.map(s => {
          const chars = f.items.filter(it => cellState(it) === s).reduce((n, it) => n + it.sent, 0);
          const hgt = f.sent ? v * chars / f.sent : 0;
          const seg = { s, y0: acc, y1: acc + hgt };
          acc += hgt;
          return seg;
        }).filter(sg => sg.y1 > sg.y0);
        return html`<g class=${hover === i ? 'on' : ''}>
          ${segs.map((sg, k) => html`<rect x=${x(i) + (band - bw) / 2} width=${bw}
            y=${y(sg.y1) + (k < segs.length - 1 && y(sg.y0) - y(sg.y1) > 3 ? 1 : 0)}
            height=${Math.max(0.5, y(sg.y0) - y(sg.y1) - (k < segs.length - 1 && y(sg.y0) - y(sg.y1) > 3 ? 1 : 0))}
            style=${`fill:${CTX_STATES[sg.s][1]}`} />`)}
          ${f.compaction && html`<line class="cx-comp" x1=${x(i) + band / 2} x2=${x(i) + band / 2} y1=${T} y2=${H - B} />`}
        </g>`;
      })}
      <clipPath id="cx-clip"><rect x=${L} y=${T} width=${W - L - R} height=${H - T - B} /></clipPath>
      <polyline class="cx-would" points=${wouldPts} clip-path="url(#cx-clip)" />
      ${lines.filter(([t]) => t < yMax).map(([t, label]) => html`<g><line class="cx-thr" x1=${L} x2=${W - R} y1=${y(t)} y2=${y(t)} />
        <text class="cx-axis" x=${W - R + 4} y=${y(t) + 3}>${label} ${pct(t)}</text></g>`)}
      ${frames.map((f, i) => (f.round && (f.round.n === 1 || f.round.n % 10 === 0)) && html`<text class="cx-axis"
        x=${x(i) + band / 2} y=${H - 6} text-anchor="middle">R${f.round.n}</text>`)}
      ${frames.map((f, i) => html`<rect class="cx-hit" x=${x(i)} y=${T} width=${band} height=${H - T - B}
        onMouseEnter=${() => setHover(i)} onClick=${() => f.round && onPick(f.round.n)} />`)}
    </svg>
    ${h && html`<div class="cx-tip" style=${`left:${Math.min(78, Math.max(4, (x(hover) + band / 2) / W * 100))}%`}>
      <b>${frameLabel(h)}</b>${h.compaction ? ' · after a compaction' : ''}<br />
      ${h.items.length} messages · ${fmtNum(h.sent)} chars sent${h.ratio != null ? ` · ${pct(h.ratio)} of ${fmtNum(h.window)} tokens` : ''}<br />
      ${h.full > h.sent ? html`${fmtNum(h.full - h.sent)} chars hidden by pruning${ratioMode ? ` (unpruned: ${pct(would(h))})` : ''}<br />` : ''}
      ${order.map(s => { const n = h.items.filter(it => cellState(it) === s).length; return n ? html`<span class="cx-tipk"><i style=${`background:${CTX_STATES[s][1]}`}></i>${n} ${CTX_STATES[s][0].split(':')[0]}</span>` : ''; })}
      ${h.round && html`<div class="muted">click to open the round</div>`}
    </div>`}
  </div>`;
}

function CtxMap({ run, frames, onPick }) {
  const ref = useRef(null);
  const [tip, setTip] = useState(null);
  const rows = [], rowOf = new Map();
  frames.forEach(f => f.items.forEach(it => { if (!rowOf.has(it.ref)) { rowOf.set(it.ref, rows.length); rows.push(it.ref); } }));
  const cols = frames.length;
  const cw = Math.max(2, Math.min(14, Math.floor(660 / cols)));
  const ch = Math.max(2, Math.min(8, Math.floor(540 / rows.length)));
  useLayoutEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = cols * cw * dpr; cv.height = rows.length * ch * dpr;
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    const css = getComputedStyle(cv);
    const color = { full: css.getPropertyValue('--cx-full'), summary: css.getPropertyValue('--cx-summary'),
      trimmed: css.getPropertyValue('--cx-trim'), cleared: css.getPropertyValue('--cx-clear'), gone: css.getPropertyValue('--line') };
    const seen = new Set();
    const gx = cw > 3 ? 1 : 0, gy = ch > 3 ? 1 : 0;
    frames.forEach((f, c) => {
      const here = new Set();
      for (const it of f.items) {
        here.add(it.ref); seen.add(it.ref);
        g.fillStyle = color[cellState(it)];
        g.fillRect(c * cw, rowOf.get(it.ref) * ch, cw - gx, ch - gy);
      }
      g.fillStyle = color.gone;
      for (const r of seen) if (!here.has(r)) g.fillRect(c * cw, rowOf.get(r) * ch + Math.floor(ch / 2) - (ch > 3 ? 1 : 0), cw - gx, Math.max(1, Math.floor(ch / 3)));
    });
  });
  const at = e => {
    const b = ref.current.getBoundingClientRect();
    const c = Math.floor((e.clientX - b.left) / b.width * cols), r = Math.floor((e.clientY - b.top) / b.height * rows.length);
    return c >= 0 && c < cols && r >= 0 && r < rows.length ? { c, r, x: e.clientX - b.left, y: e.clientY - b.top } : null;
  };
  const t = tip && (() => {
    const f = frames[tip.c], refName = rows[tip.r];
    const it = f.items.find(x => x.ref === refName);
    const firstSeen = frames.findIndex(x => x.items.some(y => y.ref === refName));
    return { f, refName, it, gone: !it && firstSeen >= 0 && firstSeen < tip.c, before: firstSeen > tip.c };
  })();
  return html`<div class="cx-map">
    <canvas ref=${ref} style=${`width:${cols * cw}px;height:${rows.length * ch}px`}
      onMouseMove=${e => setTip(at(e))} onMouseLeave=${() => setTip(null)}
      onClick=${e => { const p = at(e); p && frames[p.c].round && onPick(frames[p.c].round.n); }}></canvas>
    <div class="cx-map-axis small muted">${plural(rows.length, 'message')} × ${plural(cols, 'request')} · hover a cell, click to open its round</div>
    ${t && html`<div class="cx-tip" style=${`left:${Math.min(tip.x + 12, cols * cw - 200)}px;top:${tip.y + 14}px`}>
      <b>${frameLabel(t.f)}</b><br />
      <span class="mono small">${t.refName}</span> · ${refLabel(run, t.refName)}<br />
      ${t.it ? html`<span class="cx-tipk"><i style=${`background:${CTX_STATES[cellState(t.it)][1]}`}></i>${CTX_STATES[cellState(t.it)][0]}</span>
        · ${t.it.sent === t.it.chars ? `${fmtNum(t.it.chars)} chars` : `${fmtNum(t.it.chars)} → ${fmtNum(t.it.sent)} chars`}`
        : t.gone ? 'folded into a summary: the model no longer sees it' : 'not written yet'}
    </div>`}
  </div>`;
}

function CtxChanges({ run, frames, st }) {
  const rows = [];
  for (const f of frames) {
    if (f.compaction) {
      const ev = f.compaction.ev;
      const removed = ev.removed || f.removed.map(ref => ({ ref }));
      const chars = removed.reduce((n, x) => n + (x.chars || 0), 0);
      rows.push({ f, tone: 'warn', tag: `compaction (${ev.trigger || 'threshold'})`,
        text: `${plural(removed.length, 'message')}${chars ? `, ${fmtNum(chars)} chars,` : ''} folded into ${ev.summary_ref || 'a summary'}; ${plural(ev.kept?.length ?? Math.max(0, (ev.messages_after ?? 2) - 2), 'recent message')} kept`,
        refs: removed.map(x => x.ref), compaction: ev });
    }
    for (const to of ['trimmed', 'cleared']) {
      const ch = f.changed.filter(c => c.to === to);
      if (!ch.length) continue;
      const lost = ch.reduce((n, c) => n + c.chars - c.chars_sent, 0);
      rows.push({ f, tone: to === 'cleared' ? 'err' : 'warn', tag: to,
        text: `${plural(ch.length, 'old tool result')} ${to} · ${fmtNum(lost)} chars no longer shown to the model`, refs: ch.map(c => c.ref) });
    }
  }
  if (!rows.length) return html`<p class="small muted">Nothing was pruned or compacted: every request carried the whole conversation.</p>`;
  return html`<div class="cx-changes">${rows.map((x, i) => {
    const key = `cx${i}`;
    return html`<div class="hz ${x.tone}">
      <span class="hz-tag">${x.tag}</span>
      <span class="hz-text">${x.text}</span>
      ${x.f.round && html`<span class="seq rd-link" role="button" onClick=${() => openRound(run, x.f.round.n)}>R${x.f.round.n}</span>`}
      <details class="hz-more" open=${!!st.open[key]} onToggle=${e => { st.open[key] = e.target.open; }}>
        <summary>which messages</summary>
        <ul class="cx-refs">${x.refs.map(r => html`<li><span class="mono">${r}</span> · ${refLabel(run, r)}</li>`)}</ul>
        ${x.compaction && html`<div class="ti-k">summary written</div><${Folded} id=${'cxs' + i} text=${x.compaction.summarizer_output || '(none)'} />`}
      </details>
    </div>`;
  })}</div>`;
}

function CtxTable({ frames, ratioMode }) {
  const n = (f, s) => f.items.filter(it => cellState(it) === s).length;
  return html`<table class="cx-table">
    <thead><tr><th>request</th><th>msgs</th><th>chars sent</th>${ratioMode && html`<th>window</th>`}<th>whole</th><th>trimmed</th><th>cleared</th><th>hidden</th><th>change</th></tr></thead>
    <tbody>${frames.map(f => html`<tr>
      <td>${frameLabel(f)}</td><td>${f.items.length}</td><td>${fmtNum(f.sent)}</td>${ratioMode && html`<td>${f.ratio != null ? pct(f.ratio) : '–'}</td>`}
      <td>${n(f, 'full') + n(f, 'summary')}</td><td>${n(f, 'trimmed')}</td><td>${n(f, 'cleared')}</td><td>${fmtNum(f.hidden)}</td>
      <td>${[f.added.length && `+${f.added.length}`, f.removed.length && `−${f.removed.length}`, f.changed.length && `~${f.changed.length}`].filter(Boolean).join(' ')}</td>
    </tr>`)}</tbody></table>`;
}

// In a round: how its request differs from the previous one, besides the new messages.
function RoundChanges({ run, r }) {
  const f = r.agent === 'main' && contextFrames(run).find(x => x.round === r);
  if (!f || (!f.changed.length && !f.removed.length)) return null;
  const by = to => f.changed.filter(c => c.to === to);
  return html`<div class="rd-before"><div class="ti-k">context changes since the previous request</div>
    ${f.removed.length > 0 && html`<div class="hz warn"><span class="hz-tag">folded away</span>
      <span class="hz-text">${plural(f.removed.length, 'message')} replaced by the compaction summary; the model no longer sees them</span></div>`}
    ${['trimmed', 'cleared'].map(to => by(to).length > 0 && html`<div class="hz ${to === 'cleared' ? 'err' : 'warn'}"><span class="hz-tag">${to}</span>
      <span class="hz-text">${by(to).map(c => refLabel(run, c.ref).split(' · ')[0]).join(', ')}</span></div>`)}
  </div>`;
}

function EventLog({ run, st }) {
  const q = st.q.trim().toLowerCase();
  const kinds = Object.keys(run.kindCounts).sort();
  const rows = run.events.filter(rec =>
    (!st.kind || rec.kinds.includes(st.kind)) &&
    (!q || JSON.stringify(rec.ev).toLowerCase().includes(q)));
  return html`
    <div class="ev-filters">
      <input placeholder="search inside the events' JSON…" value=${st.q} onInput=${e => { st.q = e.target.value; changed(); }} />
      <select value=${st.kind} onChange=${e => { st.kind = e.target.value; changed(); }}>
        <option value="">all kinds</option>
        ${kinds.map(k => html`<option value=${k}>${k} (${run.kindCounts[k]})</option>`)}
      </select>
      <button onClick=${() => { st.open = {}; changed(); }}>collapse all</button>
    </div>
    <div class="muted small">${rows.length} of ${run.events.length} events</div>
    <div class="ev-list">
      ${rows.map(rec => {
        const open = st.open[rec.seq];
        return html`<div class="ev-row ${open ? 'open' : ''}" id=${'ev-' + rec.seq}>
          <div class="ev-head" role="button" onClick=${() => { st.open[rec.seq] = !open; changed(); }}>
            <span class="ev-seq">#${rec.seq}</span>
            <span class="ev-t">+${(rec.t / 1000).toFixed(1)}s</span>
            <span class="ev-agent ${rec.agent === 'main' ? '' : 'sub'}">${agentLabel(run, rec.agent)}</span>
            <span class="ev-io ${rec.io || ''}">${rec.io === 'in' ? `→ T${rec.turn}` : rec.io === 'out' ? `T${rec.turn} ←` : ''}</span>
            <span class="ev-kind">${rec.kinds.join(', ')}</span>
            <span class="ev-sum">${eventSummary(run, rec)}</span>
          </div>
          ${open && html`<div class="ev-body">
            <button class="copy" onClick=${() => navigator.clipboard?.writeText(JSON.stringify(rec.ev, null, 2))}>copy JSON</button>
            <pre class="json">${JSON.stringify(rec.ev, null, 2)}</pre>
          </div>`}
        </div>`;
      })}
    </div>`;
}

// ---------------------------------------------------------------- app

let stickToBottom = true;
window.addEventListener('scroll', () => {
  stickToBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 120;
}, { passive: true });
// In replay mode, dropping a file anywhere on the page uploads it. In live mode drops are refused
// (but still caught, or the browser would navigate away to show the file). dragenter/dragleave
// fire for every child element crossed, so count them to know when the drag has left the window.
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
const replaying = () => store.mode === 'replay';
const setDragging = v => { if (store.ui.dragging !== v) { store.ui.dragging = v; changed(); } };
window.addEventListener('dragenter', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (replaying()) { dragDepth++; setDragging(true); }
});
window.addEventListener('dragover', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = replaying() ? 'copy' : 'none';
});
window.addEventListener('dragleave', e => { if (hasFiles(e) && replaying() && --dragDepth <= 0) { dragDepth = 0; setDragging(false); } });
window.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  setDragging(false);
  if (replaying()) loadReplayFile(e.dataTransfer.files[0]);
});
// Keyboard: [ and ] move between runs, e jumps to the next failed tool call (wrapping around).
let errCursor = -1;
function failedCalls() {
  return store.runs.flatMap(run => allCalls(run.root).filter(c => callStatus(c, run) === 'error').map(call => ({ run, call })));
}
function stepRun(dir) {
  const els = store.runs.map(r => document.getElementById('run-' + r.id)).filter(Boolean);
  if (!els.length) return;
  const cur = els.reduce((i, el, j) => el.getBoundingClientRect().top <= 90 ? j : i, -1);
  const el = els[Math.max(0, Math.min(els.length - 1, cur + dir))];
  stickToBottom = false;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
window.addEventListener('keydown', e => {
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && stepRound(e.key === 'ArrowRight' ? 1 : -1)) e.preventDefault();
  else if (e.key === '[' || e.key === ']') { e.preventDefault(); stepRun(e.key === ']' ? 1 : -1); }
  else if (e.key === 'e') {
    const list = failedCalls();
    if (!list.length) return;
    errCursor = (errCursor + 1) % list.length;
    jumpTo(list[errCursor].run, list[errCursor].call);
  }
});
window.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (store.ui.filterOpen) store.ui.filterOpen = false;
  else store.ui.inspect = null;
  changed();
});

const KEYS_HINT = html`keys: <kbd>[</kbd> <kbd>]</kbd> previous / next run · <kbd>e</kbd> next failed tool call ·
  <kbd>←</kbd> <kbd>→</kbd> previous / next round in the inspector · <kbd>Esc</kbd> close panels`;

function App() {
  const [, force] = useReducer(x => x + 1, 0);
  rerender = force;

  useEffect(() => {
    fetch('/api/config', { headers }).then(r => r.json()).then(c => {
      store.fixtures = c.fixtures || [];
      if (!store.cwd && c.default_cwd) store.cwd = c.default_cwd;
      changed();
    });
    const t = setInterval(() => { if (store.runs.some(r => r.status === 'running')) changed(); }, 1000);
    const onResize = () => changed();   // the outline's room depends on the window width
    window.addEventListener('resize', onResize);
    return () => { clearInterval(t); window.removeEventListener('resize', onResize); };
  }, []);

  useLayoutEffect(() => {
    if (stickToBottom) window.scrollTo(0, document.documentElement.scrollHeight);
  });

  return html`
    <header class="top">
      <div class="brand">LLM Visualizer</div>
      <div class="seg" role="radiogroup" aria-label="mode">
        ${[['live', 'Live', 'run the agent on a prompt'], ['replay', 'Replay', 'visualize a recorded .jsonl trace']].map(([m, label, tip]) => html`
          <button class=${store.mode === m ? 'on' : ''} role="radio" aria-checked=${store.mode === m} title=${tip}
            onClick=${() => setMode(m)}>${label}</button>`)}
      </div>
      ${store.mode === 'live' && html`<label class="cwd">
        <span>working directory</span>
        <input value=${store.cwd} placeholder="~/scratch/demo-repo" spellcheck="false"
          onInput=${e => { store.cwd = e.target.value; changed(); }} />
      </label>`}
      ${store.mode === 'replay' && html`<label class="trace">
        <span>trace</span>
        <select value=${store.trace} onChange=${e => { store.trace = e.target.value; store.fileError = null; changed(); startReplay(); }}>
          <option value="" disabled>choose a trace…</option>
          ${Object.keys(store.files).map(f => html`<option value=${FILE_MODE + f}>${f} (uploaded)</option>`)}
          ${store.fixtures.map(f => html`<option value=${f}>${f} (example)</option>`)}
        </select>
      </label>`}
      <input type="file" id="trace-file" hidden accept=".jsonl,.ndjson,.json,.txt"
        onChange=${e => { loadReplayFile(e.target.files[0]); e.target.value = ''; }} />
      <div class="filter-wrap">
        <button class="hdr-btn" onClick=${() => toggle(store.ui, 'filterOpen', false)}>
          view: ${VIEWS.find(v => v[0] === store.view)?.[1] || store.view} ▾
        </button>
        <${EventFilter} />
      </div>
      <button class="hdr-btn ol-toggle" onClick=${() => toggle(store.ui, 'outlineOpen', false)}>outline</button>
    </header>
    <div class="layout">
      <${Outline} />
      <main class="dialogue">
        ${store.runs.length === 0 && html`<div class="empty">
          ${store.mode === 'live'
            ? html`<p>Pick a working directory, type a request, and watch the agent work.</p>
              <p class="hint">Enter runs · Shift+Enter adds a new line · click a tool call to see the model call behind it (▸ shows its input in place) ·
                hover a card to see its <b>#n</b>, which opens that event in the run's inspector</p>
              <p class="hint">${KEYS_HINT}</p>`
            : html`<p>Replay mode: visualize a recorded trace. Nothing is run.</p>
              <button class="drop-zone" onClick=${pickFile}>
                <b>Upload a trace:</b> drop a stream-json <code>.jsonl</code> file here, or click to choose one
              </button>
              <p class="hint">or choose a trace in the header</p>
              <p class="hint">${KEYS_HINT}</p>`}
        </div>`}
        ${store.runs.map(run => html`<${Run} run=${run} key=${run.id} />`)}
        <${Composer} />
      </main>
    </div>
    <${Inspector} />
    ${store.ui.dragging && html`<div class="drop-overlay">Drop a .jsonl file to replay it</div>`}`;
}

render(html`<${App} />`, document.getElementById('app'));

// For automated checks of the page (see README.md); not used by the page itself.
window.__lens = { store, changed, buildRounds, verifyRound, canonRequest, canonJSON, sha256hex };
