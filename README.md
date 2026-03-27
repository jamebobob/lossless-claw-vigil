# lossless-claw-vigil-recall

A production fork of [@martian-engineering/lossless-claw](https://github.com/Martian-Engineering/lossless-claw), the DAG-based context management plugin for [OpenClaw](https://github.com/openclaw/openclaw).

## Background

We've been running LCM in production since late February 2026. Over the first few weeks, we hit three problems that the upstream plugin doesn't address:

1. **The summarizer's voice becomes the agent's voice.** LCM injects summaries directly into the agent's context window. Whatever style the summarizer uses, hedging, editorial framing, formatting quirks, the agent absorbs. There's a `customInstructions` parameter threaded through all four prompt builders, but it's never read from config. Dead code.

2. **Decisions vanish at compaction.** Native OpenClaw compaction fires a `memoryFlush` hook that lets agents persist important state before context loss. LCM's `ownsCompaction` flag disables that hook entirely. Anything the agent decided but didn't write to a file before compaction gets compressed into a DAG summary. It might survive. It might not.

3. **No content filtering.** Summarization models have their own habits. Ours filled 13,060 database rows with em dashes before we noticed. There was no way to strip unwanted patterns mechanically at the storage or assembly layer.

This fork fixes all three.

## What we added

### customInstructions

Operator instructions injected into every summarization prompt. Reads from plugin config in the `resolveSummarize()` chokepoint, so every compaction path (`afterTurn`, manual `/compact`, overflow recovery) gets the instructions without any caller threading.

```json
{
  "plugins": {
    "entries": {
      "lossless-claw": {
        "config": {
          "customInstructions": "Write as a neutral documenter, not as the assistant. Use third person. Report what happened, not its significance. Extract facts, discard framing."
        }
      }
    }
  }
}
```

The example above is what we use: neutral documentation style where factual recall matters more than personality continuity. Your agent might want something different. The field accepts any string and gets injected as-is.

### Pre-compaction extraction

Before compaction runs, a separate LLM call extracts decisions, commitments, outcomes, and rules from the messages about to be compacted. The output gets appended to daily note files (`YYYY-MM-DD.md`), bridging LCM's SQLite store with file-based memory systems.

- Fires only when compaction is imminent (tied to `evaluateLeafTrigger`)
- Best-effort: failures never block compaction
- Configurable model/provider (falls back to summary model)
- Disabled by default

This is the piece that solved the "decisions vanish" problem. Even if a DAG summary loses the nuance of what was decided and why, the extraction wrote it to a file first.

### Content filtering

Assembly-time and ingestion-time filters that strip unwanted patterns from summaries before they enter the context window or database. Mechanical transforms at the assembler and store layers, independent of prompt instructions. We use it to strip em dashes. You could use it for anything that your summarizer produces and your agent shouldn't absorb.

## Configuration

All options live under `plugins.entries.lossless-claw.config`:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `customInstructions` | string | `""` | Instructions injected into all summarization prompts |
| `preCompactionExtraction.enabled` | boolean | `false` | Enable pre-compaction decision extraction |
| `preCompactionExtraction.extractionModel` | string | `""` | Model for extraction (falls back to `summaryModel`) |
| `preCompactionExtraction.extractionProvider` | string | `""` | Provider for extraction (falls back to `summaryProvider`) |
| `preCompactionExtraction.outputPath` | string | `""` | Directory for daily note files |

Environment variable overrides: `LCM_CUSTOM_INSTRUCTIONS`, `LCM_PRE_COMPACTION_EXTRACTION_ENABLED`, `LCM_EXTRACTION_MODEL`, `LCM_EXTRACTION_PROVIDER`, `LCM_EXTRACTION_OUTPUT_PATH`.

All upstream config options remain unchanged. See the [upstream docs](https://github.com/Martian-Engineering/lossless-claw#configuration) for the full reference.

## Installation

```bash
git clone https://github.com/jamebobob/lossless-claw-vigil-recall.git
cd lossless-claw-vigil-recall
npm install
```

Add to your OpenClaw config:

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/lossless-claw-vigil-recall"]
    },
    "slots": {
      "contextEngine": "lossless-claw"
    }
  }
}
```

The plugin ID stays `lossless-claw` for drop-in compatibility. If you have the upstream npm package installed via `plugins.installs`, remove it first to avoid duplicate plugin ID conflicts.

## Documentation

The docs/ directory contains the full upstream documentation, unmodified:

- [Architecture](docs/architecture.md): Data model, compaction lifecycle, context assembly, expansion
- [Configuration](docs/configuration.md): Full tuning reference
- [Agent tools](docs/agent-tools.md): The four LCM tools and how agents use them
- [TUI Reference](docs/tui.md): Terminal UI for inspecting and maintaining the DAG
- [FTS5 setup](docs/fts5.md): Optional full-text search acceleration

## Related

- [mem0-vigil-recall](https://github.com/jamebobob/mem0-vigil-recall): Our companion mem0 fork with capture filtering, recall telemetry, and multi-pool support
- [@martian-engineering/lossless-claw](https://github.com/Martian-Engineering/lossless-claw) (upstream)
- [LCM paper](https://papers.voltropy.com/LCM) from [Voltropy](https://x.com/Voltropy)

## Credit

Based on lossless-claw by Josh Lehman / [Martian Engineering](https://github.com/Martian-Engineering). The upstream plugin is excellent. This fork exists because we needed to tune three specific things for production use, not because anything was wrong with it.

## License

MIT
