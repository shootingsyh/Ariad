---
name: godot-tilemap-production
description: How to produce tile-based game maps that read as real places - semantic layout first, seamless terrain bases, complete autotile transition sets (Wang-16 / dual-grid, blob-47), and grounded, grouped elements. Use when creating or regenerating tilesets or maps, or when planning map-production work.
---

# Producing tilemaps that read as places

Work in this order. Skipping ahead is how maps end up as scattered
tiles with broken water, half walls, and copy-pasted trees.

## 1. Semantic layout before any art

Sketch the place as a place: where the water comes from and where it
flows, what the road connects, what the walls enclose, which zones the
story needs (entrance, chokepoint, clearing, ruin). Every terrain
feature and element on the final map must trace back to this sketch.
Elements placed without a reason read as noise no matter how good the
tiles are.

## 2. One style frame, then extract

Produce one whole image at map scale to fix palette, lighting, and
style, then extract terrain bases and element art from it
(paint-then-pack). Maps assembled from unrelated stock tiles never
cohere. The style frame guarantees coherence; the steps below make it
tileable.

## 3. Seamless bases

- Base textures (grass, dirt, stone floor) must be low-contrast with no
  focal features - anything memorable repeats visibly.
- Prove seamlessness before use: offset the texture by half and check
  the cross seam (image-tool seam healing: roll, repaint the seam at
  moderate denoise), then preview a 3x3 tiling.
- Ship 2-4 variants per base and mix them; a single tiling texture
  always reads as a texture, not a ground.

## 4. Complete transition sets - never hand-place edges

Incomplete water, walls, and terrain edges come from missing
transition tiles, not from careless placement. Draw transitions as
complete sets:

- Soft terrain pairs (grass/dirt, dirt/sand, shallow water/bank):
  Wang-16, or dual-grid with 15-16 tiles per pair.
- Hard structures (cliffs, walls, water with defined banks): blob-47.
  Generate the full 47 from a 3x3 island template or the quadrant
  method - do not draw edge pieces one at a time.
- In Godot, register the set as a TileSet terrain (Match Corners for
  dual-grid style sets, Match Corners and Sides for blob style) with
  peering bits derived from the set itself, and paint with the terrain
  tool. Per-map manual edge fixing does not scale and always misses
  cases.

## 5. Elements: grouped, grounded, varied

- Place vegetation, props, and structures in semantic groups (a grove,
  a ruined wall line, a farm plot), not uniform scatter.
- Every placed element and every unit standing on terrain gets a
  contact shadow at its foot; feet align to the ground line. Floating
  elements are the fastest way to make a map look pasted together.
- Vary size, flip, and variant within a group; identical repeated
  sprites read as copy-paste even when the tile work is correct.

## 6. Density and verification

- A finished map has no large empty single-texture areas.
- Judge the result on rendered frames at real gameplay camera
  positions (see the visual-evidence-capture skill), never on the
  editor's full-map view: tiling repetition, seams, and floating
  elements are only visible at game scale.

Anti-patterns, all review failures: single-texture tiling, missing
transition sets, recolored reuse of one map for a different story
place, elements without contact shadows, decoration placed before the
layout exists.
