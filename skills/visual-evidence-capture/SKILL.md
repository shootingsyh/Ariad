---
name: visual-evidence-capture
description: How to produce rendered visual evidence that survives review - frames from the current build, captured after the last change they prove, at real gameplay camera positions, each showing exactly what its criterion names. Use when a task's acceptance depends on screenshots or rendered frames (presentation, UI, maps, characters, effects).
---

# Capturing visual evidence that proves something

## Freshness is the whole game

An evidence frame proves a claim about the CURRENT build. It must be
rendered by the current build and captured AFTER the last code or
asset change that affects what it shows. A frame older than the change
it claims to prove is stale evidence; recapture it. When assets are
regenerated, every frame showing them is stale from that moment.

## Rules

- When a criterion is visual, only a frame judges it. Headless text
  assertions, node-property checks, and source reading can support a
  frame; they never substitute for one. A test batch with zero frames
  for a visual criterion is a failed evidence batch, however green.
- Each frame must show the thing its criterion names, at a real
  gameplay camera position and at gameplay scale - the view the player
  gets, not a debug camera and not a shrunken overview.
- For anything larger than one screen (maps, scrolling, camera
  limits), capture several camera positions; if continuity or a limit
  is the claim, capture the sequence that demonstrates it (e.g. the
  camera resting at each limit). One frame cannot prove a range.
- Hygiene: no editor UI, debug overlays, placeholder or debug
  geometry, selection boxes, or stray cursors in evidence frames
  unless they are the subject. Anything unexplained in a frame will
  rightly be read as a defect.
- Keep frames findable and attributable: a stable evidence directory,
  file names that say what each frame proves, and a note of the build
  or commit they were captured from.
