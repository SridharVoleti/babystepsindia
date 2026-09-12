# Babysteps Universal Knowledge Map Creation & QA Checklist

**Status:** Universal governance checklist  
**Applies to:** Mathematics, Science, Social Studies, GK, Space, and future Babysteps learning subjects/apps  
**Purpose:** Prevent structural, semantic, progression, evidence, and governance defects before a knowledge map or registry is frozen.

> **Core principle:** A knowledge map is not complete because it contains the right topics. It is complete only when its nodes have clean semantic boundaries, meaningful variations, valid dependencies, genuine mastery progression, sufficient practice architecture, traceable evidence, and independent QA.

---

## A. Knowledge-map architecture

- [ ] Define the subject North Star before creating nodes.
- [ ] Define the expected class-exit capability.
- [ ] Define applicable competition, exam, curriculum, and real-world benchmarks.
- [ ] Build the map as a dependency graph, not merely a chapter/topic list.
- [ ] Use a consistent hierarchy: **Subject → Class → Phase → Module → Concept Node → Variation → Practice Set → Mastery**.
- [ ] Every Concept Node has a stable unique ID.
- [ ] Every variation has a stable unique ID.
- [ ] Separate atomic concepts from overlays, strategies, cross-cutting capabilities, and aliases.
- [ ] Do not create two atomic nodes for essentially the same capability.
- [ ] Do not hide two genuinely different concepts inside one oversized node.
- [ ] Preserve legacy IDs through explicit aliases when necessary rather than silently repurposing or deleting them.

---

## B. Atomic-node semantic boundary

For every atomic node:

- [ ] State its governing invariant/core idea in one precise sentence.
- [ ] Confirm the invariant distinguishes the node from its nearest neighbors.
- [ ] Confirm all owned variations are genuinely governed by that invariant.
- [ ] Confirm L1–L5 all assess the same invariant.
- [ ] Check whether any variation actually belongs to another node.
- [ ] Check whether any mastery criterion borrows the defining capability of a neighboring node.
- [ ] Check whether the node accidentally assesses a prerequisite rather than itself.
- [ ] Check whether it accidentally assesses a future concept rather than itself.
- [ ] Hide the concept title and confirm an expert could still identify the intended concept from the performance.

### Atomic Boundary Test

> If a mastery task is more naturally identified as another node when the title is removed, it fails.

---

## C. Concept identity and non-substitutability

For every mastery criterion, especially L3–L5:

- [ ] Remove the concept title.
- [ ] Ask what concept the performance actually demonstrates.
- [ ] Try replacing the concept with the closest neighboring node.
- [ ] If the statement remains substantially valid, rewrite it.
- [ ] Avoid universal prose such as “solve unfamiliar problems and explain reasoning.”
- [ ] Observable evidence must expose this concept's reasoning, not generic good problem-solving behavior.

### Swap Test

> Could this criterion be pasted into a neighboring node with only the concept name changed?

**YES → FAIL.**

---

## D. Variation design

For every variation:

- [ ] It represents a genuinely different reasoning situation.
- [ ] It is not merely different numbers, names, colors, pictures, or cosmetic context.
- [ ] A new story counts as a variation only when it changes the mathematical/cognitive demand.
- [ ] Its relationship to the parent Concept Node is explicit.
- [ ] Its prerequisites are known.
- [ ] Its remediation route is known.
- [ ] Its evidence/benchmark status is explicit.
- [ ] Its bank status is explicit.
- [ ] Alias variations clearly identify their owning atomic node.
- [ ] The variation remains inside the owning node's semantic boundary.

Variation dimensions should deliberately explore, where appropriate:

**representation · context · direction · unknown position · ordering · constraints · construction · missing information · error detection · reverse reasoning · transfer · multi-step reasoning · unfamiliar structure**

---

## E. T0–T5 transfer classification

Do not assign T-levels using keyword rules. Classify the actual reasoning demanded.

| Level | Meaning |
|---|---|
| **T0** | Same task, same form |
| **T1** | Surface change |
| **T2** | Representation change |
| **T3** | Direction/context/constraint/reverse/error/strategy-condition change |
| **T4** | Multiple concepts genuinely combined |
| **T5** | Unfamiliar competition/proof/completeness/worst-case style reasoning |

Checks:

