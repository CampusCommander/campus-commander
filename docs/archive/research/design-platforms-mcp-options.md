# Design Platforms with MCP Interfaces (OpenDesign Replacement)

Researched 2026-08-29 against primary sources (vendor docs, npm registry). Replaces OpenDesign, which the user dropped after confirming it ships a stdio-only MCP server bound to a Windows `.exe` this Linux session cannot spawn. Requirement: the platform must connect from this Linux opencode session and produce artifacts that feed the Campus Commander Angular Material implementation (design tokens, CSS, specs, screenshots) per `docs/ux/ui-design-guide.md`.

## 1. Candidate comparison

| Platform | Connection from this Linux session | Read | Write | Verdict |
|---|---|---|---|---|
| **Penpot** (Kaleidos, open source) | ✅ Official remote MCP: `https://<domain>/mcp/stream?userToken=…` — plain HTTP, no bridge. Docs cover OpenCode setup explicitly | ✅ tokens, components, structure, asset export | ✅ `execute_code` creates and edits designs | **Selected** |
| Figma — official remote MCP | ❌ Allowlisted: only clients in the Figma MCP Catalog connect (Claude, Cursor, VS Code, Codex, Zed, Warp, etc.). opencode is not listed; new clients join a waitlist | — | — | Blocked as a client today |
| Figma — Framelink (`figma-developer-mcp` v0.13.2, community) | ✅ Local stdio via npx + Figma personal access token | ✅ design data, variables, image download; one-shot design-to-code | ❌ read-only (REST API) | Solid fallback if the user designs in Figma instead |
| Google Stitch | ◐ Prompt-to-UI tool with a documented remote MCP; docs are a JS app that returned no content to fetch — needs browser verification | ? | ? | Unverified; exports Tailwind-flavored HTML |
| v0 (Vercel) | ◐ MCP doc paths 404 on both `v0.app` and `v0.dev` — unverified | ? | ? | Outputs React code, wrong framework for this stack |
| Canva / Recraft MCPs | ✅ Remote HTTP | Image and marketing graphics, brand marks | Partial | Not app-UI tools; Recraft is a candidate later for the open logomark item (guide §14) |

Sources: https://developers.figma.com/docs/figma-mcp-server/ ; https://www.figma.com/mcp-catalog/ ; https://help.penpot.app/mcp/ ; npm registry entries `figma-developer-mcp` (v0.13.2), `@penpot/mcp` (v2.15.4).

## 2. Why Penpot

- **Zero-bridge config.** The remote endpoint is a plain URL with the token embedded as `userToken`. It drops into opencode's `type: "remote"` entry. No stdio process, no Windows dependency, no LAN bridge.
- **Full read and write.** `execute_code` lets the agent create and modify designs directly; tokens, components, structure, and asset export are first-class tools. The alternative (Figma via Framelink) is read-only, so design work would have to happen in Figma's GUI or Make instead of through the agent.
- **Open source.** Penpot matches the project stance that drives libreGrid and the self-hosting philosophy in the architecture doc. SaaS (`design.penpot.app`) works today; self-hosting is a later compose-profile option, not a blocker.
- **Browser review loop.** The user reviews designs in a normal browser tab on any machine. No local desktop app required.

## 3. Verified connection (2026-08-29)

Live MCP handshake against the user's hosted Penpot endpoint:

| Check | Result |
|---|---|
| `initialize` | HTTP 200; `serverInfo.name = "penpot"`, version 1.0.0; protocol `2025-03-26`; session ID issued |
| `tools/list` | Four tools: `execute_code`, `high_level_overview`, `penpot_api_info`, `export_shape` |
| Server instructions | "Before working with these tools, be sure to read the 'Penpot High-Level Overview' via the `high_level_overview` tool." — first call in any session must be `high_level_overview` |

## 4. Setup as implemented

- Global opencode config (`~/.config/opencode/opencode.json`) gained an enabled entry: `penpot`, `type: "remote"`, URL with the user's `userToken`, timeout 10 s. Requires an opencode restart to load.
- Per-file step (user): open a Penpot design file, then **File → MCP Server → Connect**. The plugin binds MCP to the focused page; one tab at a time.
- Token hygiene: the MCP key is embedded in the config URL and is regenerable under Penpot account Integrations. The separate Penpot access token (RPC API) is not stored in opencode config; it serves later scripted work such as design-token export into `frontend/src/theme/`.

## 5. Planned workflow

1. Restart opencode with the new entry; confirm the server loads.
2. Call `high_level_overview`, then read-only page listing to verify end-to-end.
3. First real task from `docs/ux/ui-design-guide.md`: §5 color tokens and §6 type scale as Penpot styles, then the app shell screen (§4) and the Users grid page (§9). This settles guide §14 open items (accent hex, wordmark treatment) visually.
4. On sign-off: export tokens and translate them into `frontend/src/theme/` when frontend implementation starts.
