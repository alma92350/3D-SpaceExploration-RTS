# Working agreement

How work happens here. Read this once before your first task; it is short on purpose.

**If you are an AI agent picking up work in a fresh session, this file plus
[`TASKS.md`](TASKS.md) plus [`../PRD.md`](../PRD.md) is everything you need. Read them in that
order.**

---

## 1. Picking up work

1. Open [`TASKS.md`](TASKS.md).
2. Take the **topmost task whose status is `READY`** and whose dependencies are all `DONE`. Do not
   skip ahead to a more interesting one; the order encodes the dependencies you cannot see.
3. **Claim it in a commit before you write code**: set its status to `IN-PROGRESS`, put your
   identifier and the date in the Notes column, push. This is the collision-avoidance mechanism —
   two agents claiming the same task is a merge conflict on one line rather than two days of
   duplicated work.
4. If nothing is `READY`, the phase is either blocked or finished. Check the phase gate in the PRD,
   run the gate checks, and say so — do not invent work.

## 2. The TDD loop — not optional

For every task that changes behaviour:

1. **Write the test first**, from the task's definition of done, in the layer that owns it
   (ADR-0009). Write it from the *requirement*, not from the implementation you have in mind.
2. **Run it and watch it fail — for the right reason.** A test that fails on a typo has proven
   nothing. If it passes immediately, the test is wrong or the work is already done; find out which.
3. **Make it pass with the smallest change** that could work.
4. **Refactor** with the suite green.
5. **Run everything before pushing**: `npm test && npm run test:sim && npm run typecheck && npm run perf`.

The exception list — changes that may merge without a new test — is exactly: pure renames,
comment/documentation-only changes, vendored engine syncs, and generated files. Nothing else. If
you think you have found a sixth exception, you have found a missing test layer; say so in the PR.

## 3. Definition of done

A task is `DONE` when **all** of these are true:

- [ ] A test exists that failed before the change and passes after it.
- [ ] The whole suite is green: `npm test`, `npm run test:sim`, `npm run typecheck`.
- [ ] The perf gate is green: `npm run perf` within budget, no baseline regression > 10 % (ADR-0006).
- [ ] Every acceptance line in the task's definition of done is demonstrably true.
- [ ] Any architectural decision made along the way has an **ADR merged before the code** (ADR-0001).
- [ ] Documentation that is now wrong has been fixed in the same PR — including the PRD, the
      universe digest, and this board.
- [ ] `TASKS.md` shows the task `DONE`, with a one-line note saying what shipped.

Half-done is not done. If you cannot finish, leave the task `IN-PROGRESS` with a note saying
exactly where you stopped, what works, what does not, and what you would do next. **Leaving work
pickup-able is part of the job**, not a courtesy.

## 4. When to write an ADR

Before the code, if the decision is hard to reverse, cross-cutting, surprising, or spends the
performance/payload/determinism budget. Full triggers and format: [`../adr/README.md`](../adr/README.md).

If you find yourself writing a comment that begins "note that we deliberately…" and it concerns
more than one file, that is an ADR.

## 5. Code conventions

- **Comments explain _why_.** Match the parent project's density: this codebase documents the
  reasoning, the rejected alternative, and the bug that motivated the shape. A comment restating
  the code is noise; a comment recording why the obvious version is wrong is the most valuable line
  in the file.
- **TypeScript strict** for new code. The vendored engine is JavaScript and is never edited
  (ADR-0003).
- **No allocation in the render loop.** Preallocate, reuse, and if you must grow, grow in powers of
  two outside the frame (ADR-0006).
- **`view/` never imports `engine/`.** Everything crosses through `bridge/` (ADR-0008). There is a
  test for this; do not work around it.
- Prefer a small pure function in the right module over a clever one-liner.
- Match the surrounding style. The repo should read as though one person wrote it.

## 6. Branches, commits, PRs

- Branch per task: `task/P1-T07-instanced-unit-batches`.
- Commit messages say **what changed and why**, in the imperative. Reference the task id.
- One task per PR where possible. A PR that touches an ADR, the board and the code is normal and
  good; a PR that does three tasks is hard to review and hard to revert.
- PR description states: the task, the test that proves it, and the perf numbers if they moved.
- Do not merge a red build. Ever. A required check that people walk past is not a check.

## 7. Sessions and hand-off

At the end of a working session, whatever state you are in:

1. Push your branch.
2. Update `TASKS.md` — status and a note that would let a stranger continue.
3. If you learned something durable (a constraint, a gotcha, a rejected approach), write it down in
   the ADR or the task note. **A finding that lives only in a chat transcript is a finding that will
   be rediscovered the expensive way.**

## 8. Questions and blockers

- A question that changes what you build: raise it as `Q-nn` in the PRD's open-questions list and
  say so in the task note. Do not guess on a decision that is the stakeholder's to make.
- A question you can answer from the source repo, the ADRs, or a test: answer it yourself and
  record the answer where the next person will look.
- If the source repo and this project disagree about a game rule, the source repo is right
  (PRD §2). File it upstream.