- [ ] Classification is based on cognitive/mathematical demand, not wording.
- [ ] Constraint reasoning is not incorrectly T0.
- [ ] Strategy selection under conditions is not incorrectly T0.
- [ ] Reverse and error reasoning receive appropriate transfer classification.
- [ ] L4's stated T-level agrees with its variation metadata.
- [ ] T5 is not assigned merely because something looks difficult or unfamiliar.

---

## F. Mastery progression: L1 → L5

Mastery levels must represent increasing capability, not five differently worded assessments.

### L1 — Foundation

- [ ] Supported enactment/recognition.
- [ ] Learner encounters the actual concept.
- [ ] Manipulation/visual support is appropriate.
- [ ] L1 is concept-specific.

### L2 — Fluent intrinsic performance

- [ ] Learner independently performs the concept's basic intrinsic capability.
- [ ] L2 is specific to this concept.
- [ ] It is not a universal “solve familiar examples” shell.
- [ ] Explicitly record which variations L2 already requires.

### L3 — Reasoning

- [ ] Exposes a concept-specific misconception.
- [ ] Requires explanation, discrimination, correction, or reasoning.
- [ ] Correct answer alone is insufficient evidence.
- [ ] The misconception genuinely belongs to this concept.

### L4 — Genuine transfer

- [ ] L4 introduces a **specific mathematical/cognitive change**.
- [ ] State exactly what changed.
- [ ] State exactly what the learner does.
- [ ] Preserve the same invariant.
- [ ] L4 anchor is not already explicitly mastered at L2.
- [ ] L4 does not merely describe an L2 task more elaborately.
- [ ] L4 anchor belongs to this atomic node.
- [ ] L4 does not use an alias owned by another atomic node.
- [ ] Specific change and learner action describe the same transfer event.
- [ ] Transfer evidence is observable.
- [ ] T-level agrees with the actual transfer demand.

### L2 → L4 Regression Rule

> **L2 performs X → L3 reasons about X → L4 performs X again = FAIL.**

### L5 — Excellence

> **L5 must demonstrably require deeper reasoning than L4 while testing the exact same invariant.**

- [ ] L5 does not fall backwards to an L2 capability.
- [ ] L5 is genuinely beyond L4.
- [ ] Harder-looking presentation alone does not qualify.
- [ ] “Unfamiliar” alone does not qualify.
- [ ] “Deceptive” alone does not qualify.
- [ ] Making a familiar surface shortcut fail is not, by itself, Excellence.
- [ ] L5 stays inside the atomic-node boundary.
- [ ] Title-blind, the challenge is identifiable as this concept.
- [ ] Observable evidence is concept-specific.
- [ ] Correct final answer alone cannot demonstrate L5.
- [ ] If L5 reuses an L4 variation, it adds a genuine higher-order demand.

Potential L5 mechanisms, only when intrinsic to the concept, include:

**proof/justification · completeness · constrained construction · counterexample · inverse verification · uniqueness · optimization · systematic enumeration · worst-case guarantee · error diagnosis · defending an invariant under deceptive transformation**

These are tools, not reusable templates.

---

## G. Full progression regression

Inspect **L1 → L2 → L3 → L4 → L5 together**, not as independent fields.

- [ ] Independence increases.
- [ ] Reasoning increases.
- [ ] Transfer increases.
- [ ] Concept identity remains stable.
- [ ] No level falls backwards.
- [ ] No level simply repeats a previous level.
- [ ] L4 genuinely exceeds L2.
- [ ] L5 demonstrably exceeds L4.
- [ ] No level crosses into a neighboring node.
- [ ] The governing invariant survives all five levels.
- [ ] Maintain a node-by-node progression ledger for independent QA.

---

## H. Dependency graph

For every node:

- [ ] Direct prerequisites are explicit.
- [ ] No self-prerequisites.
- [ ] No unknown node IDs.
- [ ] No cycles.
- [ ] Prerequisites are semantic, not merely based on teaching order.
- [ ] Direct dependents are exact mechanical reverses of prerequisite edges.
- [ ] Later pedagogical reuse is distinguished from true dependency.
- [ ] A future concept is not accidentally required as a prerequisite.
- [ ] Cross-class dependencies are represented where needed.
- [ ] Dependency information supports just-in-time remediation.

### Single Source of Truth

> Define direct prerequisites once. Generate direct reverse dependents mechanically.

---

## I. Diagnostics and remediation

For every meaningful misconception:

