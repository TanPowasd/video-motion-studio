# Starself film project

- This is a production, not an example to regenerate automatically. Preserve hand edits and stable scene/node/clip IDs.
- Open project.vmotion.json in Vmotion. Shared preview/export use components/film.ts and the GPU program in components/renderers/.
- Read README.md for external authoring and verification commands. Render-only mode preserves the existing project; rebuilding requires explicit --rebuild and a closed workstation.
- Time and randomness must remain deterministic, derived from the supplied frame clock. No historical feedback or wall clock.
- Keep source, script, score events and editable timeline under Git. Exports, .vmotion caches and WAV assets remain local and ignored.
- After changing narration, regenerate its cached audio, rebuild timing explicitly, and regenerate the score to retain alignment. Never truncate speech to fit a shot.
- Verify TypeScript with this directory's tsconfig.json, then use qa.ts and verify-mcp.mjs for actual GPU frames, random seek and external stdio MCP. Decode the final MP4 and measure its audio after export.
