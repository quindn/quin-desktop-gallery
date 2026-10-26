# UI Spec

## Visual language

Dark, glass-layered, Apple Photos/macOS/visionOS-inspired — restraint over
decoration. No copied Apple assets; an original system built from the same
principles (depth via translucency, not gradients; typography and spacing
carrying hierarchy, not borders).

### Tokens (Tailwind theme, dark-first — this app ships dark-only, no light theme per spec §25)

- Background layers (back → front): `#0a0a0c` app canvas → `#111114`
  sidebar/panels → `#1a1a1e` cards/rows → `#232328` hover/active.
- Glass surfaces: `background: rgba(255,255,255,0.04)` with
  `backdrop-filter: blur(20px)` and a 1px `rgba(255,255,255,0.06)` hairline
  border — used for the top toolbar, sidebar, and inspector, never for
  every card (restraint).
- Accent: a single restrained accent (iOS-system-blue-adjacent, e.g.
  `#0A84FF`) used sparingly — selection, primary actions, the scrub
  position — not decoratively.
- Text: primary `rgba(255,255,255,0.92)`, secondary `rgba(255,255,255,0.55)`,
  tertiary `rgba(255,255,255,0.35)` for metadata overlays.
- Radius: 14px cards, 10px controls, 22px sheets/modals — consistently
  large, never mixed with sharp corners.
- Elevation via blur + subtle shadow (`0 8px 30px rgba(0,0,0,0.4)`), not
  borders.
- Motion: 120-180ms, `cubic-bezier(0.4, 0, 0.2, 1)`; hover/press states
  use scale (0.98 on press) not color-flash; view-mode/filter transitions
  crossfade rather than jump-cut.

### Explicitly avoided (spec §25)

Neon/gaming palettes, heavy borders, cheap linear gradients as the primary
surface treatment, oversized touch-style controls, visual clutter — every
panel should read as calm and considered even under a dense grid.

## Layout (spec §26)

```
┌──────────────────────────────────────────────────────────────────┐
│ Top toolbar (glass): Back/Fwd · Search · Type filter · Filter ·   │
│                       Sort · View mode · Thumb size · LAN status  │
├───────────────┬──────────────────────────────────┬───────────────┤
│ Sidebar        │ Gallery (grid/masonry/list/...)   │ Inspector     │
│  - Root        │  virtualized, adapts to view mode │  (collapsible)│
│  - Folder tree │                                    │  Preview     │
│  - Smart       │                                    │  Info/Meta   │
│    Collections │                                    │  Tags        │
│  - Tags        │                                    │  Edit         │
└───────────────┴──────────────────────────────────┴───────────────┘
```

Sidebar and inspector are collapsible; gallery reflows to fill reclaimed
width (masonry/grid recomputes columns, not just stretches).

## Core components (build order tracks ROADMAP phases)

- `TitleBar` — custom-drawn, matches the dark theme (native chrome looks
  wrong against a glass UI).
- `Sidebar` — root label + change/recent, folder tree (virtualized once
  large), smart collections list, tag list; folder search field.
- `Toolbar` — search field with operator hints, type quick-filter chips,
  Filter panel trigger + active-filter pill row, Sort menu, view-mode
  switch, thumbnail-size slider, LAN status pill.
- `GalleryGrid` — virtualized (`@tanstack/react-virtual`), one component
  with per-mode layout strategies (grid/dense/masonry/list/details/
  timeline) rather than five divergent components, so selection/keyboard
  nav/hover-preview logic isn't duplicated per mode.
- `MediaCard` — thumbnail + overlay badges (duration, resolution, size,
  favorite, rating, codec, folder — each independently toggleable),
  hover-video-preview when enabled.
- `Inspector` — tabs: Preview / Info / Metadata / Tags / Edit.
- `Viewer` (Quick Look + full viewer) — photo viewer and video player
  share a modal shell, swap the content component by media type.
- `FilterPanel` — the advanced filter sheet (§9), builds a serializable
  filter-tree consumed identically by the query layer and by
  "Save as Smart Collection."
- `Dashboard` — home screen cards (§24).
- `EditorPanel`, `LANPanel`, `SettingsPanel` — later phases.

## Interaction

- Double-click opens the full viewer; **Space** = Quick Look (lighter-
  weight overlay, closes on release-equivalent second Space/Esc); arrow
  keys navigate prev/next in both Quick Look and the full viewer.
- Selection: click, Ctrl/Cmd+click toggle, Shift+click range, Ctrl+A select
  all within current filtered set.
- Context menu (§27) is one shared component parameterized by
  selection size (single vs. multi actions differ, e.g. Rename is
  single-only).

## Accessibility & responsiveness within a desktop app

- Full keyboard operability (§29), visible focus rings (thin accent
  outline, not a default browser ring), respects Windows text-scaling to a
  reasonable degree. Not a phone-responsive layout — this is a desktop
  window — but panels collapse gracefully down to a minimum practical
  window width rather than clipping.
