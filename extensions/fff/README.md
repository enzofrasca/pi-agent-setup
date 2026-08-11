# @local/fff

Lean FFF-backed `find` / `grep` for our pi harness. Fork of [`@ff-labs/pi-fff`](https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff).

## What it is

Same FFF engine (fuzzy find + ranked grep), with a **stock-pi-shaped** tool surface:

| Choice | Why |
|--------|-----|
| Default mode `override` | Tools named `find` / `grep` — drop-in for built-ins |
| `promptGuidelines: []` | Stock find/grep have none; upstream FFF spammed ~10 bullets |
| Defaults 12 / 20 | Ranked head beats unranked dumps (stock 100 / 1000) |
| `truncateHead` @ 50KB | Matches pi core truncation contract |
| Stock `details` | `matchLimitReached` / `resultLimitReached` / `truncation` |
| No `multi_grep` | Dead weight; models thrash it or never need it |
| Thrash guard | Identical fresh query within 120s → short redirect |

## Install

Loaded as a **package** (not bare extension file) so deps + `package.json` `pi.extensions` work:

```json
{
  "packages": ["extensions/fff"]
}
```

Path is under `extensions/` for layout only. Entry is still `src/index.ts` via the package manifest (there is no `extensions/fff/index.ts`, so auto-discovery does not double-load it).

Optional env (defaults are already lean):

```bash
export PI_FFF_MODE=override   # also set in extensions/defaults
```

Slash commands: `/fff-mode`, `/fff-health`, `/fff-rescan`.

## vs upstream

Keep this package. Upstream defaults to `tools-and-ui` (`fffind`/`ffgrep`) and injects always-on guidelines. That is pure system-prompt tax for no engine gain.

Rebase: re-pack a newer `@ff-labs/pi-fff` and re-apply lean surface + `finishOutput` + thrash + multi_grep removal.
