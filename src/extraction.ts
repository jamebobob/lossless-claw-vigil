/**
 * Pre-compaction extraction — extracts key decisions from messages
 * approaching compaction and appends them to daily note files.
 *
 * Completely isolated from summarization. Best-effort only: failures
 * are logged and never block compaction.
 */
import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { LcmDependencies } from "./types.js";

const EXTRACTION_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[lcm] extraction timeout after ${ms}ms`)),
      ms,
    );
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** Format a Date as YYYY-MM-DD in the given IANA timezone. */
function formatDateForTimezone(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const year = parts.find((p) => p.type === "year")?.value ?? "0000";
    const month = parts.find((p) => p.type === "month")?.value ?? "01";
    const day = parts.find((p) => p.type === "day")?.value ?? "01";
    return `${year}-${month}-${day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** Format a Date as HH:MM in the given IANA timezone. */
function formatTimeForTimezone(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString().slice(11, 16);
  }
}

const EXTRACTION_PROMPT = `You are extracting durable content from a conversation before it gets compressed. This output is appended directly to the assistant's daily notes. It is the ONLY automatic bridge between conversation context and the file layer. If you miss something, it is gone.

Extract into these categories (skip any with no entries):

**Decided**: Architecture choices, policy changes, rule changes, tool selections. Include who approved and why when non-obvious. ("Operator approved switching extraction model to Opus (previous model was contaminating summaries)")

**Shipped**: What deployed, changed, broke, or was fixed. Include filenames, ports, commit hashes, byte counts, config values. ("Deployed blog post to /var/www/site/, 73,342 bytes")

**Committed**: Promises by either party, agreed next steps, items explicitly deferred with reason. ("Deferred memory indexer cron fix, blocked on path resolution")

**Learned**: What broke and why, corrected assumptions, relearned facts. ("Cron jobs live in ~/.openclaw/cron/jobs.json, not system crontab. Assistant stated wrong location with full confidence.")

One fact per line, prefixed with "- ". Lead with the outcome, not the story. Include the reason parenthetically when the decision would be unclear without it.

Do NOT extract:
- Debug steps, tool output, raw file contents, intermediate attempts
- Transient state (PIDs, session IDs, progress percentages, "currently running")
- Intentions not yet acted on ("planning to", "might", "considering")
- Personal facts about the user (preferences, relationships, biographical details)
- Conversation flow ("user asked", "assistant searched", "discussed options")
- Editorializing ("successfully", "critical", "finally", "major breakthrough")

If nothing qualifies, output: (none)`;

/** Normalize message content to plain text for the extraction prompt. */
function messageToText(msg: { role?: string; content?: unknown }): string {
  const role = msg.role ?? "unknown";
  const content = msg.content;
  if (typeof content === "string") {
    return `[${role}] ${content}`;
  }
  if (Array.isArray(content)) {
    const texts = content
      .filter(
        (block): block is { type: string; text: string } =>
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string",
      )
      .map((block) => block.text);
    if (texts.length > 0) {
      return `[${role}] ${texts.join("\n")}`;
    }
  }
  return "";
}

export async function extractAndPersist(params: {
  messages: Array<{ role?: string; content?: unknown }>;
  deps: LcmDependencies;
  extractionModel: string;
  extractionProvider: string;
  outputPath: string;
  timezone: string;
}): Promise<boolean> {
  const { messages, deps, extractionModel, extractionProvider, outputPath, timezone } = params;

  // Serialize messages to text
  const lines = messages.map(messageToText).filter((line) => line.length > 0);
  if (lines.length === 0) {
    return false;
  }
  const messagesText = lines.join("\n\n");

  // Resolve model and API key
  let provider: string;
  let model: string;
  try {
    const resolved = deps.resolveModel(
      extractionModel || undefined,
      extractionProvider || undefined,
    );
    provider = resolved.provider;
    model = resolved.model;
  } catch (err) {
    console.warn(
      `[lcm] extraction: resolveModel failed:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }

  let apiKey: string | undefined;
  try {
    apiKey = await deps.getApiKey(provider, model);
  } catch (err) {
    console.warn(
      `[lcm] extraction: getApiKey failed:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }

  // LLM call
  let extractedText: string;
  try {
    const result = await withTimeout(
      deps.complete({
        provider,
        model,
        apiKey,
        messages: [{ role: "user", content: messagesText }],
        system: EXTRACTION_PROMPT,
        maxTokens: 1024,
        temperature: 0,
      }),
      EXTRACTION_TIMEOUT_MS,
    );

    // Extract text from completion result
    const content = result?.content;
    if (typeof content === "string") {
      extractedText = content.trim();
    } else if (Array.isArray(content)) {
      extractedText = content
        .filter(
          (block): block is { type: string; text: string } =>
            typeof block === "object" &&
            block !== null &&
            (block as Record<string, unknown>).type === "text" &&
            typeof (block as Record<string, unknown>).text === "string",
        )
        .map((block) => block.text)
        .join("\n")
        .trim();
    } else {
      extractedText = "";
    }
  } catch (err) {
    console.warn(
      `[lcm] extraction: LLM call failed:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }

  if (!extractedText || extractedText === "(none)") {
    return true; // Nothing to extract, not an error
  }

  // Write to daily note
  try {
    const now = new Date();
    const dateStr = formatDateForTimezone(now, timezone);
    const timeStr = formatTimeForTimezone(now, timezone);
    const fileName = `${dateStr}.md`;

    await mkdir(outputPath, { recursive: true });
    const filePath = join(outputPath, fileName);
    const block = `\n## LCM extraction (${timeStr})\n\n${extractedText}\n`;
    await appendFile(filePath, block, "utf8");
  } catch (err) {
    console.warn(
      `[lcm] extraction: file write failed:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }

  return true;
}
