// @ts-nocheck
import type { Plugin } from "@opencode-ai/plugin"
import { countTokens } from "gpt-tokenizer"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// ---------------------------------------------------------------------------
// token-usage-capture (server plugin)
//
// Captures, per request, the real prompt opencode sends to the model and writes
// a compact cache the TUI reads. It hooks:
//
//   experimental.chat.system.transform   -> the system prompt (overhead split)
//   tool.definition                       -> each tool's schema (tool defs)
//   experimental.chat.messages.transform  -> the ACTUAL sent messages
//
// Per session it keeps:
//   current  - the last request only (= "Aktuel Session")
//   total    - union of every unique message ever sent + overhead summed per
//              request (= "Total Session", survives compaction)
//
// Tokens are o200k (gpt-tokenizer). Exact for OpenAI models, ~approx for others.
// ---------------------------------------------------------------------------

const CONFIG_DIR = dirname(import.meta.dir)
const CACHE_FILE = join(homedir(), ".config", "opencode", ".token-usage-cache.json")
const WRITE_DEBOUNCE_MS = 750

const tok = (s: string) => {
  if (typeof s !== "string" || !s) return 0
  try {
    return countTokens(s, { allowedSpecial: "all" })
  } catch {
    return Math.ceil((s || "").length / 4)
  }
}

const partCache = new Map<string, number>()
function tokPart(key: string, text: string): number {
  if (typeof text !== "string" || !text) return 0
  const k = `${key}:${text.length}`
  const hit = partCache.get(k)
  if (hit !== undefined) return hit
  const n = tok(text)
  partCache.set(k, n)
  if (partCache.size > 80000) partCache.delete(partCache.keys().next().value as string)
  return n
}

// One message's token breakdown. r: "u" user / "a" assistant.
type MsgEntry = { r: "u" | "a"; in: number; out: number; t: Record<string, number>; tc: Record<string, number>; tt: Record<string, Record<string, number>>; f: number; fl: Record<string, number>; s: number; o: number }
type Overhead = { opencode: number; agents: number; skillDefs: number; toolDefs: number; toolDefsByTool?: Record<string, number> }
type SessionState = {
  reqCount: number
  overheadCurrent: Overhead
  overheadTotal: Overhead
  current: MsgEntry[]
  unique: Map<string, MsgEntry> // by message id, for the "total" view
  lastSystem?: { opencode: number; agents: number; skillDefs: number }
}

const toolSizes: Record<string, number> = {} // global per-tool definition sizes
const sessions = new Map<string, SessionState>()

// Tool-definition buffer for the request currently being assembled.
let buf = { sum: 0, ids: new Set<string>(), byTool: {} as Record<string, number>, done: false }

function readCachedSession(id: string): any | undefined {
  try {
    if (!existsSync(CACHE_FILE)) return
    const data = JSON.parse(readFileSync(CACHE_FILE, "utf8"))
    return data?.sessions?.[id]
  } catch {
    return
  }
}

function mergeEntriesByOrder(existing: MsgEntry[], incoming: MsgEntry[]): MsgEntry[] {
  const out = [...(existing || [])]
  for (const entry of incoming || []) {
    const idx = out.findIndex((e) => e.r === entry.r && e.o === entry.o)
    if (idx >= 0) out[idx] = entry
    else out.push(entry)
  }
  return out.sort((a, b) => a.o - b.o)
}

function session(id: string): SessionState {
  let s = sessions.get(id)
  if (!s) {
    const cached = readCachedSession(id)
    const unique = new Map<string, MsgEntry>()
    for (const [idx, entry] of (cached?.total || []).entries()) {
      unique.set(`cached:${entry.o}:${entry.r}:${idx}`, entry)
    }

    s = {
      reqCount: cached?.reqCount || 0,
      overheadCurrent: cached?.overheadCurrent || { opencode: 0, agents: 0, skillDefs: 0, toolDefs: 0 },
      overheadTotal: cached?.overheadTotal || { opencode: 0, agents: 0, skillDefs: 0, toolDefs: 0 },
      current: cached?.current || [],
      unique,
    }
    sessions.set(id, s)
  }
  return s
}

let writeTimer: ReturnType<typeof setTimeout> | undefined
function scheduleWrite() {
  if (writeTimer) return
  writeTimer = setTimeout(() => {
    writeTimer = undefined
    try {
      let out: any = { sessions: {}, updatedAt: Date.now() }
      try {
        if (existsSync(CACHE_FILE)) {
          out = JSON.parse(readFileSync(CACHE_FILE, "utf8"))
          if (!out || typeof out !== "object") out = { sessions: {} }
          if (!out.sessions || typeof out.sessions !== "object") out.sessions = {}
          out.updatedAt = Date.now()
        }
      } catch {
        out = { sessions: {}, updatedAt: Date.now() }
      }

      for (const [id, s] of sessions) {
        const cachedTotal = out.sessions?.[id]?.total || []
        const total = mergeEntriesByOrder(cachedTotal, [...s.unique.values()])
        out.sessions[id] = {
          reqCount: s.reqCount,
          overheadCurrent: s.overheadCurrent,
          overheadTotal: s.overheadTotal,
          current: s.current,
          total,
        }
      }
      writeFileSync(CACHE_FILE, JSON.stringify(out))
    } catch {}
  }, WRITE_DEBOUNCE_MS)
}

