/** @jsxImportSource @opentui/solid */
// @ts-nocheck

// Token Monsters - opencode token-usage sidebar.
//
// Reads the per-request breakdown written by token-usage-capture.ts. Two
// selectors:
//   Session:  Aktuel  (siden sidste compact)
//             Total   (hel session inkl. pre-compact, aldrig nulstillet)
//   View:     Prompts (per message: Input / Output / Tool calls / Files)
//             Tools   (aggregated: Input, Output, Tools by type)
//
// Overhead (opencode prompt, AGENTS.md pr. fil, tool defs pr. tool,
// skill defs, Skills) is shown in both scopes. Breakdown ratios are o200k,
// calibrated so the current window matches OpenCode's real token counts.

import { createMemo, createSignal, onCleanup, onMount, For, Show } from "solid-js"
import { homedir } from "node:os"
import { join } from "node:path"

const PLUGIN_ID = "token-usage"
const DEFAULT_ORDER = 150
const REFRESH_MS = 8000
const EVENT_DEBOUNCE_MS = 700
const TOOL_ROWS = 8
const LABEL_W = 18
const OPEN_KV_KEY = "tm_open"

// Sidebar on/off, toggled by the /tokenmonster command. Persisted in kv so it
// survives restarts; a module-level signal lets the command hide/show every
// mounted sidebar instance live without a restart.
const [enabled, setEnabled] = createSignal(true)

const NUM = new Intl.NumberFormat("da-DK")
const fmt = (n) => NUM.format(Math.round(Number(n) || 0))
const fmtK = (n) => {
  n = Number(n) || 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}
const tokGuess = (s) => Math.ceil(String(s || "").length / 4)
const clip = (v, w) => {
  const s = String(v)
  return s.length <= w ? s : `${s.slice(0, Math.max(0, w - 1))}…`
}
const sumVals = (obj) => Object.values(obj || {}).reduce((a, b) => a + (Number(b) || 0), 0)

// ---------------------------------------------------------------------------
// Cache read.
// ---------------------------------------------------------------------------

async function readCapture(api, sessionID) {
  try {
    if (typeof Bun === "undefined") return null
    const dir = api.state?.path?.config
    const candidates = [
      dir ? `${dir.replace(/[\\/]+$/, "")}/.token-usage-cache.json` : null,
      `${import.meta.dir.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]+$/, "")}/.token-usage-cache.json`,
    ]
    try {
      candidates.unshift(join(homedir(), ".config", "opencode", ".token-usage-cache.json"))
    } catch {}
    let data = null
    for (const path of candidates) {
      if (!path) continue
      // Isolate per-file failures: one unreadable cache must not discard the rest.
      try {
        const file = Bun.file(path)
        if (!(await file.exists())) continue
        const current = await file.json()
        if (!data || current?.sessions?.[sessionID]) data = current
        if (current?.sessions?.[sessionID]) break
      } catch {}
    }
    if (!data) return null
    const all = { total: [], overheadTotal: {} }
    for (const session of Object.values(data?.sessions || {})) {
      all.total.push(...(session?.total || []))
      mergeTools(all.overheadTotal, session?.overheadTotal || {})
    }
    all.total.sort((a, b) => (a?.o || 0) - (b?.o || 0))
    return { session: data?.sessions?.[sessionID] || null, all }
  } catch {
    return null
  }
}

function fileLabel(p) {
  const raw = p?.filename || p?.source?.path || p?.url || "file"
  const base = String(raw).split(/[\\/]/).pop() || String(raw)
  return base || "file"
}

function shortTarget(raw) {
  if (typeof raw !== "string") return
  const s = raw.trim()
  if (!s) return
  if (/^https?:\/\//i.test(s)) return s
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith("/") || s.startsWith("./") || s.startsWith("../") || s.includes("\\") || s.includes("/")) return s
}

function addTarget(bucket, raw) {
  const key = shortTarget(raw)
  if (key) bucket[key] = (bucket[key] || 0) + 1
}

function collectTargets(name, input, output) {
  const out = {}
  const add = (raw) => addTarget(out, raw)
  if (name === "read" || name === "edit" || name === "write") add(input?.filePath)
  else if (name === "webfetch") add(input?.url)
  else if (name === "apply_patch") {
    const patch = typeof input?.patchText === "string" ? input.patchText : ""
    for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) add(m[1])
  }
  else if (name === "glob") add(input?.pattern)
  else if (name === "grep") {
    add(input?.include)
    add(input?.path)
  }
  else if (name === "bash") {
    add(input?.workdir)
    const m = typeof output === "string" ? output.match(/\b([A-Za-z]:\\[^\r\n]+|\/[A-Za-z0-9._\/-]+(?:\.[A-Za-z0-9_-]+)?|https?:\/\/\S+)/g) : null
    for (const hit of m || []) add(hit)
  } else {
    for (const v of Object.values(input || {})) {
      if (typeof v === "string") add(v)
      else if (Array.isArray(v)) for (const x of v) add(x)
    }
  }
  return Object.keys(out)
}

