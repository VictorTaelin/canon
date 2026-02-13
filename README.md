# canon_in_ghost

`canon_in_ghost` is a browser-based HTML5/Web Audio instrument that performs **Johann Pachelbel’s Canon in D** as a 4-part canon (3 upper voices + basso continuo) with a ghostly, theremin-like timbre and a continuously scrolling piano-roll score.

The app is intentionally minimal on UI and maximal on feel:
- thin terminal-style top bar
- full-height piano roll
- fixed centered playhead
- auto-following sheet
- looped playback
- “ghost choir” synth design tuned for a warm, haunting aesthetic

Live site (GitHub Pages):  
`https://victortaelin.github.io/canon_in_ghost/`

Repository:  
`https://github.com/VictorTaelin/canon_in_ghost`

## Why this project exists

This project was built to present Canon in D in a modern, shareable, visual + sonic form:
- faithful canon structure
- expressive synthetic timbre inspired by ghost/theremin references
- immediate “press play and watch” interaction
- no frameworks, no build step, static hosting only

The target timbre reference provided by the user was:
- YouTube: `https://www.youtube.com/watch?v=kXF3VYYa5TI`

## Musical correctness and score source

The score data in `score-data.js` is derived from the Mutopia 3-violin + basso material and represented as event tuples:
- `[startBeat, durationBeat, midiNote, voiceId]`

Current score properties:
- Tempo: **55 BPM** (source tempo from canonical 3-violin+bass MIDI)
- Meter: **4/4**
- Total beats: **225**
- MIDI range: **38..86** (`D2..D6` span represented in roll)
- Voices: **4**
  - `1`: violin I line
  - `2`: violin II line
  - `3`: violin III line
  - `4`: basso continuo

Canon entries:
- bass starts at beat `0`
- violin entries start at beats `8`, `16`, `24`
- upper voices are offset by exactly **2 bars** (8 beats) in 4/4

Primary references used while building/verifying:
- IMSLP: `https://imslp.org/wiki/Canon_and_Gigue_in_D_major%2C_P.37_(Pachelbel%2C_Johann)`
- Mutopia piece page: `https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=2047`
- Mutopia MIDI set: `https://www.mutopiaproject.org/ftp/PachelbelJ/Canon_per_3_Violini_e_Basso/Canon_per_3_Violini_e_Basso-mids.zip`

## Audio engine (Web Audio) overview

All synthesis and scheduling live in `app.js`.

### Voice design

Each voice has an independent timbre profile:
- gain/pan placement
- detune + glide behavior
- oscillator blend (core/layer/shimmer; bass adds optional sub layer)
- vibrato rate/depth/delay
- slow pitch drift
- filter/vowel/air shaping
- per-voice envelope timing and release behavior

Result:
- 3 upper “ghost” voices read as separate characters
- bass remains ghost-like but deeper and grounded

### Musicality shaping

To reduce robotic playback and improve musical feel:
- deterministic micro-variation per note (stable across runs)
- metrical accents (downbeat shaping)
- phrase-level dynamics over longer arcs
- subtle per-note microtiming offsets
- dynamic filter brightness tied to note energy

### Effects/mix chain

The master chain includes:
- dry bus
- predelayed convolution hall reverb
- light stereo chorus
- subtle filtered echo
- output tone shaping
- glue compression + limiter

This is tuned for smoothness and “ethereal choir” texture while avoiding clicks/pops.

## Visual/interaction design

### Layout goals

The interface is full-viewport and constrained to browser width/height:
- top bar: title + play/pause + tempo + time
- piano roll fills remaining height
- no oversized control panel

### Piano roll behavior

- fixed centered red playhead
- scrolling sheet moves under playhead
- horizontal auto-follow during playback
- left note rail remains fixed (does not scroll horizontally)
- note labels are bold and centered per row
- note rail and sheet lines stay aligned

### Keyboard and controls

- `Space`: play/pause toggle
- Play/Pause button uses unicode icon only (`▶` / `⏸`)
- Loop is always enabled

## Color/theme

The theme is based on **Solarized Light** (iTerm2/Vim references), adapted for:
- terminal-like top bar
- pastel note blocks by voice
- low-contrast white/black key lane differentiation

Reference assets kept in repo:
- `SolarizedLight.itermcolors`
- `solarized_readme.txt`

## File map

Core runtime:
- `index.html` - static app shell and control markup
- `styles.css` - layout + terminal/Solarized styling
- `app.js` - transport, scheduler, synthesis, rendering, scrolling logic
- `score-data.js` - canonical note event data used by both audio + drawing

Project context and references:
- `AGENTS.md` - project handbook/history/context
- `claude.md` - symlink to `AGENTS.md`

Musical/source artifacts (kept for provenance):
- `canon_2047_mids/` - extracted Mutopia MIDI parts
- `canon_2047_mids.zip` - Mutopia MIDI zip
- `mutopia_CanonInD.ly`, `mutopia_CanonInD.mid` - additional reference files
- `canon_in_d.mxl`, `canon_imslp.html` - earlier/research artifacts

Assets:
- `favicon.ico`

## Running locally

No build tooling required.

```bash
python3 -m http.server 8000
```

Open:

`http://localhost:8000`

## Deployment (GitHub Pages)

The repo is configured for GitHub Pages from:
- branch: `main`
- folder: `/` (root)

Push to `main` triggers Pages rebuild.

## Practical tuning guide

If you want to tweak the sound quickly:

1. Per-voice character:
   edit `VOICE_TIMBRES` in `app.js`
2. Ensemble space:
   edit reverb/chorus/echo values in `ensureAudio()` in `app.js`
3. Human feel:
   adjust `noteDynamics()`, microtiming, and envelope math in `scheduleNote()` in `app.js`
4. Global loudness:
   adjust `state.volume` or master/output bus gains in `ensureAudio()`

## Notes

- This project is intentionally static and framework-free.
- Browsers require a user gesture before audio starts; first play click/space satisfies this.
- Sound can vary slightly across browsers due to Web Audio implementation differences.
