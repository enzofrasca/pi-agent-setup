/**
 * Minimal web tools for pi.
 *
 * search → Exa  (rank + highlights — Exa’s recommended agent mode)
 * scrape → Firecrawl (one URL → main-content markdown)
 *
 * Docs basis:
 *   https://exa.ai/docs/reference/search-api-guide-for-coding-agents
 *   https://exa.ai/docs/reference/search-best-practices
 *   https://docs.firecrawl.dev/api-reference/endpoint/scrape
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

// ── env ──────────────────────────────────────────────────────────────────────

function env(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const path = join(homedir(), ".pi", "agent", ".env");
  if (!existsSync(path)) return undefined;
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const m = t.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m || m[1] !== name) continue;
      let v = m[2].trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      } else {
        v = v.replace(/\s+#.*$/, "");
      }
      return v;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// ── output budget ────────────────────────────────────────────────────────────

const MAX_CHARS = 40_000;

function maybeTruncate(text: string, label: string): string {
  if (text.length <= MAX_CHARS) return text;
  const dir = mkdtempSync(join(tmpdir(), "pi-web-"));
  const file = join(dir, `${label}.md`);
  writeFileSync(file, text, "utf8");
  return (
    text.slice(0, MAX_CHARS) +
    `\n\n…[truncated ${text.length - MAX_CHARS} chars. Full output: ${file}]`
  );
}

// ── Exa search ───────────────────────────────────────────────────────────────
// Canonical agent request (from Exa coding-agent guide):
//   { query, type: "auto", contents: { highlights: true } }
// Do NOT use deprecated: numSentences, highlightsPerUrl, livecrawl, useAutoprompt.
// Do NOT stack text+highlights by default (double-bills two views of the same page).

interface Hit {
  title: string;
  url: string;
  highlights: string[];
  publishedDate?: string;
  author?: string;
}

const SEARCH_LIMIT = 10;

async function exaSearch(
  query: string,
  opts: { includeDomains?: string[] },
  apiKey: string,
  signal?: AbortSignal
): Promise<Hit[]> {
  // `highlights: true` = highest-quality default per Exa docs.
  const body: Record<string, unknown> = {
    query,
    type: "auto",
    numResults: SEARCH_LIMIT,
    contents: { highlights: true },
  };

  if (opts.includeDomains?.length) body.includeDomains = opts.includeDomains;

  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Exa ${res.status}: ${t || res.statusText}`);
  }

  const json: unknown = await res.json();
  if (!isObj(json) || !Array.isArray(json.results)) {
    throw new Error("Unexpected Exa response shape");
  }

  const hits: Hit[] = [];
  for (const raw of json.results) {
    if (!isObj(raw)) continue;
    const highlights = Array.isArray(raw.highlights)
      ? raw.highlights.filter((h): h is string => typeof h === "string" && h.trim().length > 0)
      : [];
    hits.push({
      title: typeof raw.title === "string" ? raw.title : "Untitled",
      url: typeof raw.url === "string" ? raw.url : "",
      highlights,
      publishedDate: typeof raw.publishedDate === "string" ? raw.publishedDate : undefined,
      author: typeof raw.author === "string" ? raw.author : undefined,
    });
  }
  return hits;
}

function formatHits(query: string, hits: Hit[]): string {
  if (hits.length === 0) return `No results for: ${query}`;

  const lines: string[] = [
    `Search: ${query}`,
    `Results: ${hits.length}`,
    "",
    "Excerpts below. Answer from them when sufficient.",
    "Scrape only when a concrete detail is missing — prefer official docs, .md, or llms.txt when available.",
    "",
  ];

  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    lines.push(`## ${i + 1}. ${h.title}`);
    if (h.url) lines.push(h.url);
    if (h.publishedDate) lines.push(`Published: ${h.publishedDate}`);
    if (h.author) lines.push(`Author: ${h.author}`);
    lines.push("");

    if (h.highlights.length > 0) {
      for (const hl of h.highlights) {
        lines.push(`> ${hl.trim()}`);
        lines.push("");
      }
    } else {
      lines.push("_(no excerpt — scrape this URL if it looks relevant)_");
      lines.push("");
    }
  }

  return maybeTruncate(lines.join("\n"), "search");
}

// ── Firecrawl scrape ─────────────────────────────────────────────────────────
// Canonical: formats: ["markdown"], onlyMainContent: true
// maxAge default on their side is 2 days (fast cache); pass 0 to force fresh.

async function firecrawlScrape(
  url: string,
  apiKey: string,
  opts: { timeout?: number; fresh?: boolean },
  signal?: AbortSignal
): Promise<string> {
  const body: Record<string, unknown> = {
    url,
    formats: ["markdown"],
    onlyMainContent: true,
    timeout: opts.timeout ?? 60_000,
  };
  if (opts.fresh) body.maxAge = 0;

  const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Firecrawl ${res.status}: ${t || res.statusText}`);
  }

  const json: unknown = await res.json();
  if (
    isObj(json) &&
    json.success === true &&
    isObj(json.data) &&
    typeof json.data.markdown === "string"
  ) {
    return json.data.markdown.trim() || "No content returned.";
  }
  throw new Error("Unexpected Firecrawl response shape");
}

// ── tools ────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "search",
    label: "Search Web",
    description:
      "Search the web (Exa) for external docs, APIs, changelogs, and product behavior not in the repo. Do not search for repo-local symbols or files. Returns ranked hits with excerpts. Answer from excerpts when they fully answer; scrape only when a concrete detail is missing or excerpts conflict (prefer official docs/.md/llms.txt).",
    promptSnippet: "Search the web; results include relevant excerpts.",
    // Policy lives in description + result footer (lean parent keeps system prompt clean).
    parameters: Type.Object({
      query: Type.String({
        description: "Natural-language search query. Be specific about the fact you need.",
      }),
      includeDomains: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Only these hostnames (e.g. ["docs.python.org", "docs.x.ai"]).',
        })
      ),
    }),
    async execute(_id, params, signal, onUpdate) {
      const key = env("EXA_API_KEY");
      if (!key) {
        return {
          content: [{ type: "text", text: "Missing EXA_API_KEY in ~/.pi/agent/.env" }],
          details: { error: "missing_exa_key" },
          isError: true,
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: `Searching: ${params.query}` }],
        details: { query: params.query, phase: "searching" },
      });

      try {
        const hits = await exaSearch(
          params.query,
          { includeDomains: params.includeDomains },
          key,
          signal
        );
        if (signal?.aborted) throw new Error("cancelled");

        return {
          content: [{ type: "text", text: formatHits(params.query, hits) }],
          details: {
            query: params.query,
            count: hits.length,
            urls: hits.map((h) => h.url),
            titles: hits.map((h) => h.title),
          },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `Search failed: ${msg}` }],
          details: { error: msg, query: params.query },
          isError: true,
        };
      }
    },
    renderCall(args: any, theme: any) {
      const q = typeof args?.query === "string" ? args.query : "…";
      const preview = q.length > 80 ? `${q.slice(0, 80)}…` : q;
      const domains = Array.isArray(args?.includeDomains)
        ? args.includeDomains.filter((d: unknown) => typeof d === "string").slice(0, 3)
        : [];
      let text =
        theme.fg("toolTitle", theme.bold("search ")) + theme.fg("accent", preview);
      if (domains.length > 0) {
        text += theme.fg("muted", ` in ${domains.join(", ")}`);
      }
      return new Text(text, 0, 0);
    },
    renderResult(result: any, { isPartial }: any, theme: any) {
      const details = result?.details as
        | { query?: string; count?: number; titles?: string[]; urls?: string[]; error?: string; phase?: string }
        | undefined;
      if (details?.error) {
        return new Text(theme.fg("error", `search failed: ${details.error}`), 0, 0);
      }
      if (isPartial || details?.phase === "searching") {
        const q = details?.query ?? "…";
        return new Text(theme.fg("warning", `searching ${q.length > 60 ? `${q.slice(0, 60)}…` : q}`), 0, 0);
      }
      const count = details?.count ?? 0;
      const titles = details?.titles ?? [];
      let text = theme.fg("success", `${count} result${count === 1 ? "" : "s"}`);
      for (const t of titles.slice(0, 4)) {
        const line = t.length > 70 ? `${t.slice(0, 70)}…` : t;
        text += `\n${theme.fg("dim", `  • ${line}`)}`;
      }
      if (titles.length > 4) {
        text += `\n${theme.fg("muted", `  … +${titles.length - 4} more`)}`;
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "scrape",
    label: "Scrape Page",
    description:
      "Fetch one URL as cleaned markdown (Firecrawl). Prefer after search when a concrete detail is missing from excerpts; if the user already gave a URL, scrape directly. Prefer official docs, .md, or llms.txt twins.",
    promptSnippet: "Open one URL as cleaned markdown.",
    // Policy lives in description (lean parent keeps system prompt clean).
    parameters: Type.Object({
      url: Type.String({ description: "URL to open." }),
      fresh: Type.Optional(
        Type.Boolean({
          description: "Bypass cache and re-fetch the page (slower).",
        })
      ),
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in ms (default 60000).",
          minimum: 1000,
          maximum: 120000,
        })
      ),
    }),
    async execute(_id, params, signal, onUpdate) {
      const key = env("FIRECRAWL_API_KEY");
      if (!key) {
        return {
          content: [{ type: "text", text: "Missing FIRECRAWL_API_KEY in ~/.pi/agent/.env" }],
          details: { error: "missing_firecrawl_key" },
          isError: true,
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: `Scraping: ${params.url}` }],
        details: { url: params.url, phase: "scraping", fresh: Boolean(params.fresh) },
      });

      try {
        const md = await firecrawlScrape(
          params.url,
          key,
          { timeout: params.timeout, fresh: params.fresh },
          signal
        );
        if (signal?.aborted) throw new Error("cancelled");
        return {
          content: [{ type: "text", text: maybeTruncate(md, "scrape") }],
          details: { url: params.url, length: md.length, fresh: Boolean(params.fresh) },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `Scrape failed: ${msg}` }],
          details: { error: msg, url: params.url },
          isError: true,
        };
      }
    },
    renderCall(args: any, theme: any) {
      const url = typeof args?.url === "string" ? args.url : "…";
      const preview = url.length > 90 ? `${url.slice(0, 90)}…` : url;
      let text =
        theme.fg("toolTitle", theme.bold("scrape ")) + theme.fg("accent", preview);
      if (args?.fresh) text += theme.fg("muted", " (fresh)");
      return new Text(text, 0, 0);
    },
    renderResult(result: any, { isPartial, expanded }: any, theme: any) {
      const details = result?.details as
        | { url?: string; length?: number; error?: string; phase?: string; fresh?: boolean }
        | undefined;
      if (details?.error) {
        return new Text(theme.fg("error", `scrape failed: ${details.error}`), 0, 0);
      }
      if (isPartial || details?.phase === "scraping") {
        const url = details?.url ?? "…";
        const short = url.length > 70 ? `${url.slice(0, 70)}…` : url;
        return new Text(theme.fg("warning", `scraping ${short}`), 0, 0);
      }
      const len = details?.length ?? 0;
      const size =
        len >= 1000 ? `${(len / 1000).toFixed(len >= 10_000 ? 0 : 1)}k chars` : `${len} chars`;
      let text = theme.fg("success", size);
      if (details?.fresh) text += theme.fg("muted", " · fresh");
      if (details?.url) {
        const url = details.url.length > 80 ? `${details.url.slice(0, 80)}…` : details.url;
        text += `\n${theme.fg("dim", url)}`;
      }
      if (expanded) {
        const c = result?.content?.[0];
        if (c?.type === "text" && typeof c.text === "string") {
          const preview = c.text.split("\n").slice(0, 12).join("\n");
          text += `\n${theme.fg("toolOutput", preview)}`;
        }
      }
      return new Text(text, 0, 0);
    },
  });
}
