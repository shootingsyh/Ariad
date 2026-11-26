---
name: godot-audio-testing
description: How to test Godot 4 game audio (BGM, SFX, voice) - component level by player state plus a recorded-output comparison, E2E by capturing the running process's audio on a virtual device and matching it against the expected asset. Use whenever a task writes, runs, or judges tests for audio playback, an audio manager, or audio wiring at game entry points.
---

# Testing Godot audio

Two levels. Component level is the default and is usually sufficient;
E2E adds a live capture when a task explicitly demands it.

## The environment fact that decides everything

Audio can only be recorded or measured where audio is actually
rendered. The `--audio-driver Dummy` driver renders silence by design:
bus peak volumes, spectrum analyzers, and any recording of its output
read silence no matter what is playing. Never measure, record, or read
engine class documentation hunting for a level API under the Dummy
driver - that search has no successful end.

Recording-based checks need a real (virtual) audio device, e.g. a
PulseAudio null sink in the Linux test environment: run the game with
the PulseAudio driver and `PULSE_SINK` set to the virtual sink, and
record from the sink's monitor source. If the environment offers no
such device, do the state checks below and report the recording check
as an environment limitation - do not improvise around the Dummy
driver.

## Component level: the player honours its commands

Judge at the project's own audio boundary (its audio manager /
autoload and the players it owns):

1. Trigger path: the entry point under test calls the audio manager
   with the expected event key / track id.
2. Resolution: the manager resolves the key to the expected stream
   resource, on the expected bus.
3. Playback state: after the trigger, the responsible player's
   `playing` is true and its `stream` is the expected resource. For
   BGM, the manager's current-track state equals the expected track.
4. Stop and switch: after a stop or track change, the state flips
   accordingly.
5. Recorded comparison (when a virtual device exists): trigger ONE
   sound at a time, record the monitor for the sound's duration, and
   compare the recording against the source asset - align by
   cross-correlation, then require a tolerant similarity (envelope /
   spectral correlation clearly above a silence-versus-signal floor).
   The recording is a mixdown, not a bit copy: rough agreement is the
   pass bar, exact equality is not.

Do not make a verdict depend on `get_playback_position()` advancing;
position behaviour under virtual/Dummy drivers is not the contract.

## E2E level: capture the process's own sound

When a journey or release check must prove the shipped game actually
sounds:

1. Run the packaged game in the environment with the virtual audio
   device (above) as its output.
2. During a scene where a known BGM track should be playing, capture
   several seconds from the device monitor.
3. Assert the capture is not silence, and that it matches the expected
   BGM asset with the same tolerant comparison as the component level
   (align by cross-correlation; the capture may include UI/SFX sounds
   on top, so compare against the BGM's envelope/spectrum, not a
   bit-exact waveform).

## Discipline

- Time-box measurement ideas: at most two probe scripts for any single
  measurement approach; if neither produces a signal, fall back to the
  state assertions and say what the environment could not provide.
- Fixed timeouts and an isolated `XDG_DATA_HOME` per run.