- [ ] Diagnostic distinguishes the misconception rather than merely detecting a wrong answer.
- [ ] Diagnostic identifies the smallest missing prerequisite/variation.
- [ ] Remediation targets that exact gap.
- [ ] Remediation has a stable ID.
- [ ] Return test is explicit.
- [ ] Return test demonstrates concept-specific recovery.
- [ ] Learner returns to the interrupted main path after mastery.
- [ ] Already-mastered prerequisite content is not unnecessarily repeated.

---

## J. Spiral and future reuse

- [ ] Every important concept has deliberate future reuse.
- [ ] Spiral target is semantically meaningful.
- [ ] Near-term and later-semantic reuse are distinguished.
- [ ] Spiral relationships do not masquerade as direct dependencies.
- [ ] Important concepts recur in increasingly sophisticated contexts.
- [ ] Later classes can reference earlier nodes cleanly.

---

## K. Competition, curriculum, and benchmark evidence

Never treat “Olympiad” or any other benchmark family as one generic category.

For every applicable competition/exam:

- [ ] Eligibility/class/age known.
- [ ] Levels/stages known.
- [ ] Syllabus/domain coverage known.
- [ ] Duration known.
- [ ] Number of questions known.
- [ ] Sections known.
- [ ] Marks/weighting known.
- [ ] Negative marking known.
- [ ] Response format known.
- [ ] Question/reasoning archetypes understood.
- [ ] India accessibility classified where relevant.
- [ ] Participation target and curriculum-only benchmark distinguished.
- [ ] Source year/version recorded.
- [ ] Evidence comes from an authoritative/current source where possible.

For every registry variation:

- [ ] `DIRECT_VERIFIED` is used only when the source corpus genuinely contains the same reasoning archetype.
- [ ] Direct evidence has a traceable source anchor.
- [ ] Curriculum-required capabilities without direct evidence are labelled accordingly.
- [ ] Benchmark/enrichment capabilities are labelled accordingly.
- [ ] Absence from one exam corpus is not interpreted as evidence that the concept is unnecessary.
- [ ] Direct anchors receive source-level verification before final freeze.

---

## L. Practice-bank readiness

For every active `BANK_REQUIRED` variation:

- [ ] Minimum **10 genuinely distinct core problems**.
- [ ] Problems cover the variation rather than cosmetic permutations.
- [ ] Reinforcement bank exists.
- [ ] Remediation bank exists.
- [ ] Challenge bank exists.
- [ ] Problems vary reasoning structure where appropriate.
- [ ] Error-correction problems are included where relevant.
- [ ] Transfer problems are included.
- [ ] Challenge problems genuinely exceed ordinary practice.
- [ ] No meaningless repetition.

### Readiness distinction

> **REGISTRY_READY / REGISTRY_FREEZE ≠ CONTENT_READY.**

A structurally and semantically strong registry without its actual problem/activity banks is not content-ready.

---

## M. Semantic authoring vs mechanical validation

### Scripts are appropriate for

- [ ] Counting nodes and variations.
- [ ] Finding duplicate IDs.
- [ ] Finding missing fields.
- [ ] Dependency reversal.
- [ ] Cycle detection.
- [ ] Detecting repeated exact prose.
- [ ] Finding L2/L4 anchor duplication.
- [ ] Checking alias ownership.
- [ ] Checking metadata consistency.
- [ ] Validating schemas.
- [ ] Comparing canonical counts and machine-readable snapshots.

### Scripts must not be treated as proof of

- [ ] Concept identity.
- [ ] Semantic correctness.
- [ ] Mastery quality.
- [ ] Transfer depth.
- [ ] L5 Excellence.
- [ ] Non-substitutability.
- [ ] Appropriate T-level.
- [ ] Pedagogical progression.
- [ ] Invariant fidelity.

> A script touching every row is not a semantic audit.

---

## N. Authoring vs independent QA

Keep workflow states explicitly separate:

**AUTHOR-SIDE CREATED → AUTHOR-SIDE REGRESSION PASSED → INDEPENDENT QA → DEFECT CORRECTION → INDEPENDENT RE-VERIFY → FREEZE**

- [ ] Do not convert “all fields populated” into “all fields semantically correct.”
- [ ] Author-created audit ledgers do not independently certify their own semantic judgments.
- [ ] Every author-side semantic fix remains `AWAITING INDEPENDENT QA` until independently rechecked.
- [ ] A targeted fix does not automatically close the broader gate.
- [ ] Status language states exactly what evidence supports.

---

## O. Canonical artifact quality