function allocateTargets(targets, total) {
  const uniq = [...new Set((targets || []).filter(Boolean))]
  if (uniq.length === 0) return {}
  const n = Math.max(0, Math.round(Number(total) || 0))
  const base = Math.floor(n / uniq.length)
  let rem = n - base * uniq.length
  const out = {}
  for (const key of uniq) {
    out[key] = base + (rem > 0 ? 1 : 0)
    if (rem > 0) rem--
  }
  return out
}

function toolTargets(name, input, output, totalTokens) {
  return allocateTargets(collectTargets(name, input, output), totalTokens)
}

function skillLabel(input) {
  const raw = input?.skill || input?.name || input?.id || input?.path || input?.file || "skill"
  return String(raw).split(/[\\/]/).pop() || "skill"
}

function msgRole(m) {
  return m?.role ?? m?.type ?? m?.info?.role ?? "assistant"
}

function msgTokens(m) {
  return m?.tokens ?? m?.info?.tokens ?? null
}

function msgTime(m) {
  return m?.time?.created ?? m?.info?.time?.created ?? m?.time?.completed ?? 0
}

function msgParts(api, m) {
  if (Array.isArray(m?.content)) return m.content
  if (Array.isArray(m?.parts)) return m.parts
  try {
    const id = m?.id ?? m?.info?.id
    if (id && typeof api.state?.part === "function") return api.state.part(id) || []
  } catch {}
  return []
}

// V2 data-layer first (state.session.message.list), V1 state API as fallback.
// V2 messages carry role in `type` and content inline; V1 uses info/parts.
function listLiveMessages(api, sessionID) {
  if (!sessionID) return []
  try {
    const msgApi = api.state?.session?.message
    if (msgApi && typeof msgApi.list === "function") {
      const list = msgApi.list(sessionID) ?? []
      if (Array.isArray(list) && list.length) return list
    }
  } catch {}
  try {
    const list = api.state?.session?.messages?.(sessionID) ?? []
    if (Array.isArray(list) && list.length) return list
  } catch {}
  return []
}

function partText(v) {
  if (typeof v === "string") return v
  if (v == null) return ""
  try { return JSON.stringify(v) } catch { return String(v) }
}

function fallbackEntry(message, parts) {
  const role = msgRole(message) === "user" ? "u" : "a"
  const e = { r: role, in: 0, out: 0, t: {}, tc: {}, tt: {}, f: 0, fl: {}, s: 0, sl: {}, o: msgTime(message) }
  for (const p of parts || []) {
    if ((p?.type === "text" || p?.type === "reasoning") && !p.synthetic && typeof p.text === "string") {
      const n = tokGuess(p.text)
      if (role === "u") e.in += n
      else e.out += n
    } else if (p?.type === "tool") {
      const name = p.tool || p.name || "tool"
      const out = partText(p.state?.output ?? p.output ?? p.result)
      const args = p.state?.input ? JSON.stringify(p.state.input) : partText(p.input ?? p.args)
      const n = tokGuess(out) + tokGuess(args)
      if (name === "skill") {
        e.s += n
        const label = skillLabel(p.state?.input ?? p.input)
        e.sl[label] = (e.sl[label] || 0) + n
      }
      else {
        e.t[name] = (e.t[name] || 0) + n
        e.tc[name] = (e.tc[name] || 0) + 1
        const targets = toolTargets(name, p.state?.input ?? p.input, out, n)
        if (Object.keys(targets).length) e.tt[name] = targets
      }
      for (const a of p.state?.attachments || []) {
        const v = a?.source?.text?.value
        if (typeof v === "string") {
          const n = tokGuess(v)
          e.f += n
          const label = fileLabel(a)
          e.fl[label] = (e.fl[label] || 0) + n
        }
      }
    } else if (p?.type === "file") {
      const v = p.source?.text?.value
      if (typeof v === "string") {
        const n = tokGuess(v)
        e.f += n
        const label = fileLabel(p)
        e.fl[label] = (e.fl[label] || 0) + n
      }
    } else if (p?.type === "patch") {
      for (const file of p.files || []) addTarget((e.tt.edit ||= {}), file)
    }
  }
  return e
}

