# Token Monsters Plan

## Project
- GitHub owner: `aundal`
- Repository: `opencode-token-monsters`
- npm package: `@aundal/opencode-token-monsters`
- Purpose: OpenCode plugin showing token usage in the TUI sidebar.

## Current Work
- Restart OpenCode and verify Overhead appears when server/TUI plugins are loaded from `../../opencode-token-monsters/src/*`.
- Verify `Actual` roughly matches OpenCode `Context now` after a new request with the fixed current-request scope.
- Verify `Context` displays OpenCode's total including reasoning tokens and inline cache hit percentage using dot thousands separators.
- Verify `tool defs` expands to each tool in `Actual` and after new captures in `Total`.
- Verify `skill defs` expands to every skill listed in `<available_skills>` after a new capture.
- Verify `Skills` expands to each skill call after a new skill tool use.
- `AGENTS.md` fix verified in source: `classifySystem` returns agents=532/486 against the real system prompt. Not visible in TUI because the running OpenCode instance (PID 34956, started 14:35) predates the fix and still writes the legacy module-dir cache with agents=0. Restart OpenCode and verify AGENTS.md row appears for the current session.

## Future Tasks
- Publish a package update after the Overhead cache-path fix is verified.

## Important Findings
- Overhead disappeared because the server plugin wrote `.token-usage-cache.json` beside the local plugin source while the TUI read from the OpenCode config directory.
- Cache path fix: server writes to the documented config directory (`OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG` parent, or `~/.config/opencode`) and both server/TUI keep plugin-local cache fallback for existing data.
- `Actual` must use `current` + `overheadCurrent`; `Total` uses `total` + `overheadTotal`. Using total data for Actual made Token Monsters exceed OpenCode context size.
- OpenCode's context total includes reasoning tokens. The Token Monsters `Context` header includes `tokens.reasoning` and displays cache hit inline instead of model-limit percentage.
- `skill defs` is the `<available_skills>` catalog from the system prompt. It is parsed per `<skill>` entry and rendered as an expandable breakdown by installed skill.
- `Skills` call detail is stored on message entries as `sl` (`skill label -> tokens`) and rendered under the Overhead `Skills` node.

## Startup Investigation
- Goal: measure what slows down OpenCode startup on Windows.
- Suspects from current global config: npm plugin `@mohak34/opencode-notifier@latest`, local TS plugin `../../opencode-token-monsters/src/server.ts`, local TS plugin `./github/opencode-ill-be-back/src/ill-be-back.ts`.
- Docs checked: `https://opencode.ai/docs/troubleshooting/`, `https://opencode.ai/docs/config/`, `https://opencode.ai/config.json`.
- Relevant documented mitigations: empty `plugin`, clear `%USERPROFILE%\.cache\opencode`, use `opencode --log-level DEBUG`, consider `snapshot: false`, `autoupdate: false`, WSL on Windows.
