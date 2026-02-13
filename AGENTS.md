# AGENTS.md

## Repo Identity
- Local path: `/Users/v/t/dev/canon/codex`
- GitHub repo: `https://github.com/VictorTaelin/canon`
- GitHub Pages URL: `https://victortaelin.github.io/canon/`
- Default branch: `main`
- Current app name in UI/title: `canon_in_ghost`

## Purpose
This repo contains a single-page HTML5/Web Audio app that plays Johann Pachelbel's Canon in D as a 3-violin canon (entries staggered by 2 bars) with:
- Theremin-like synth timbre
- FL/Fruity-Loops-style piano-roll visualization
- Auto-follow scrolling under a fixed centered playhead
- Solarized Light, terminal-like visual theme

## Runtime Behavior (Current)
### Controls (top bar)
- `▶ / ⏸` icon-only play/pause button
- Tempo slider (40..100 BPM)
- Status text: elapsed/total time only (`MM:SS / MM:SS`)

### Keyboard shortcuts
- `Space`: play/pause toggle

### Playback
- Loop is always enabled (`state.loop = true`)
- Scheduler lookahead: `0.5s`, interval: `20ms`
- Playback restarts seamlessly at end of score

### Piano roll
- Red playhead is fixed and centered over the scrollable sheet viewport
- Sheet scrolls horizontally to keep current beat centered
- Left note rail (e.g. `C6`) is fixed horizontally and scroll-synced vertically
- Note rail labels are rendered in bold and centered per row

## Canon Data Model
`score-data.js` defines `SCORE_DATA`:
- `title`: `Canon in D (Three Violins Canon)`
- `composer`: `Johann Pachelbel`
- `tempo`: `55`
- `timeSignature`: `[4,4]`
- `totalBeats`: `217`
- `midiRange`: `[55,86]`
- `notes`: array of `[startBeat, durationBeat, midiNote, voiceId]`

Current stats:
- Total notes: `1731`
- Voices: `1,2,3`
- Voice counts: `593`, `577`, `561`
- Voice entries start at beats: `0`, `8`, `16`
- Canon offset: exactly `+8` beats (2 bars in 4/4)

## Source Provenance and References
Primary score/data references used during development:
- IMSLP Canon & Gigue page:
  - `https://imslp.org/wiki/Canon_and_Gigue_in_D_major%2C_P.37_(Pachelbel%2C_Johann)`
- Mutopia piece (3 violins + basso):
  - `https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=2047`
- Mutopia MIDI zip (used as canonical machine source for current note extraction):
  - `https://www.mutopiaproject.org/ftp/PachelbelJ/Canon_per_3_Violini_e_Basso/Canon_per_3_Violini_e_Basso-mids.zip`
Original user-provided timbre reference:
- YouTube (ghost/theremin-like target timbre):
  - `https://www.youtube.com/watch?v=kXF3VYYa5TI`

Additional reference files fetched during development:
- Mutopia solo Canon .ly and .mid:
  - `https://www.ibiblio.org/mutopia/ftp/PachelbelJ/CanonInD/CanonInD.ly`
  - `https://www.ibiblio.org/mutopia/ftp/PachelbelJ/CanonInD/CanonInD.mid`
- Earlier MusicXML source used in initial prototype:
  - `https://musetrainer.github.io/library/scores/Canon_in_D.mxl`
- Solarized references:
  - `https://raw.githubusercontent.com/altercation/solarized/master/iterm2-colors-solarized/Solarized%20Light.itermcolors`
  - `https://raw.githubusercontent.com/altercation/vim-colors-solarized/master/README.mkd`

## What Was Discussed and Implemented
Chronological summary of the core collaboration decisions:
1. Build a browser app to play Canon in D with theremin-like timbre and piano roll.
2. Include transport controls and visual sheet/piano-roll.
3. Use a timbre inspired by the user-provided YouTube reference (`kXF3VYYa5TI`) and later align synth approach with the preferred comparison implementation.
4. Make layout full-window and auto-follow the playhead.
5. Reduce vertical UI footprint to a thin top bar.
6. Keep playhead centered and scroll the sheet beneath it.
7. Use a true 3-voice canon offset by 2 bars.
8. Restyle to Solarized Light terminal/Vim-like look.
9. Remove unnecessary controls:
   - Removed Stop
   - Removed loop toggle (loop always on)
   - Removed extra sound knobs (vibrato/volume)
   - Removed position scrub control from visible UI