function instructionTexts(directory?: string, worktree?: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const base of [CONFIG_DIR, worktree, directory]) {
    if (!base || base === "/") continue
    const file = join(base, "AGENTS.md")
    if (seen.has(file)) continue
    seen.add(file)
    try {
      if (existsSync(file)) out.push(readFileSync(file, "utf8").trim())
    } catch {}
  }
  return out
}

function classifySystem(system: string, instructions: string[]) {
  const total = tok(system)
  let skillDefs = 0
  const skillEnd = system.indexOf("</available_skills>")
  if (skillEnd >= 0) {
    let start = system.indexOf("<available_skills>")
    const intro = system.lastIndexOf("Skills provide", start)
    if (intro >= 0 && start - intro < 400) start = intro
    if (start >= 0) skillDefs = tok(system.slice(start, skillEnd + "</available_skills>".length))
  }
  let environment = 0
  const envIdx = system.search(/Here is some useful information about the environment/i)
  if (envIdx >= 0) {
    const envEnd = system.indexOf("</env>", envIdx)
    environment = tok(system.slice(envIdx, envEnd > 0 ? envEnd + 6 : Math.min(system.length, envIdx + 800)))
  }
  let agents = 0
  for (const text of instructions) {
    const probe = text.slice(0, 80)
    if (probe && system.includes(probe)) agents += tok(text)
  }
  const opencode = Math.max(0, total - skillDefs - environment - agents) + environment
  return { opencode, agents, skillDefs }
}

// Short, displayable name for a loaded file part.
function fileLabel(p: any): string {
  const raw = p?.filename || p?.source?.path || p?.url || "file"
  const base = String(raw).split(/[\\/]/).pop() || String(raw)
  return base || "file"
}

function shortTarget(raw: unknown): string | undefined {
  if (typeof raw !== "string") return
  const s = raw.trim()
  if (!s) return
  if (/^https?:\/\//i.test(s)) return s
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith("/") || s.startsWith("./") || s.startsWith("../") || s.includes("\\") || s.includes("/")) return s
}

function addTarget(bucket: Record<string, number>, raw: unknown) {
  const key = shortTarget(raw)
  if (key) bucket[key] = (bucket[key] || 0) + 1
}

