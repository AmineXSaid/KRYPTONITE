---
name: lin-test-review
description: Review LIN bus test cases against ISO 17987 conventions. Use when writing or reviewing LIN frame, schedule table, or diagnostic test code.
---

# Reviewing LIN test cases

## Frame level
- Break field is at least 13 dominant bits, sync field is 0x55.
- Protected identifier carries correct parity on ID4 and ID5.
- Checksum type matches the frame: classic for diagnostic frames 0x3C and 0x3D, enhanced otherwise.

## Schedule level
- Frame slot durations account for the permitted jitter.
- The schedule table entry order matches the LDF.

## What to report
List findings as file:line with the specific clause involved. Do not rewrite the test unless asked.
