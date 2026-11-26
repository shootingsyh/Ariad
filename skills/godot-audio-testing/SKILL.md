---
name: godot-audio-testing
description: How to test Godot 4 game audio (BGM, SFX, voice) in headless CI with the Dummy audio driver - verify wiring and playback state, never measured loudness. Use whenever a task writes, runs, or judges tests for audio playback, an audio manager, or audio wiring at game entry points.
---

# Testing Godot audio in headless CI

## The one fact that decides everything

Headless test runs use `--audio-driver Dummy`. That driver outputs silence
by design: `AudioServer` bus peak volumes and spectrum analyzers read
silence no matter what is playing. There is no level API that "works" in
this environment.

Therefore:

- Never try to prove playback by measuring loudness, peak volume, or
  spectrum data.
- Never read engine class documentation or write probe scripts hunting
  for a measurement API. That search has no successful end here.
- Never make a verdict depend on `get_playback_position()` advancing;
  position behavior under the Dummy driver is not the contract.

## Verify state and wiring instead

Judge audio at the project's own audio boundary (its audio manager /
autoload and the players it owns):

1. Trigger path: the supported entry point under test calls the audio
   manager with the expected event key / track id.
2. Resolution: the manager resolves that key to the expected stream
   resource, on the expected bus.
3. Playback state: after the trigger, the responsible player's `playing`
   is true and its `stream` is the expected resource. For BGM, the
   manager's current-track state equals the expected track.
4. Stop and switch: after a stop or a track change, the state flips
   accordingly (`playing` false, or the current track replaced).

These four are observable in a headless run and are the actual contract
an audio acceptance criterion can demand.

## When a criterion demands real audibility

If an acceptance criterion literally requires measured loudness or a
human-audible result, it is not testable under the Dummy driver. Say so
in the result as an environment limitation, judge the remaining criteria
on state evidence, and stop. Do not keep exploring engine internals to
satisfy it.

## Discipline

- Time-box measurement ideas: at most two probe scripts for any single
  measurement approach; if neither produces a signal, fall back to the
  state assertions above.
- Run headless tests with an explicit `--audio-driver Dummy`, an
  isolated `XDG_DATA_HOME` per run, and fixed timeouts.