10. Keep time display; later removed `Bar X, Beat Y` text.
11. Make play/pause icon-only and add `Space` shortcut.
12. Fix fixed left note rail behavior and alignment.
13. Improve visual quality:
   - pastel note colors
   - reduced black/white row contrast
   - smaller note rail
   - crisp HiDPI canvas rendering
   - centered/bold note labels
14. Initialize git repo, create GitHub repo, push, and enable GitHub Pages.

## Current Architecture
### Frontend files
- `index.html`: App markup only (header controls + roll frame + canvases)
- `styles.css`: Solarized terminal-like theme, layout, fixed left rail styles
- `app.js`: All runtime logic:
  - transport
  - audio synthesis and scheduling
  - roll drawing and scroll following
  - keyboard shortcut handling

### Data files
- `score-data.js`: generated canonical note dataset used for both audio and visuals

### Audio design (`app.js`)
- Web Audio graph:
  - voice osc mix: `sine + detuned sine + octave triangle`
  - vibrato/tremolo LFO
  - lowpass shaping
  - master + convolution reverb
  - dynamics compressor
- Note scheduling:
  - beat-to-time conversion based on current tempo
  - lookahead scheduler with catch-up logic

### Visualization design (`app.js` + `styles.css`)
- Two canvases:
  - `rollCanvas` (scrolling note grid)
  - `labelsCanvas` (fixed horizontal note rail)
- Centered fixed playhead overlay
- HiDPI-aware canvas scaling (`devicePixelRatio`)

## File Inventory
- `AGENTS.md`: this file (project handbook/context)
- `app.js`: main app logic (audio, draw, input)
- `index.html`: app structure
- `styles.css`: visual theme and layout
- `score-data.js`: canonical note events

Reference/source artifacts kept in repo:
- `canon_2047_mids.zip`: Mutopia 3-violin MIDI zip
- `canon_2047_mids/`: extracted MIDI files
- `mutopia_CanonInD.ly`: solo Canon LilyPond file
- `mutopia_CanonInD.mid`: solo Canon MIDI file
- `canon_in_d.mxl`: earlier MusicXML source used in initial extraction
- `canon_imslp.html`: saved IMSLP HTML copy
- `SolarizedLight.itermcolors`: Solarized Light palette reference
- `solarized_readme.txt`: Solarized README reference

## Git and Deployment State
### Commit history highlights
- `2f12d7f`: initial app commit
- `0e96ff1`: major terminal UI + labels rail refinements
- `962c565`: keyboard toggle + rail polish
- `7686e71`: terminal-style tempo slider
- `c8cbfdf`: status text simplified
- `9f20a59`: note label centering improvements

### Deployment
- GitHub Pages configured from `main` branch, root path `/`
- Site URL: `https://victortaelin.github.io/canon/`
- Push to `main` triggers Pages rebuild

## Dev Workflow Quick Commands
Run local server:
```bash
python3 -m http.server 8000
```
Open:
```text
http://localhost:8000
```

Push flow:
```bash
git add .
git commit -m "..."
git push
```

Check Pages build:
```bash
gh api 'repos/VictorTaelin/canon/pages/builds?per_page=1'
```

## Notes for Future Agents
- Treat `score-data.js` as source-of-truth runtime score data.
- If regenerating score data, preserve 3-voice offset requirement (`0/+8/+16` beats).
- Keep UI minimal unless explicitly requested otherwise.
- Keep playhead fixed centered; scroll sheet instead.
- Keep note rail fixed horizontally and vertically aligned with roll rows.
- Confirm high-DPI rendering after canvas changes.
- If style changes are requested, keep Solarized Light + terminal feel as baseline.
