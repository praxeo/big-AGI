# praxeo fork of big-AGI

`v2-dev` = upstream [`enricoros/big-AGI`](https://github.com/enricoros/big-AGI) `main` + the customizations below.
Upstream is brought in by **merge** (never rebase), usually a PR named `Sync: merge upstream enricoros/main into v2-dev`.

## Layout rule

Fork code lives in **fork-owned files**. Upstream files carry only short **hook lines** marked `[praxeo fork]`.
A merge conflicts only when upstream edits a hook line or the line next to it, so keep hooks few and on quiet lines.
When adding a customization: put the logic in a new file, and call it from upstream code with one marked line.

## Customizations

| Feature | Fork-owned files (never conflict) | Hooks in upstream files |
|---|---|---|
| Clinical personas (MDM Helper v2/v3, HPI Helper, Wound Care Note, Clinical Assistant) | - | `src/data.ts` (persona set replaced); with the Developer and YouTube Transcriber personas gone, their references are deleted in `AppChat.tsx`, `Composer.tsx`, `PersonaSelector.tsx`, `store-chats.ts` |
| Voice input (ElevenLabs `scribe_v2` default, Cloudflare, realtime STT) | `app/api/stt/*`, `speechrecognition/CloudflareSTTEngine.ts`, `speechrecognition/RealtimeSTTEngine.ts` | `speechrecognition/AudioRecorderEngine.ts`, `speechrecognition/useSpeechRecognition.ts` |
| Code blocks: plain text while streaming (no HTML/SVG/PlantUML render, no Prism) | `blocks/code/code-renderers/RenderCodeStreamingPlain.tsx` | `blocks/code/RenderCode.tsx`: 5 lines |
| Unsloth local server (listing, Thinking, Web Search) | `llms/server/openai/models/unsloth.models.ts`, `llms/models-modal/UnslothParametersConfig.tsx`, `llms/vendors/openai/openai.unsloth.ts`, `aix/.../adapters/openai.chatCompletions.unsloth.ts`, `icons/vendors/UnslothIcon.tsx` | 1-2 lines each in `listModels.dispatch.ts`, `LLMParametersEditor.tsx`, `aix.client.ts`, `openai.chatCompletions.ts`; small additive blocks in `aix.wiretypes.ts`, `openai.wiretypes.ts`, `openai.parser.ts`, `llms.parameters.ts`, `llm.server.types.ts`, `models.mappings.ts`, `llms.defs.manifest.ts`, `OpenAIHostAutocomplete.tsx` |
| Docs | `FORK.md` | top of `README.md`, one line in `CLAUDE.md` |

Find the hooks: `git grep -n "praxeo fork"` (marked hook lines) and `git grep -il unsloth` (Unsloth additions).

## Generated file: always upstream's copy

`src/modules/llms/server/gen/llms.defs.versions.ts` is generated. The fork commits **upstream's exact copy** of it,
so git never conflicts on it (before this rule it conflicted in 8 of 9 conflicting syncs).
Builds regenerate it anyway (`prebuild`; Vercel and Docker run `npm run build`), and upstream keeps its CI check off.

- After `npm run dev` or `npm run build` it shows as modified locally: **do not commit it**.
- If a merge touches it: `git checkout upstream/main -- src/modules/llms/server/gen/llms.defs.versions.ts`

## Syncing with upstream

1. GitHub **Sync fork** button: fine when it reports no conflicts.
2. Otherwise, locally (or ask Claude to "sync to enricoros main"):

```bash
git remote add upstream https://github.com/enricoros/big-AGI.git   # once
git fetch upstream main
git checkout -b sync-upstream origin/v2-dev
git merge upstream/main
git checkout upstream/main -- src/modules/llms/server/gen/llms.defs.versions.ts
```

3. For each remaining conflict: take upstream's version of the code, then re-add the `[praxeo fork]` line(s) from the table above.
4. Verify nothing was lost and nothing extra slipped in:

```bash
git diff upstream/main --stat        # must list only the files in the table above
npm run tscheck && npm run lint
```