- [ ] Canonical document has one authoritative version.
- [ ] YAML/machine snapshot version matches document version.
- [ ] Counts in prose match machine-readable metadata.
- [ ] Snapshot/prose conflicts automatically block freeze.
- [ ] No obsolete QA closure ledger remains inside the canonical artifact.
- [ ] No stale historical readiness statement is presented as current status.
- [ ] Historical patch notes live in separate audit files.
- [ ] Normative rules are written as current rules, not version-history narration.
- [ ] Legacy information remains only where operationally necessary to interpret preserved IDs/aliases.
- [ ] Current readiness language refers to the current artifact.
- [ ] IDs and counts survive editorial cleanup unchanged.

### Canonical principle

> **Registry = current normative truth. Audit files = history of how we got there.**

---

## P. Freeze gates

### Structural gate

- [ ] IDs valid.
- [ ] Counts reconciled.
- [ ] Dependencies valid.
- [ ] No cycles, self-links, or unknown references.
- [ ] Aliases valid.
- [ ] Reverse dependency metadata matches prerequisite edges.

### Semantic gate

- [ ] Atomic boundaries independently verified.
- [ ] Invariants independently verified.
- [ ] Variations correctly owned.
- [ ] Title-blind identity tests pass.
- [ ] Neighbor swap tests pass.
- [ ] No defining capability is borrowed from another atomic node.

### Mastery gate

- [ ] L1–L5 concept-specific.
- [ ] L2 intrinsic.
- [ ] L3 misconception-specific.
- [ ] L4 is a new genuine transfer beyond L2.
- [ ] L5 is demonstrably beyond L4.
- [ ] No backward progression.
- [ ] No cross-node borrowing.
- [ ] Observable evidence demonstrates reasoning rather than answer-only correctness.

### Evidence gate

- [ ] Competition/curriculum evidence taxonomy valid.
- [ ] Direct anchors independently source-verified.
- [ ] Benchmark status accurately labelled.

### Governance gate

- [ ] Canonical snapshot agrees with prose.
- [ ] No stale status/version language.
- [ ] Author-side and independent-QA statuses are clearly separated.
- [ ] Independent QA completed for all freeze-blocking requirements.

Only after all applicable registry gates pass:

**`REGISTRY_FREEZE`**

`CONTENT_READY` remains a separate later gate requiring actual practice/activity, reinforcement, remediation, challenge assets, and their QA.

---

## Q. 12-question Concept Node approval test

Before approving any Concept Node, the reviewer must be able to answer **YES** to all twelve:

1. [ ] **What exactly is this concept?**
2. [ ] **What is its invariant/core principle?**
3. [ ] **Why is it separate from its neighboring nodes?**
4. [ ] **What genuinely different variations does it contain?**
5. [ ] **What must already be known?**
6. [ ] **What misconception uniquely reveals failure to understand it?**
7. [ ] **What does independent fluent mastery look like?**
8. [ ] **What new transfer does L4 require beyond L2?**
9. [ ] **What deeper reasoning makes L5 genuinely beyond L4?**
10. [ ] **Would L2–L5 still unmistakably identify this concept if its title disappeared?**
11. [ ] **What evidence shows the learner reasoned correctly rather than guessed the answer?**
12. [ ] **Where does this concept lead next, and how will the system remediate it if mastery fails?**

If any answer is weak:

**THE NODE IS NOT READY TO FREEZE.**

---

## R. Universal Babysteps Knowledge Map quality pipeline

The reusable architecture for future classes and subjects is:

**North Star**  
→ **Class/Stage Exit Capability**  
→ **Atomic Concepts**  
→ **Governing Invariants/Core Ideas**  
→ **Meaningful Variations**  
→ **Dependency Graph**  
→ **Diagnostics & Remediation**  
→ **L1–L5 Mastery Progression**  
→ **Transfer Classification**  
→ **Competition/Curriculum/Real-World Evidence**  
→ **Practice Architecture**  
→ **Mechanical Regression**  
→ **Independent Semantic QA**  
→ **Canonical Artifact QA**  
→ **Registry Freeze**  
→ **Content/Asset Creation & QA**  
→ **CONTENT_READY**

The subject-specific meaning of an invariant, misconception, transfer, and excellence behavior will differ across Mathematics, Science, Social Studies, GK, Space, and other subjects. The **quality-control architecture remains universal**.

---

## Final governing rule

> **Do not freeze a knowledge map because it looks comprehensive. Freeze it only when its structure, semantic boundaries, progression, dependencies, evidence, canonical metadata, and independent QA all agree.**