function buildFallback(api, sessionID) {
  try {
    const messages = listLiveMessages(api, sessionID)
    const entries = messages.map((m) => fallbackEntry(m, msgParts(api, m)))
    return { current: entries.length ? [entries[entries.length - 1]] : [], total: entries, overheadCurrent: {}, overheadTotal: {} }
  } catch {
    return { current: [], total: [], overheadCurrent: {}, overheadTotal: {} }
  }
}

function entryTotal(e) {
  return (e?.in || 0) + (e?.out || 0) + sumVals(e?.t) + (e?.f || 0) + (e?.s || 0)
}

function realLastWindow(api, sessionID) {
  try {
    const messages = listLiveMessages(api, sessionID)
    let last = null
    for (const m of messages) {
      const t = msgTokens(m)
      if (t && ((t.output || 0) > 0 || (t.input || 0) > 0 || (t.cache?.read || 0) > 0)) last = t
    }
    if (!last) return 0
    return (last.input || 0) + (last.output || 0) + (last.reasoning || 0) + (last.cache?.read || 0) + (last.cache?.write || 0)
  } catch {
    return 0
  }
}

function approxEntriesTotal(entries) {
  let n = 0
  for (const e of entries || []) n += (e?.in || 0) + (e?.out || 0) + sumVals(e?.t) + (e?.f || 0) + (e?.s || 0)
  return n
}

function approxOverheadTotal(ov) {
  return (ov?.opencode || 0) + (ov?.agents || 0) + (ov?.skillDefs || 0) + (ov?.toolDefs || 0)
}

function scaleEntries(entries, f) {
  if (!f || f === 1) return entries
  return (entries || []).map((e) => ({
    ...e,
    in: Math.round((e.in || 0) * f),
    out: Math.round((e.out || 0) * f),
    t: Object.fromEntries(Object.entries(e.t || {}).map(([k, v]) => [k, Math.round((Number(v) || 0) * f)])),
    tc: { ...(e.tc || {}) },
    tt: e.tt || {},
    f: Math.round((e.f || 0) * f),
    fl: Object.fromEntries(Object.entries(e.fl || {}).map(([k, v]) => [k, Math.round((Number(v) || 0) * f)])),
    s: Math.round((e.s || 0) * f),
    sl: e.sl ? Object.fromEntries(Object.entries(e.sl).map(([k, v]) => [k, Math.round((Number(v) || 0) * f)])) : e.sl,
  }))
}

function scaleOverhead(ov, f) {
  if (!ov) return ov
  if (!f || f === 1) return ov
  const out = {
    ...ov,
    opencode: Math.round((ov.opencode || 0) * f),
    agents: Math.round((ov.agents || 0) * f),
    skillDefs: Math.round((ov.skillDefs || 0) * f),
    toolDefs: Math.round((ov.toolDefs || 0) * f),
  }
  if (ov.toolDefsByTool) out.toolDefsByTool = Object.fromEntries(Object.entries(ov.toolDefsByTool).map(([k, v]) => [k, Math.round((Number(v) || 0) * f)]))
  if (ov.agentsByFile) out.agentsByFile = Object.fromEntries(Object.entries(ov.agentsByFile).map(([k, v]) => [k, Math.round((Number(v) || 0) * f)]))
  if (ov.skillDefsBySkill) out.skillDefsBySkill = Object.fromEntries(Object.entries(ov.skillDefsBySkill).map(([k, v]) => [k, Math.round((Number(v) || 0) * f)]))
  return out
}

function mergeLiveEntries(captured, live) {
  const cap = Array.isArray(captured) ? [...captured] : []
  const liveArr = Array.isArray(live) ? live : []
  for (const liveEntry of liveArr) {
    let idx = cap.findIndex((e) => e?.o === liveEntry?.o && e?.r === liveEntry?.r)
    if (idx < 0) idx = cap.findIndex((e) => e?.r === liveEntry?.r && Math.abs((e?.o || 0) - (liveEntry?.o || 0)) < 1000)
    if (idx >= 0) {
      if (entryTotal(liveEntry) >= entryTotal(cap[idx])) cap[idx] = liveEntry
    } else {
      cap.push(liveEntry)
    }
  }
  return cap.sort((a, b) => (a?.o || 0) - (b?.o || 0))
}

// ---------------------------------------------------------------------------
// Node tree builders.  A node = { label, tokens, frac?, children? }.
// ---------------------------------------------------------------------------

