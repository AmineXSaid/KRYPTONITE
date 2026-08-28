# Corpus map

Which file answers which question, and what to run against it.

This map is deliberately about KINDS of file, not fixed paths. Fill the paths in
for this workspace the first time you use the skill, and correct them here when
they move; a map that names a file nobody has is worse than no map.

## the four sources

| kind | typically | answers | authority |
|---|---|---|---|
| Codebeamer export | `docs/cb_*.html` | what must be tested | requirements |
| LDF | `*.ldf` | what the value is | frames, signals, schedules |
| course pages | `docs/*course*.html` | why it works that way | mechanism |
| test suite | `tests/` | what is actually tested | coverage |

**Authority order when they disagree.** The requirement decides *what must be
tested*. The LDF decides *what the value is*. The course decides *why*. Say the
conflict in one line rather than picking silently.

The test suite is never an authority. A test can be wrong, and saying so is the
most useful thing this skill does.

## what to run

```bash
# a requirement id
python3 <skill>/scripts/corpus.py tables docs/cb_export.html --match LIN_576

# a term, anywhere
python3 <skill>/scripts/corpus.py grep docs/*.html "checksum|0x3C" -C 1

# a numbered section, once grep tells you which
python3 <skill>/scripts/corpus.py section docs/course.html "2.3"

# what sections exist at all
python3 <skill>/scripts/corpus.py outline docs/course.html --depth 3

# the test side
grep -rn "0x3C\|MasterReq" tests/
```

`<skill>` is the folder path `read_skill` printed. The script is stdlib-only
Python 3 and touches no network, so it is safe on an air-gapped bench.

## reading the output

Every subcommand prints a `SOURCE:` line. Copy it verbatim into the answer.
Never write a source line the tool did not print, and never tidy one up.

## when the corpus does not have it

Three honest outcomes, in order of preference:

1. `not in corpus` plus a question naming which file would hold it.
2. `[spec]` for general LIN knowledge that is true independent of this
   cluster, such as sync being 0x55 or 0x3C being classic-checksummed.
3. Delete it. An unattributed frame id, NAD or timing is worse than a gap,
   because it will be believed.

## LDF is not HTML

`corpus.py` reads HTML. An LDF is plain text, so `grep -n` it directly. Do not
run `corpus.py` at an LDF and report that the corpus is empty.
