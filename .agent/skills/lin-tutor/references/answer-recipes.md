# Answer recipes

One recipe per question type. Each says what to run, which schema to fill, and
the order the parts go in. The shape in SKILL.md still governs; this only fixes
the ORDER of the middle, which is where answers usually go wrong.

Every recipe ends the same way: an **Anchor** line and a **Source** line the
tool actually printed.

## what does this test do

Run `grep -rn "<test name>" tests/` then `tables <cb export> --match <req id>`.

1. The requirement, as one sentence with its id.
2. The assertion the test makes, in the test's own terms.
3. The bytes that assertion looks at, filled into `test case shape`.
4. `passes iff ...` in one line.

Do not explain the test framework. The question is about the bus.

## explain this code

No schema. Show at most 15 trimmed lines, annotated on the line itself.

```python
sched.send(0x3C, [0x01, 0x06, 0xB2, ...])   # -> MasterReq, NAD 0x01, SID 0xB2
```

Never paraphrase syntax in prose ("this calls send with a list"). Cut setup,
imports and asserts that are not the point; mark the cut with `...`. End with
the bytes it produces on the bus, not with a summary of the function.

## what does this requirement mean

Run `tables <cb export> --match <req id>`.

1. The shall, one sentence, no hedging.
2. The bus observable: what a scope or trace would have to show.
3. Which test covers it, by path, or `uncovered`.

If the requirement is untestable as written, say that in line 1.

## why did it fail

Fill `failure ladder`, then `trace divergence`.

Bottom-up: wire, header, response, checksum, schedule, config. Stop at the
first layer that explains it. One cause only. Expected above observed with a
caret at the divergence.

Resist the second cause. A second cause is a guess, and a guess in a failure
answer costs a day of someone chasing it.

## difference between A and B

One table, three rows, then the deciding rule.

```
              A              B
match on      <..>           <..>
sent when     <..>           <..>
breaks if     <..>           <..>

rule: <the one sentence that picks between them>
```

Three rows, not five. The rule is the part worth memorizing.

## quiz me

Five questions: two recall, two read-this-trace, one what-breaks-if. Answer key
after all five, never inline. Then append the misses to `LIN-TUTOR-LOG.md` with
the date, so the next quiz can start there.

Traces in a quiz must come from the corpus, not be invented.

## definitions and policy

No schema, no diagram. Two lines and an anchor. If it fits in one line, use one.
