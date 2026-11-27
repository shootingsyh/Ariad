---
name: packaging-and-release
description: How to plan packaging, sealing, provenance and distribution work in a project that ships a built artifact - packaging machinery can be built any time, but package acceptance (seal, provenance, package journey, store build) is end-stage work that must depend on the feature/content work it certifies, never only on the packaging machinery. Use when planning or triaging packaging, export, signing, provenance or release tasks.
---

# Packaging and release: acceptance comes last

A package seal certifies a finished product. Sealing a product that is
still changing does not produce safety - it produces drift, reseals, and
a queue of packaging fixes competing with the feature work that makes
the product worth shipping. Plan packaging in two separate kinds.

## 1. Two kinds of packaging work

- **Machinery**: the build/export/sign/pack pipeline itself - can it
  build at all, are the tools wired, does signing work. Machinery can be
  built and smoke-tested at any time, cheaply, and machinery defects
  (pipeline broken, tool misconfigured) are real defects: fix them when
  found.
- **Acceptance**: sealing a specific build, recording provenance,
  running package journeys, store-submission checks. Acceptance makes a
  claim about THIS product content, so it is only meaningful once that
  content has stopped changing.

## 2. Dependency rule for acceptance tasks

An acceptance task must depend on the feature/content work it
certifies - in practice on the project's release or content-freeze
milestone, or on the feature milestones whose output goes into the
package. It must never depend only on the packaging machinery
(the pack/export task). Depending only on the machinery means the task
is dispatchable from day one and will be run, and re-run, against
unfinished content.

If the plan has no freeze point, create one: a milestone that closes
when the shippable content is final. Acceptance tasks hang off it.

## 3. Do not seal an unfinished product

While features or content are still landing, every seal is guaranteed
to drift, and each drift spawns a fix task that costs a full
execution cycle. Defer acceptance to the freeze, and batch: one
acceptance pass over the frozen product, not continuous re-acceptance
during development. Machinery smoke tests are the only packaging
verification that runs during development.

## 4. Triage: machinery defect vs content drift

When a package check fails during development, classify before
creating a task:

- The pipeline produced something wrong (bad structure, broken
  tooling, wrong entries in the package): machinery defect, fix now.
- The recorded hash/content no longer matches because the product
  legitimately changed: that is drift, not a defect. Record it and let
  the freeze-time acceptance pass absorb it. Do not spawn an immediate
  reseal task for every content change.

## 5. Scheduling

Acceptance is the last wave by design. On a constrained executor it
must not starve feature work: a queue where packaging fixes repeatedly
win the slot over unfinished features is a planning error, not a
priority signal. If acceptance tasks are already planned early, gate
them on the freeze milestone rather than deleting them.

Exception: when the deliverable itself is the packaging/release
pipeline (release tooling, CI), the machinery IS the product and this
skill's acceptance rules apply to that project's own releases instead.
