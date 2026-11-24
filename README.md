[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Teachanjc/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Teachanjc/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Built for [hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) on make.fun.

# mend

A command-line tool that applies AI-written edits to a tree of text files.

It reads one patch and applies every edit in it, or nothing at all when
any edit fails. Four patch formats are supported: unified diffs,
SEARCH/REPLACE blocks, V4A patches, and JSON edit objects. The format is
detected automatically unless `--format=NAME` names one.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is the patch file; when it is absent or `-`, the patch is read
from standard input. `--check` reports what would change without writing
anything. `--strict` matches lines exactly, with no whitespace tolerance.

Old lines are found at the first of three matching tiers that finds
them: exact, ignoring trailing whitespace, then ignoring leading and
trailing whitespace. Unified hunks take the occurrence nearest the
line number the patch names; SEARCH/REPLACE blocks fail when the old
lines occur more than once; V4A chunks are found in order with a
cursor, optionally anchored to a line or to the end of the file.

## Exit codes

- `0`: all edits applied; one line per changed file, then `ok: <n> files`.
- `1`: one `error: <code> <path>` line per failed edit, then a
  `failed: <k> of <n> edits` line; no file is written.
- `2`: a usage, patch-reading, format-detection, or parse error; a
  single `error: ...` line and nothing else.

`SPEC.md` is the full specification. Node 22 and its standard library
only; there is nothing to install.