function collectTargets(name: string, input: any, output: string): string[] {
  const out: Record<string, number> = {}
  const add = (raw: unknown) => addTarget(out, raw)
  if (name === "read") {
    add(input?.filePath)
  } else if (name === "edit") {
    add(input?.filePath)
  } else if (name === "write") {
    add(input?.filePath)
  } else if (name === "webfetch") {
    add(input?.url)
  } else if (name === "apply_patch") {
    const patch = typeof input?.patchText === "string" ? input.patchText : ""
    const matches = patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)
    for (const m of matches) add(m[1])
  } else if (name === "glob") {
    add(input?.pattern)
  } else if (name === "grep") {
    add(input?.include)
    add(input?.path)
  } else if (name === "bash") {
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

function allocateTargets(targets: string[], total: number): Record<string, number> {
  const uniq = [...new Set((targets || []).filter(Boolean))]
  if (uniq.length === 0) return {}
  const n = Math.max(0, Math.round(Number(total) || 0))
  const base = Math.floor(n / uniq.length)
  let rem = n - base * uniq.length
  const out: Record<string, number> = {}
  for (const key of uniq) {
    out[key] = base + (rem > 0 ? 1 : 0)
    if (rem > 0) rem--
  }
  return out
}

function toolTargets(name: string, input: any, output: string, totalTokens: number): Record<string, number> {
  return allocateTargets(collectTargets(name, input, output), totalTokens)
}

// Build a per-message entry from one {info, parts}.
function entryFor(info: any, parts: any[]): MsgEntry {
  const role: "u" | "a" = info?.role === "user" ? "u" : "a"
  const e: MsgEntry = { r: role, in: 0, out: 0, t: {}, tc: {}, tt: {}, f: 0, fl: {}, s: 0, o: info?.time?.created || 0 }
  for (const p of parts || []) {
    if (p?.type === "text" && !p.synthetic && typeof p.text === "string") {
      const n = tokPart(p.id || "t", p.text)
      if (role === "u") e.in += n
      else e.out += n
    } else if (p?.type === "tool") {
      const name = p.tool || "tool"
      const out = typeof p.state?.output === "string" ? p.state.output : ""
      const args = p.state?.input ? JSON.stringify(p.state.input) : ""
      const n = tokPart(`${p.id}:o`, out) + tokPart(`${p.id}:a`, args)
      if (name === "skill") e.s += n
      else {
        e.t[name] = (e.t[name] || 0) + n
        e.tc[name] = (e.tc[name] || 0) + 1
        const targets = toolTargets(name, p.state?.input, out, n)
        if (Object.keys(targets).length) {
          const cur = e.tt[name] || {}
          for (const [k, v] of Object.entries(targets)) cur[k] = (cur[k] || 0) + v
          e.tt[name] = cur
        }
      }
    } else if (p?.type === "file") {
      const v = p.source?.text?.value
      if (typeof v === "string") {
        const n = tokPart(p.id || "f", v)
        e.f += n
        const label = fileLabel(p)
        e.fl[label] = (e.fl[label] || 0) + n
      }
    }
  }
  return e
}

function addOverhead(target: Overhead, src: Overhead) {
  target.opencode += src.opencode
  target.agents += src.agents
  target.skillDefs += src.skillDefs
  target.toolDefs += src.toolDefs
}

export const TokenUsageCapture: Plugin = async ({ directory, worktree }) => {
  return {
    "tool.definition": async (input, output) => {
      try {
        const id = input.toolID
        if (!id) return
        const size = tok(output.description || "") + tok(JSON.stringify(output.parameters ?? {}))
        toolSizes[id] = size
        if (buf.done) buf = { sum: 0, ids: new Set(), byTool: {}, done: false } // new request started
        if (!buf.ids.has(id)) {
          buf.ids.add(id)
          buf.sum += size
          buf.byTool[id] = size
        }
      } catch {}
    },

    "experimental.chat.system.transform": async (input, output) => {
      try {
        const sessionID = input.sessionID
        if (!sessionID || !Array.isArray(output.system)) return
        session(sessionID).lastSystem = classifySystem(output.system.join("\n"), instructionTexts(directory, worktree))
      } catch {}
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        const messages = (output as any)?.messages
        if (!Array.isArray(messages) || messages.length === 0) return
        let sessionID: string | undefined
        for (const m of messages) if (m?.info?.sessionID) { sessionID = m.info.sessionID; break }
        if (!sessionID) return
        const s = session(sessionID)

        // Overhead for this request.
        const sys = s.lastSystem || { opencode: 0, agents: 0, skillDefs: 0 }
        const overhead: Overhead = {
          opencode: sys.opencode,
          agents: sys.agents,
          skillDefs: sys.skillDefs,
          toolDefs: buf.sum,
          toolDefsByTool: { ...buf.byTool },
        }
        s.overheadCurrent = overhead
        addOverhead(s.overheadTotal, overhead)
        s.reqCount += 1
        buf.done = true // next tool.definition starts a fresh request buffer

        // Messages for this request (current) + union into total (unique by id).
        const current: MsgEntry[] = []
        let order = 0
        for (const m of messages) {
          const id = m?.info?.id || `idx${order}`
          const e = entryFor(m?.info, m?.parts || [])
          if (!e.o) e.o = order
          current.push(e)
          s.unique.set(id, e)
          order++
        }
        s.current = current
        scheduleWrite()
      } catch {}
    },
  }
}

export default TokenUsageCapture

// V2 setup: same cache via the session context hook ({ system, messages, tools }).
// V1 calls server() and uses the returned transform hooks.
export async function TokenUsageCaptureSetupV2(ctx: any): Promise<void> {
  const directory = ctx?.location?.directory || ctx?.directory || process.cwd()
  try {
    await ctx?.session?.hook?.("context", (event: any) => {
      try {
        const sessionID = event?.sessionID
        if (!sessionID) return
        const s = session(sessionID)
        const system = Array.isArray(event?.system) ? event.system : []
        if (system.length) {
          const texts = system.map((p: any) => (typeof p === "string" ? p : p?.text || "")).filter(Boolean)
          if (texts.length) s.lastSystem = classifySystem(texts.join("\n"), instructionTexts(directory))
        }
        const tools = event?.tools
        if (tools && typeof tools === "object") {
          try {
            if (buf.done) buf = { sum: 0, ids: new Set(), byTool: {} }
            for (const [id, def] of Object.entries(tools as Record<string, any>)) {
              if (buf.ids.has(id)) continue
              const size = tok((def as any)?.description || "") + tok(JSON.stringify((def as any)?.input ?? (def as any)?.parameters ?? {}))
              buf.ids.add(id)
              buf.sum += size
              buf.byTool[id] = size
            }
          } catch {}
        }
        const messages = Array.isArray(event?.messages) ? event.messages : []
        if (!messages.length) return
        const sys = s.lastSystem || { opencode: 0, agents: 0, skillDefs: 0 }
        const overhead: Overhead = {
          opencode: sys.opencode,
          agents: sys.agents,
          skillDefs: sys.skillDefs,
          toolDefs: buf.sum,
          toolDefsByTool: { ...buf.byTool },
        }
        s.overheadCurrent = overhead
        addOverhead(s.overheadTotal, overhead)
        s.reqCount += 1
        buf.done = true
        const current: MsgEntry[] = []
        let order = 0
        for (const m of messages) {
          const id = m?.info?.id || `idx${order}`
          const e = entryFor(m?.info, m?.parts || [])
          if (!e.o) e.o = order
          current.push(e)
          s.unique.set(id, e)
          order++
        }
        s.current = current
        scheduleWrite()
      } catch {}
    })
  } catch {}
}
