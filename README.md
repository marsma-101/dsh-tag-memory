# dsh-tag-memory

> Tag-based, searchable, cross-session long-term memory for DSH agents.

[![Version](https://img.shields.io/badge/version-1.4.4-blue)]()
[![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1%2B-orange)]()
[![Tests](https://img.shields.io/badge/tests-464%20passing-brightgreen)]()

English | [中文](README.zh.md)

---

## The problem

DSH sessions are bounded: start a new one and the agent has forgotten what you said last time.

`dsh-tag-memory` stores what is worth remembering as **tagged entries**. Next time you enter a session
with the same identity, they can be recalled by tag — no need to repeat yourself.

---

## Design

### Two kinds of tags

| Kind | Meaning | Range |
|---|---|---|
| **Fixed tags** | Structured dimensions | shape (6) / stability (3) / status (3) |
| **Free tags** | Decided by the model, **no vocabulary** | max 20, stored `\|`-separated |

Fixed tags are locked in `lib/engine/templates/schema.json` — change a range in exactly one place.

### Isolation: you only read what you wrote

Every entry carries a `project` and an `agent`. Reads **hard-filter first**:

```
entry.project ∈ {universal, imported, current project}
AND  entry.agent ∈ {universal, imported, current agent}
AND  entry.status = active
```

**Cross-agent entries are invisible because of isolation, not because they scored low.**

### Recall: scores only decide "useful or not"

```
shape match    50 points
tag overlap    0–40 points (linear in q_ratio)
distance bonus 0–10 points (min(log2(distance) × 2, 10))
──────────────
pass line      40 points
```

Passing the line is not enough — two vetoes still apply:

| Veto | Condition | Meaning |
|---|---|---|
| Entry side | `e_ratio > 0.3` (strictly greater) | how much of this entry the query hit |
| Query side | `q_ratio >= 0.15` | whether the query points the right way |

Near-misses land in `near` (max 3), so the model can tell **a real empty result from a false one**.

### Storage: CSV you can edit by hand

```
store/memory.csv          9 columns, RFC4180 (quoted / "" escaped / newlines in fields)
records/write.jsonl       write ledger (successes and failures)
records/read.jsonl        read ledger (with feedback, drives the stability state machine)
records/tidy.jsonl        tidy ledger (before/after/basis per change)
backup/                   automatic backup before any library change
```

The 9 columns are `id, content, shape, project, agent, free tags, stability, distance, status`.
The library is a plain CSV: open it in any editor or spreadsheet.

---

## Install

### Option 1: the plugin market (recommended)

Open **Plugins → Discover** in dsh, search for `dsh-tag-memory`, install, then **restart dsh**.

Or from the command line (this is what the market entry uses):

```bash
dsh plugin --profile web add github:marsma-101/dsh-tag-memory
```

> Use whichever profile you actually run; in a container it may be `--profile headless`.
> This command needs pnpm and git — dsh invokes them itself, you don't install dependencies by hand.

### Option 2: `npx` (no pnpm / git needed)

**Requires only `node ≥ 24.9` + `npx` — no pnpm, no git, no installed plugins, no model.**

```bash
npx -y https://codeload.github.com/marsma-101/dsh-tag-memory/tar.gz/refs/tags/v1.4.4 apply
```

`npx` only downloads the package; the real work is [`scripts/install.mjs`](scripts/install.mjs)
(pure node, zero dependencies, about one second):

1. **Self-check this package**: name/version, `dsh.bundle.patch`, `exports`, `preset`/`lib` free of
   framework imports — if anything fails, **not a single byte is written**;
2. **Copy the plugin** to `<DSH_HOME>/plugins/dsh-tag-memory`;
3. **Link it** at `<profile>/node_modules/dsh-tag-memory` (Windows junction / POSIX symlink);
4. **Edit the profile's `package.json`**: add a `link:` dependency and append the bundle to
   `dsh.profile.bundles` (after backing it up);
5. **Verify**: same criteria as `verify-install.mjs`, and only prints `INSTALL OK` when all pass.

Common variants:

```bash
npx -y <same URL>                                  # dry run: preflight + plan, writes nothing
npx -y <same URL> apply --profile tui              # another profile
npx -y <same URL> apply --dsh-home /opt/dsh        # another DSH_HOME
npx -y <same URL> uninstall                        # dry-run uninstall (prints the purge plan)
npx -y <same URL> uninstall apply                  # really uninstall (memory library kept)
npx -y <same URL> uninstall apply --keep-backups   # also keep backup/
npx -y <same URL> uninstall apply --keep-runtime   # keep all runtime artifacts, unlink only
npx -y <same URL> cleanup --all-profiles           # dry-run: clean leftovers from old versions
node scripts/install.mjs apply                     # package already local: same script
```

**What uninstall keeps and what it purges:**

| | Item | Why |
|---|---|---|
| ✅ kept | `store/memory.csv` (the library itself) | your data; unrecoverable if deleted. Reuse it right after reinstall |
| ✅ kept | `store/.memory.lock` | empty lock file, may be in use |
| ✅ kept | `<DSH_HOME>/plugins/dsh-tag-memory` (body copy) | may serve as data-dir fallback; deleting risks data loss |
| 🗑 purged | `records/*.jsonl` (audit logs) | audit only; rebuildable while the library exists |
| 🗑 purged | `backup/` (auto backups) | unneeded while the library survives (`--keep-backups` keeps it) |
| 🗑 purged | `settings.json` (runtime params) | backup/tidy intervals; reset on reinstall |
| 🗑 purged | `<package>/config/` (library location picked in settings) | meaningless once the plugin is gone |

Uninstall **shows the plan before acting**: without `apply` it is a dry run that writes nothing.
The real run deletes item by item and reports each one — a failure on one item does not affect the
others — and it **re-checks that the library still exists afterwards**. If it ever went missing, the
script fails loudly instead of claiming success.

> ⚠️ Why uninstall must use this script rather than `dsh plugin remove` followed by cleanup:
> `dsh plugin remove` runs `pnpm remove`, which deletes the whole package directory — after that
> **no plugin code can run at all**. Cleanup therefore has to happen before removal, from outside the package.

**No guessing which instance**: with no arguments the script checks `$DSH_PROFILE_DIR` (DSH sets it in
every shell call) and lands in **the profile that is actually running**; without it, `$DSH_HOME`, then
`~/.dsh`. The output prints `target source = $DSH_PROFILE_DIR (current instance)` so a wrong target is
visible immediately.

Two limits worth knowing:

- **Permissions**: an agent's restricted sandbox (workspace-write) cannot write `DSH_HOME`. The script
  **pre-checks write access** and fails clearly (rather than dying half-way with EPERM) — run the same
  command in your own terminal, or use `plugin_manager install_bundle` (needs approval).
- **Restart**: bundle patches are composed at startup and an agent cannot restart its own process.
  After `INSTALL OK`, restart dsh (container: `docker restart <name>`); the 10 `dtm_*` tools appear after.

### Post-install check (read-only, needs neither pnpm nor a running dsh)

```bash
node ~/.dsh/profiles/web/node_modules/dsh-tag-memory/scripts/verify-install.mjs
```

---

## Initial memories (seeds)

A freshly installed library is empty: the UI shows nothing and the agent has no idea what to look for.
So a successful install also **seeds a few entries** (`scripts/seed.mjs`).

```bash
node scripts/seed.mjs                # dry run: print what would be written
node scripts/seed.mjs apply          # write (skipped automatically when the library is not empty)
node scripts/seed.mjs apply --force  # add even if the library already has entries
```

Every seed is `项目=通用` and `智能体=通用`, so **any project and any identity can see them**.

### What is seeded, and what is deliberately not

Not seeded: "introduce this plugin", "describe the 10 tools", "ask the user for an identity".
Those are already in the injection, in more detail — the injection is a fixed prefix present in
every session (5916 bytes), whereas seeds are retrieved **on demand**. Copying the injection into
the library would make `dtm_recall` return self-introductions when asked about tools, crowding out
real entries. **Whatever is needed every time belongs in the injection; only "look it up occasionally"
belongs in the library.**

Six entries are seeded, all things the injection cannot provide:

| Seed | Shape | Point |
|---|---|---|
| Where the library lives | fact | actual `store/memory.csv` path, editable/backup-able, survives uninstall |
| Seed origin | fact | these are seeds, rewritable and archivable, not project conclusions |
| Empty-recall triage | skill | empty on a new install is normal; do not "try another wording" |
| Tidy | skill | what tidy does, how it triggers, restore from `backup/` |
| Anti-pollution | rule | seeds are not user facts; reading them is not knowing the user |
| Subagent identity | skill | the correct way to hand an identity to a subagent (below) |

### Tag count and the recall gate

Recall has an entry-side hard gate (`read.mjs`; factory threshold **0.3**, calibrated 2026-11-11):

```
e_ratio = matched tags / entry tags   must be STRICTLY greater than 0.3
```

The matched fraction must exceed 30%, or the entry is vetoed. Querying with 2 tags:

| Entry tags | Query with 2 tags | Result |
|---|---|---|
| 6 | 2/6 = 0.33 | **passes** (>0.3) |
| 7 | 2/7 = 0.29 | vetoed |
| 3 | 2/3 = 0.67 | passes |
| 2 | 2/2 = 1.00 | passes |

So the largest tag count still findable with two words is **6** (2/6≈0.33 passes, 2/7≈0.29 is vetoed).
Earlier docs derived "exactly three" from the old 0.5 threshold; **that no longer holds after the 0.3 calibration** and is corrected here.

The invariant remains: **more tags make an entry harder to retrieve** with a single word.
Seeds also never share a tag, otherwise one query matches two entries and they compete for Top-K.
The threshold and comparators (entry side `>`, query side `>=`) live in `scoring.json` — do not change them from memory.

### Handing an identity to a subagent (easy to get wrong)

After the parent binds an identity (say "小明"), making a subagent act as the same identity
**requires telling it explicitly to call `dtm_bind` first**:

> First call `dtm_bind` with `智能体=小明`, then ...

**It is not inherited.** Measured results:

| Subagent form | Inherits identity? |
|---|---|
| `spawn` (default, fresh session) | ❌ `UNBOUND_IDENTITY` |
| `fork` (seeded with parent history) | ❌ still nothing (fork seeds conversation history, not plugin identity) |
| Subagent calls `dtm_bind` with the same name | ✅ sees every memory the parent wrote under that identity |
| Subagent calls `dtm_bind` with a different name | ✅ binds fine, but **cannot** see 小明's memories (isolation working as designed) |

The identity lives in an in-process WeakMap and is never written as an event, while a subagent is a
**fresh agent object with its own session** (`dsh-subagent-spawn-in-process` source: *its own session,
own system prompt, zero parent context*, with `inheritsParentContext = false`). So the subagent must
bind again itself. The good news: a subagent **inherits the parent's preset by default**
(`dsh-subagent` README L65: *Without a selection, a local child joins the parent's current preset
revision*), so it does have the `dtm_*` tools — one `dtm_bind` is all it needs.

---

## Data directory: 5 levels of priority

| Priority | Source | `dataDirSource` | Notes |
|---|---|---|---|
| 1 | `config.dataDir` | `config` | set explicitly in the patch, **locked** |
| 2 | `DSH_TAG_MEMORY_DATA_DIR` | `env` | environment variable, **locked** |
| 3 | chosen in settings UI | `settings` | picked by the user |
| 4 | `$DSH_HOME/tag-memory` | `dsh-home` | **factory default** (works with no config) |
| 5 | `<package>/data` | `package` | **last resort, warns** |

Where level 4 lands:

```
Linux/macOS:  $DSH_HOME/tag-memory          (in a container = /opt/dsh/tag-memory)
Windows:      %USERPROFILE%\.dsh\tag-memory
```

**Why level 5 is bad**: a warning in the log, in `getSettings().warning`, and in the UI.
Reinstalling or upgrading the plugin deletes the package directory, so **the data would be lost**.

---

## The 10 tools

| Tool | Purpose | Changes the library |
|---|---|---|
| `dtm_bind` | Bind this session's identity (agent) | — |
| `dtm_write` | Write one memory | yes, append |
| `dtm_recall` | Recall by shape + free tags | distance +1 on hit |
| `dtm_supersede` | Replace an entry (old one marked superseded) | yes |
| `dtm_archive` | Retire an entry (marked archived, row kept) | yes |
| `dtm_retag` | Change an entry's tag fields (**requires basis**) | yes |
| `dtm_review` | Read-only overview of a batch | no |
| `dtm_records` | Read the ledgers (write / read / tidy) | no |
| `dtm_export` | Export to CSV | no |
| `dtm_merge` | Merge another library | yes |

### Who decides what

`project` and `agent` are **program values, not model decisions**:

- `project` = the basename of the session's working directory (`workingDirectory.get(session)`);
- `agent` = the identity bound by `dtm_bind`.

On the first write or recall in an unbound session the plugin makes the model **ask you for a name**
and call `dtm_bind` — the model only decides free tags (plus content and shape).
Values the model supplies for `project`/`agent` are silently discarded; if the working directory
cannot be read the write fails with `PROJECT_EMPTY` instead of inventing a string.

### Two semantics that trip people up

**1. Omitting a field in `dtm_retag` is not clearing it**

```
{ id, stability, basis } only  →  only stability changes, everything else keeps its value
```

Omit what you don't want to change. An empty array/string means "clear it" and is rejected.

**2. `dtm_merge` resolves duplicate ids**

When both libraries hold the same id (e.g. `M-20261106-001`):

```
1. larger distance wins (distance = times recalled)
2. same distance → stability: stable > observed > volatile
3. identical → keep the current library (idempotent)
```

---

## Stability state machine

Driven by `feedback` in `read.jsonl`. Reads and writes never change it — only tidying evolves it:

```
        ok count ≥ 3 and no wrong
observed ──────────────────────────→ stable
   ↑                                   │
   │  no wrong this round              │ wrong > 0
   │  (it heals when things calm down) ↓
volatile ←─────────────────────────────┘
```

> **Many errors is not a reason to discard — it demotes to `volatile`**, giving the entry a chance to
> correct itself.

---

## UI

Mounted inside the **Plugins** page's plugin detail (it does not take a sidebar slot):

- **Entries page**: overview, filters (shape/status/project/agent/free tags), table, editor, pagination.
  Newest entries come first.
- **Settings page**: library location and relocation, backups, automatic tidying, a read-only preview of
  the tag dictionary, export to a chosen directory.

Candidate values in every dropdown are **scanned from your library at runtime** — nothing is hardcoded
in the frontend, so the list always matches the data you actually have.

**Editing boundary** (hard): only 6 fields are editable — `shape` / `project` / `agent` / `free tags` /
`stability` / `status`. `id` / `content` / `distance` are **always read-only**: they are the unique
identifier, the primary material, and a program counter.

---

## Development

```bash
# Full test suite (zero external dependencies, no shims)
node --test
```

```
468 tests: 464 passing / 0 failing / 4 visual checks not verified (reported honestly)
```

### Zero framework dependencies

`lib/engine/**` must not import any `@deepseek-ai/*` or `cordis` package (enforced by `purity.j.test`).
`preset/**` does not import framework packages either — `define-tool.js` is bundled.
Every module runs under plain `node --test`, outside DSH.

### Prompt injection budget

The per-turn system prompt section is held under **6000 bytes / 130 lines** (currently 5916 / 84) and a
test enforces it, so the plugin cannot quietly bloat every request.

---

## License

MIT
