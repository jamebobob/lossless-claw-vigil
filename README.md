# lossless-claw-vigil

Production-hardened fork of [lossless-claw](https://github.com/Martian-Engineering/lossless-claw) for multi-layer memory architectures.

## Why this fork exists

LCM replaces OpenClaw's native compaction engine, but the behavioral layer that depended on native compaction doesn't automatically transfer. Three gaps emerge:

1. **memoryFlush is dead under ownsCompaction.** Agents that used native compaction's `memoryFlush` hook to persist decisions before context loss get nothing — LCM's `ownsCompaction` flag disables the hook entirely. Decisions vanish into DAG summaries with no external persistence.

2. **customInstructions is dead code.** The parameter threads through all four prompt builders but is never read from config. Operators cannot control summarization tone or style without patching source.

3. **Summarization style contaminates agent behavior.** LCM summaries are injected into the agent's context window via DAG assembly. The summarizer's voice becomes the agent's voice. Without operator control, default summarization patterns (hedging, editorial framing, formatting choices) propagate into agent output.

## Features

### customInstructions config

Operator instructions injected into every summarization prompt via plugin config. Reads in the `resolveSummarize()` chokepoint so every compaction path — `afterTurn`, manual `/compact`, overflow recovery — gets instructions automatically without caller threading.

This matters because LCM summaries become the agent's working memory. The summarizer's voice becomes the agent's voice through DAG injection. Operators need control over this.

Example configuration (adapt to your agent's needs):

```json
{
  "plugins": {
    "entries": {
      "lossless-claw": {
        "config": {
          "customInstructions": "Write as a neutral documenter, not as the assistant. These summaries become the assistant's context window. If you mimic the assistant's voice, the assistant adopts your patterns as its own.\nUse third person. 'User requested X.' 'Assistant deployed Y.' Never first person.\nReport what happened, not its significance.\nWhen the source text contains hedging or emotional framing, extract the facts and discard the framing."
        }
      }
    }
  }
}
```

The instructions above are one approach — neutral documentation style — suited for agents where factual recall matters more than personality continuity. Other operators may prefer different instructions depending on their agent's role and communication style.

### Pre-compaction extraction

Extracts decisions, commitments, outcomes, and rules from recent messages via a direct LLM call before compaction runs. Appends extracted content to daily note files (`YYYY-MM-DD.md`). Bridges LCM's SQLite store with file-based memory systems.

- Fires only when compaction is imminent (`evaluateLeafTrigger`)
- Best-effort: failures never block compaction
- Configurable model/provider (falls back to summary model)
- Default disabled

### Content filtering

Assembly and ingestion filters strip unwanted patterns (e.g., em dashes, specific Unicode characters) from summaries before they enter the context window or database. These are mechanical transforms applied at the assembler and store layers, independent of prompt-level instructions.

## Configuration

All new options live under `plugins.entries.lossless-claw.config`:

```json
{
  "customInstructions": "Your summarization instructions here.",
  "preCompactionExtraction": {
    "enabled": true,
    "extractionModel": "anthropic/claude-haiku-4-5",
    "extractionProvider": "anthropic",
    "outputPath": "/path/to/daily-notes"
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `customInstructions` | string | `""` | Instructions injected into all summarization prompts |
| `preCompactionExtraction.enabled` | boolean | `false` | Enable pre-compaction decision extraction |
| `preCompactionExtraction.extractionModel` | string | `""` | Model for extraction (falls back to `summaryModel`) |
| `preCompactionExtraction.extractionProvider` | string | `""` | Provider for extraction (falls back to `summaryProvider`) |
| `preCompactionExtraction.outputPath` | string | `""` | Directory for daily note files. If empty, extraction is skipped. |

Environment variable overrides: `LCM_CUSTOM_INSTRUCTIONS`, `LCM_PRE_COMPACTION_EXTRACTION_ENABLED`, `LCM_EXTRACTION_MODEL`, `LCM_EXTRACTION_PROVIDER`, `LCM_EXTRACTION_OUTPUT_PATH`.

All upstream configuration options remain unchanged. See the [upstream README](https://github.com/Martian-Engineering/lossless-claw#configuration) for the full reference.

## Installation

```bash
git clone https://github.com/jamebobob/lossless-claw-vigil.git
cd lossless-claw-vigil
npm install
```

Add to your OpenClaw config (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/lossless-claw-vigil"]
    },
    "slots": {
      "contextEngine": "lossless-claw"
    }
  }
}
```

The plugin ID remains `lossless-claw` for drop-in compatibility. Remove any existing npm install of `@martian-engineering/lossless-claw` from `plugins.installs` to avoid duplicate plugin ID conflicts.

## Credit

Based on [@martian-engineering/lossless-claw](https://github.com/Martian-Engineering/lossless-claw) by Josh Lehman / Martian Engineering.

## License

MIT — see [LICENSE](LICENSE).