function toolChildren(toolsObj, countsObj, targetsObj) {
  const arr = Object.entries(toolsObj || {})
    .map(([name, tokens]) => ({ name, tokens: Number(tokens) || 0, count: countsObj ? Number(countsObj[name]) || 0 : 0, targets: targetsObj?.[name] || null }))
    .filter((t) => t.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
  const withLabel = (name, count) => (countsObj && count > 0 ? `${name} (${count})` : name)
  const targetChildren = (targets) => Object.entries(targets || {}).sort((a, b) => b[1] - a[1]).map(([full, tokens]) => ({ label: clip(full, LABEL_W), fullLabel: full, tokens: Number(tokens) || 0 }))
  const head = arr.slice(0, TOOL_ROWS).map((t) => ({
    label: withLabel(t.name, t.count),
    tokens: t.tokens,
    children: targetChildren(t.targets),
  }))
  const rest = arr.slice(TOOL_ROWS)
  const tail = rest.reduce((s, t) => s + t.tokens, 0)
  if (tail > 0) head.push({ label: withLabel("other", rest.reduce((s, t) => s + t.count, 0)), tokens: tail })
  return head
}

// Files node: a foldable "Files" with one child per loaded file (name -> tokens).
// Falls back to a plain leaf when no per-file detail is present (old cache data).
function filesNode(flObj, total) {
  const kids = Object.entries(flObj || {})
    .map(([label, tokens]) => ({ label: clip(label, LABEL_W), fullLabel: label, tokens: Number(tokens) || 0 }))
    .filter((f) => f.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
  return { label: "Files", tokens: total, children: kids }
}

function overheadNode(ov, scope, skillsTotal, skillsObj) {
  const kids = []
  if ((ov.opencode || 0) > 0) kids.push({ label: "opencode", tokens: ov.opencode })
  if ((ov.agents || 0) > 0) {
    const node = { label: "AGENTS.md", tokens: ov.agents }
    if (ov.agentsByFile) node.children = toolChildren(ov.agentsByFile)
    kids.push(node)
  }
  if ((ov.toolDefs || 0) > 0) {
    const node = { label: "tool defs", tokens: ov.toolDefs }
    if (ov.toolDefsByTool) node.children = toolChildren(ov.toolDefsByTool)
    kids.push(node)
  }
  if ((ov.skillDefs || 0) > 0) {
    const node = { label: "skill defs", tokens: ov.skillDefs }
    if (ov.skillDefsBySkill) node.children = toolChildren(ov.skillDefsBySkill)
    kids.push(node)
  }
  if ((skillsTotal || 0) > 0) kids.push({ label: "Skills", tokens: skillsTotal, children: toolChildren(skillsObj) })
  return { label: "Overhead", tokens: kids.reduce((s, k) => s + k.tokens, 0), children: kids }
}

function mergeTools(target, src) {
  for (const [k, v] of Object.entries(src || {})) target[k] = (target[k] || 0) + (Number(v) || 0)
}

function groupTurns(entries) {
  const turns = []
  let turn = null
  const start = () => ({ in: 0, out: 0, t: {}, tc: {}, tt: {}, f: 0, fl: {} })
  for (const e of entries || []) {
    if (e.r === "u") {
      if (turn) turns.push(turn)
      turn = start()
      turn.in += e.in || 0
    } else {
      if (!turn) turn = start()
      turn.out += e.out || 0
    }
    mergeTools(turn.t, e.t)
    mergeTools(turn.tc, e.tc)
    for (const [tool, targets] of Object.entries(e.tt || {})) {
      turn.tt[tool] ||= {}
      mergeTools(turn.tt[tool], targets)
    }
    mergeTools(turn.fl, e.fl)
    turn.f += e.f || 0
  }
  if (turn) turns.push(turn)
  return turns.filter((t) => t.in + t.out + sumVals(t.t) + t.f > 0)
}

function msgNode(t, n) {
  const kids = []
  if (t.in > 0) kids.push({ label: "Input", tokens: t.in })
  if (t.out > 0) kids.push({ label: "Output", tokens: t.out })
  const toolsTotal = sumVals(t.t)
  if (toolsTotal > 0) kids.push({ label: "Tool calls", tokens: toolsTotal, children: toolChildren(t.t, t.tc, t.tt) })
  if (t.f > 0) kids.push(filesNode(t.fl, t.f))
  return { label: `Msg ${n}`, tokens: t.in + t.out + toolsTotal + t.f, children: kids }
}

function buildList(entries, ov, scope, view) {
  let skillsTotal = 0
  let filesTotal = 0
  const skills = {}
  for (const e of entries || []) {
    skillsTotal += e.s || 0
    mergeTools(skills, e.sl)
    filesTotal += e.f || 0
  }
  const list = [overheadNode(ov, scope, skillsTotal, skills)]

  if (view === "prompt") {
    const turns = groupTurns(entries)
    const kids = turns.map((t, i) => msgNode(t, i + 1))
    list.push({ label: "Prompts", tokens: kids.reduce((s, k) => s + k.tokens, 0), children: kids })
  } else {
    let input = 0, output = 0
    const tools = {}, toolCounts = {}, toolTargets = {}, files = {}
    for (const e of entries || []) {
      input += e.in || 0
      output += e.out || 0
      mergeTools(tools, e.t)
      mergeTools(toolCounts, e.tc)
      for (const [tool, targets] of Object.entries(e.tt || {})) {
        toolTargets[tool] ||= {}
        mergeTools(toolTargets[tool], targets)
      }
      mergeTools(files, e.fl)
    }
    const pKids = []
    if (input > 0) pKids.push({ label: "Input", tokens: input })
    if (output > 0) pKids.push({ label: "Output", tokens: output })
    if (filesTotal > 0) pKids.push(filesNode(files, filesTotal))
    list.push({ label: "Prompts", tokens: input + output + filesTotal, children: pKids })
    const toolsTotal = sumVals(tools)
    if (toolsTotal > 0) list.push({ label: "Tools", tokens: toolsTotal, children: toolChildren(tools, toolCounts, toolTargets) })
  }

  setFrac(list)
  return list.filter((n) => n.tokens > 0)
}

function setFrac(nodes) {
  const max = nodes.reduce((m, n) => Math.max(m, n.tokens), 0)
  for (const n of nodes) {
    n.frac = max > 0 ? n.tokens / max : 0
    if (n.children && n.children.length) setFrac(n.children)
  }
}

// ---------------------------------------------------------------------------
// UI primitives.
// ---------------------------------------------------------------------------

function palette(api) {
  const t = api.theme.current
  return { text: t.text, muted: t.textMuted, accent: t.primary, bar: t.primary, track: t.border }
}

function Line(props) {
  return (
    <box flexDirection="row" justifyContent="space-between" gap={1}>
      <text fg={props.colors.muted}>{props.label}</text>
      <text fg={props.strong ? props.colors.text : props.colors.muted}>
        {props.strong ? <b>{props.value}</b> : props.value}
      </text>
    </box>
  )
}

function Bar(props) {
  const width = props.width || 8
  const filled = Math.max(0, Math.min(width, Math.round((props.frac || 0) * width)))
  return (
    <text wrapMode="none">
      <span style={{ fg: props.dim ? props.colors.track : props.colors.bar }}>{"█".repeat(filled)}</span>
      <span style={{ fg: props.colors.track }}>{"░".repeat(width - filled)}</span>
    </text>
  )
}

function Selector(props) {
  return (
    <box flexDirection="row" gap={1} alignItems="center">
      <box width={8}>
        <text fg={props.colors.muted}>{`${props.label}:`}</text>
      </box>
      <text fg={props.colors.muted} onMouseDown={props.onToggle}>{"<"}</text>
      <text fg={props.colors.accent}><b>{props.value}</b></text>
      <text fg={props.colors.muted} onMouseDown={props.onToggle}>{">"}</text>
    </box>
  )
}

function TreeRow(props) {
  const node = props.node
  const foldable = !!(node.children && node.children.length > 0)
  const isOpen = () => !!props.expanded()[props.path]
  const labelStr = () => " ".repeat(props.depth) + (foldable ? (isOpen() ? "▼ " : "▶ ") : "") + node.label
  const value = () => typeof node.count === "number" ? `${node.count}x` : fmtK(node.tokens)
  const click = () => {
    if (node.fullLabel) props.toggleDetail(node.fullLabel)
    else if (foldable) props.toggle(props.path)
  }
  return (
    <box flexDirection="column" gap={0}>
      <box flexDirection="row" gap={1} alignItems="center" onMouseDown={click}>
        <box width={LABEL_W}>
          <text fg={props.depth > 0 ? props.colors.muted : props.colors.text}>{clip(labelStr(), LABEL_W)}</text>
        </box>
        <box flexGrow={1}>
          <Bar colors={props.colors} frac={node.frac} dim={props.depth > 0} />
        </box>
        <box width={7} justifyContent="flex-end">
          <text fg={props.colors.muted}>{value()}</text>
        </box>
      </box>
      <Show when={foldable && isOpen()}>
        <For each={node.children}>
          {(child) => (
            <TreeRow node={child} depth={props.depth + 1} path={`${props.path}/${child.label}`} colors={props.colors} expanded={props.expanded} toggle={props.toggle} toggleDetail={props.toggleDetail} />
          )}
        </For>
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------
// View.
// ---------------------------------------------------------------------------

function View(props) {
  const api = props.api
  const [capture, setCapture] = createSignal(null)
  const [open, setOpen] = createSignal(api.kv?.get?.(OPEN_KV_KEY, false) === true)
  const [expanded, setExpanded] = createSignal({})
  const [detail, setDetail] = createSignal("")
  const [scope, setScope] = createSignal(api.kv?.get?.("tm_scope", "actual") || "actual")
  const [view, setView] = createSignal(api.kv?.get?.("tm_view", "prompt") || "prompt")

  const toggle = (path) => {
    setExpanded((e) => ({ ...e, [path]: !e[path] }))
  }
  const toggleDetail = (label) => setDetail((cur) => cur === label ? "" : label)
  const toggleOpen = () => {
    const next = !open()
    try { api.kv?.set?.(OPEN_KV_KEY, next) } catch {}
    setOpen(next)
  }
  const toggleScope = () => { const v = scope() === "total" ? "actual" : "total"; try { api.kv?.set?.("tm_scope", v) } catch {} ; setScope(v) }
  const toggleView = () => { const v = view() === "prompt" ? "tool" : "prompt"; try { api.kv?.set?.("tm_view", v) } catch {} ; setView(v) }

  let disposed = false
  let unsubscribe, timer, debounce

  const refreshCapture = () => readCapture(api, props.session_id).then((d) => !disposed && setCapture(d)).catch(() => {})

  onMount(() => {
    refreshCapture()
    unsubscribe = api.event.on("message.updated", () => {
      setCapture((v) => v ? { ...v } : v)
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(refreshCapture, EVENT_DEBOUNCE_MS)
    })
    timer = setInterval(refreshCapture, REFRESH_MS)
  })
  onCleanup(() => {
    disposed = true
    if (unsubscribe) unsubscribe()
    if (timer) clearInterval(timer)
    if (debounce) clearTimeout(debounce)
  })

  const head = createMemo(() => {
    try {
      const id = props.session_id
      const messages = listLiveMessages(api, id)
      let last = null
      for (const m of messages) {
        const t = msgTokens(m)
        if (t && ((t.output || 0) > 0 || (t.input || 0) > 0)) last = t
      }
      const ctx = last ? (last.input || 0) + (last.output || 0) + (last.reasoning || 0) + (last.cache?.read || 0) + (last.cache?.write || 0) : 0
      return {
        has: !!last,
        contextNow: ctx,
        cachedPct: ctx > 0 && last ? Math.round(((last.cache?.read || 0) / ctx) * 100) : 0,
      }
    } catch {
      return { has: false, contextNow: 0, cachedPct: 0 }
    }
  })

  const model = createMemo(() => {
    const live = buildFallback(api, props.session_id)
    const raw = capture()
    const cap = raw?.session || live
    const sc = scope()
    // Calibration: scale approx breakdown so the current window matches
    // OpenCode's real token counts (input+output+reasoning+cache).
    const sinceBase = cap.sinceCompact || cap.current || []
    const approxNow = approxOverheadTotal(cap.overheadCurrent || {}) + approxEntriesTotal(mergeLiveEntries(sinceBase, live.total || []))
    const realNow = realLastWindow(api, props.session_id)
    const factor = approxNow > 0 && realNow > 0 ? realNow / approxNow : 1
    if (sc === "total") {
      // Total = hel session inkl. pre-compact (aldrig nulstillet).
      // Overhead er altid sidste snapshot (overheadLast/Current) — aldrig den
      // legacy summerede overheadTotal fra før snapshot-fixet.
      const base = cap.total || []
      const entries = scaleEntries(mergeLiveEntries(base, live.total || []), factor)
      const ov = scaleOverhead(cap.overheadLast || cap.overheadCurrent || {}, factor)
      return { ready: true, list: buildList(entries, ov, "total", view()) }
    }
    // Aktuel = siden sidste compact.
    const base = cap.sinceCompact || cap.current || []
    if (!Array.isArray(base)) return { ready: false, list: [] }
    const entries = scaleEntries(mergeLiveEntries(base, live.total || []), factor)
    const ov = scaleOverhead(cap.overheadCurrent || {}, factor)
    return { ready: true, list: buildList(entries, ov, "actual", view()) }
  })

  const colors = () => palette(api)
  const scopeLabel = () => (scope() === "total" ? "Total" : "Aktuel")
  const viewLabel = () => (view() === "prompt" ? "Prompts" : "Tools")

  return (
    <Show when={enabled()}>
      <box flexDirection="column" gap={0}>
        <box flexDirection="row" gap={1} alignItems="center" onMouseDown={toggleOpen}>
          <text fg={colors().text}>{open() ? "▼" : "▶"}</text>
          <text fg={colors().text}><b>Token Monsters:</b></text>
          <Show when={!open() && head().has}>
            <box flexGrow={1} justifyContent="flex-end">
              <text fg={colors().muted}>{fmtK(head().contextNow)}</text>
            </box>
          </Show>
        </box>

        <Show when={open()}>
          <box flexDirection="column" gap={0}>
            <box flexDirection="column" gap={0}>
              <Selector colors={colors()} label="Session" value={scopeLabel()} onToggle={toggleScope} />
              <Selector colors={colors()} label="View" value={viewLabel()} onToggle={toggleView} />
            </box>

            <box flexDirection="column" gap={0}>
              <Show when={detail()}>
                <box flexDirection="column" gap={0} paddingTop={1}>
                  <text fg={colors().muted}>Selected path</text>
                  <text fg={colors().muted} onMouseDown={() => setDetail("")}>{detail()}</text>
                </box>
              </Show>
            </box>

            <box flexDirection="column" gap={0} paddingTop={1}>
              <text fg={colors().muted}>{scope() === "total" ? "Hel session ~approx" : "Siden sidste compact ~approx"}</text>
              <Show when={model().ready} fallback={<text fg={colors().muted}>No session data</text>}>
                <For each={model().list}>
                  {(item) => <TreeRow node={item} depth={0} path={item.label} colors={colors()} expanded={expanded} toggle={toggle} toggleDetail={toggleDetail} />}
                </For>
              </Show>
            </box>
          </box>
        </Show>
      </box>
    </Show>
  )
}

// Register the /tokenmonster slash command + command-palette entry that toggles
// the sidebar panel. The running opencode (1.17+) exposes api.keymap.registerLayer
// (slashName/run); older typed builds expose api.command.register (slash/onSelect).
// Support both so the toggle works regardless of host version.
function registerCommand(api, toggle) {
  const def = {
    name: "tokenmonster.toggle",
    title: "Token Monsters: toggle sidebar",
    category: "Token Monsters",
    namespace: "palette",
    slashName: "tokenmonster",
    run: () => toggle(),
  }
  try {
    if (api.keymap?.registerLayer) {
      api.keymap.registerLayer({ commands: [def], bindings: [] })
      return
    }
  } catch {}
  try {
    if (api.command?.register) {
      api.command.register(() => [
        { title: def.title, value: def.name, category: def.category, slash: { name: def.slashName }, onSelect: () => toggle() },
      ])
    }
  } catch {}
}

function colorToHex(value: any): string | undefined {
  try {
    if (typeof value === "string" && value) return value
    const b = value?.buffer ?? value
    if (b && Number.isFinite(b[0]) && Number.isFinite(b[1]) && Number.isFinite(b[2])) {
      const hex = [b[0], b[1], b[2]].map((x: number) =>
        Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0"),
      )
      return `#${hex.join("")}`
    }
  } catch {}
  return undefined
}

function pickColor(t: any, ...paths: string[]): string | undefined {
  for (const p of paths) {
    try {
      const v = colorToHex(p.split(".").reduce((acc: any, k: string) => (acc == null ? acc : acc[k]), t))
      if (v) return v
    } catch {}
  }
  return undefined
}

// V1 theme: flat strings. V2 theme: nested RGBA buffers
// (text.default, text.subdued, text.feedback.*.default, hue.accent.400, border.default).
function safeTheme(context) {
  const t = context?.theme ?? {};
  const base = {
    text: pickColor(t, "current.text", "text.default", "text"),
    textMuted: pickColor(t, "current.textMuted", "text.subdued", "text.muted"),
    primary: pickColor(t, "current.primary", "hue.accent.400", "primary.default", "primary"),
    border: pickColor(t, "current.border", "border.default", "border"),
    backgroundElement: pickColor(t, "current.backgroundElement", "background.element"),
    error: pickColor(t, "current.error", "text.feedback.error.default", "error.default", "error"),
    success: pickColor(t, "current.success", "text.feedback.success.default", "success.default", "success"),
    warning: pickColor(t, "current.warning", "text.feedback.warning.default", "warning.default", "warning"),
  };
  return {
    current: new Proxy(base, {
      get: (obj, key) => (key in obj && obj[key] !== undefined ? obj[key] : "#cbd5e1"),
    }),
  };
}

function v1ApiFromV2Context(context) {
  const store = new Map()
  const kv = {
    get: (key, def) => (store.has(key) ? store.get(key) : (typeof context?.kv?.get === "function" ? context.kv.get(key, def) : def)),
    set: (key, value) => {
      store.set(key, value)
      try { context?.kv?.set?.(key, value) } catch {}
    },
  }
  return {
    kv,
    slots: {
      register: (reg) => {
        const cleanups = []
        for (const [v1Name, render] of Object.entries(reg?.slots || {})) {
          const name = v1Name === "sidebar_content" ? "sidebar.content" : v1Name
          const wrapped = (props) => {
            const p = props && typeof props === "object"
              ? { ...props, session_id: props.session_id ?? props.sessionID, sessionID: props.sessionID ?? props.session_id }
              : props;
            try {
              return render({}, p)
            } catch {
              return null
            }
          }
          try {
            const cleanup = context?.ui?.slot?.({ append: name, render: wrapped })
            if (typeof cleanup === "function") cleanups.push(cleanup)
          } catch {}
        }
        return () => { for (const fn of cleanups) { try { fn() } catch {} } }
      },
    },
    keymap: {
      registerLayer: (layer) => {
        try {
          const commands = (layer?.commands || []).map((c) => ({
            id: c.name || c.id,
            title: c.title || c.name,
            slash: c.slashName ? { name: c.slashName } : undefined,
            run: c.run,
          }))
          return context?.keymap?.layer?.(() => ({ mode: "global", commands, bindings: commands.map((c) => c.id) }))
        } catch {}
      },
    },
    command: {
      register: (getCommands) => {
        try {
          const list = typeof getCommands === "function" ? getCommands() : []
          const mapped = list.map((c) => ({ id: c.value || c.name, title: c.title, slash: c.slash ? { name: c.slash.name } : undefined, run: c.onSelect }))
          return context?.keymap?.layer?.(() => ({ mode: "global", commands: mapped, bindings: mapped.map((c) => c.id) }))
        } catch {}
      },
    },
    event: {
      on: (name, handler) => {
        try {
          if (typeof context?.data?.on === "function") return context.data.on(name, handler)
        } catch {}
        return () => {}
      },
    },
    route: {
      get current() {
        try {
          return context?.ui?.router?.current?.() ?? context?.route?.current
        } catch {
          return undefined
        }
      },
      navigate: (...args) => {
        try {
          return context?.ui?.router?.navigate?.(...args)
        } catch {}
      },
    },
    ui: context?.ui ?? {},
    theme: safeTheme(context),
    state: context?.data ?? context?.state ?? {},
    client: context?.client,
    app: context?.app ?? {},
  }
}

function resolveSessionID(api, slotProps) {
  const direct = slotProps?.session_id ?? slotProps?.sessionID
  if (typeof direct === "string" && direct) return direct
  try {
    const route = api?.route?.current
    const kind = route?.type ?? route?.name
    if (kind !== "session") return undefined
    const fromParams = route?.params?.sessionID ?? route?.params?.session_id
    if (typeof fromParams === "string" && fromParams) return fromParams
    const fromData = route?.data?.sessionID ?? route?.data?.session_id ?? route?.sessionID ?? route?.session_id
    if (typeof fromData === "string" && fromData) return fromData
  } catch {}
  return undefined
}

function setupTui(api, options) {
  if (options?.enabled === false) return
  try { setEnabled(api.kv?.get?.("tm_enabled", true) !== false) } catch {}
  const toggle = () => {
    const v = !enabled()
    try { api.kv?.set?.("tm_enabled", v) } catch {}
    setEnabled(v)
    try {
      const toast = api.ui?.toast
      if (typeof toast === "function") toast({ variant: v ? "success" : "info", message: `Token Monsters ${v ? "shown" : "hidden"}` })
      else if (typeof toast?.show === "function") toast.show({ variant: v ? "success" : "info", message: `Token Monsters ${v ? "shown" : "hidden"}` })
    } catch {}
  }
  registerCommand(api, toggle)
  const order = typeof options?.order === "number" ? options.order : DEFAULT_ORDER
  api.slots.register({
    order,
    slots: {
      sidebar_content: (_ctx, slotProps) => <View api={api} session_id={resolveSessionID(api, slotProps)} options={options} />,
    },
  })
}

export const TokenMonsters = {
  id: PLUGIN_ID,
  async tui(api, options) {
    setupTui(api, options)
  },
  // V2 CLI entrypoint.
  async setup(context, options) {
    setupTui(v1ApiFromV2Context(context), options)
  },
}

export default TokenMonsters
