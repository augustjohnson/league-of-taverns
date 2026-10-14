# Images

Every character gets a lineup portrait, and every mission gets a wide cover.
They are chrome, so they never affect play. The style aims for an NFL
"starting lineup" intro: the cast stands behind a tavern bar, at their true
heights, in one shared look, so 64 separately generated characters read as
one set.

| Image | Committed at | Subject comes from |
|---|---|---|
| Portrait | `characters/<id>/portrait.png` | `chrome.portrait.prompt` in `character.yaml` |
| Mission cover | `seasons/<s>/chrome/<mission>.cover.png` | `imagePrompts.cover` in the mission's chrome |

## Modes

`content/images/style.yaml` has a `mode`, and every image is made and checked
for it:

| | painted (current) | pixel |
|---|---|---|
| Stored | the painted original: whole figure, trimmed, full resolution and colour | a finished 16-bit sprite on the league palette |
| Model | SDXL base | SDXL base + pixel-art LoRA |
| Fitting the stage | scaled to the character's height when shown | baked into a card sized by creature size and height |
| Pixel art | cut from the original when shown, at any zoom (post-processing) | is the stored image |
| Typical file | ~0.9 MB portrait (cap 1.5 MB), ~1.4 MB cover (cap 2 MB) | 2–3 KB (cap 32 KB) |

Painted became the mode on 2026-10-11. Side by side, the model followed
subjects much better without the LoRA (species, framing, one figure). The
pixel look stays: it is now post-processing of the painted original, so one
image makes pixel art at several zooms and colour budgets, or none. Pixel
mode stays for comparison; the rest of this page says which mode a section
is about.

## Painted mode

```
subject text ──▶ style.yaml `painted` wraps it ──▶ ComfyUI renders (SDXL, no LoRA)
     ──▶ BiRefNet cuts out the figure ──▶ checks: one whole figure, in colour
     ──▶ trimmed, full resolution ──▶ .image-drafts/ (+ pixel views) ──▶ GM accepts one
```

- **Whole figures.** Every portrait asks for the whole figure: standing
  upright for humanoids and plants, the whole creature for the rest. The
  stage scales the figure to the character's height, which only works if
  head and feet are both in the picture. Tiny creatures are drawn whole too
  (no tankard): the stage stands them on the bar.
- **Canvas by pose.** Upright figures render at 832×1216, Huge beasts at
  1216×832, everything else at 1024×1024.
- **Drift.** The Warcraft cue pulls faces toward a green orc. The negative
  prompt pushes that back unless the subject says orc, goblin or green skin.
- **Checks** (`scripts/src/lib/images/paint.ts`), on the cut-out render
  before it is trimmed: nothing on any edge (a cut-off figure can't be
  scaled to height), the figure spans at least 40% of the canvas height, one
  figure (the largest shape holds 80% of the cutout), and not greyscale
  (mean colour at least 0.015, lower than pixel mode's 0.025: painted shading
  is softer, and a grey-skinned golem in olive trousers measures 0.025).
- **Translucency** works as in pixel mode: pale, washed-out parts become
  see-through, at most alpha 112.
- **Covers** render at 1728×576 and are stored as rendered, opaque.
- **Storage** stays plain git (D-10): the originals are full-colour PNGs,
  with each row filtered for the best compression, under `validate`'s caps.

### Post-processing

Everything lossy happens when an image is shown, never in the stored
original (`scripts/src/lib/images/postprocess.ts`). A pixel view scales the
figure to a height in art pixels and runs the pixel pipeline on it: one
colour per art pixel, a colour budget, hard edges with no anti-aliasing,
and a 1-pixel outline in the darkest colour. The style names its views
(`painted.views`):

| View | Zoom | Colours |
|---|---|---|
| `pixel` | 28 art px per foot | the league palette (Resurrect 64) |
| `pixel-fine` | 56 art px per foot | 32 of the image's own |

The zoom applies to the figure as the stage draws it, so a 9.5 ft ogre is
266 art pixels tall in `pixel` and a 4.3 ft dwarf 120. Staging writes each
view beside a painted candidate (`s<seed>.pixel.png`), and the review page
shows them under the stage. Add a view to the style to try another look; no
image needs redrawing.

### On the stage

`scripts/src/lib/images/stage.ts` places a portrait from its creature size
and `chrome.height` (feet). The frame shows 6.5 ft above a 3.5 ft bar:

- **Floor.** Everyone stands on the floor behind the bar, drawn at their
  height, so heads land where they belong. A 9.5 ft ogre towers over a
  4.3 ft dwarf.
- **Stool.** Short folk show at least 1.75 ft above the bar, but always keep
  half a foot hidden behind it.
- **On the bar.** Tiny creatures, and anything 2.5 ft or shorter, stand on the
  bar, drawn at least 0.8 ft tall so a four-inch pixie still reads.
- **Looming.** Huge creatures, and anything over 10 ft, loom in from the left
  with the head at the top of the frame, drawn at most twice the frame's
  height (13 ft).

The review page shows each painted candidate this way, on a slice of the stage
at 32 px per foot.

## Pixel mode

Everything under this heading is about pixel mode.

Portrait canvases follow the base's Open5e creature size, at the same pixel
scale, so a Large creature's card is literally bigger than a Small one's.
Cards line up on their bottom edge, so big creatures stand taller in a lineup.
`draft-images` looks the size up in the newest pinned snapshot (or
`--snapshot <id>`); `validate` checks it against the season's snapshot. The
UI scales them up with `image-rendering: pixelated`.

| Size | Canvas | Render |
|---|---|---|
| Tiny | 40×52 (cell 16) | 640×832 |
| Small | 96×120 | 768×960 |
| Medium | 112×144 | 896×1152 |
| Large | 128×160 | 1024×1280 |
| Huge | 144×184 | 1152×1472 |
| Gargantuan | 160×200 | 1280×1600 |

### Heights

Each character has `chrome.height` in feet: standing height for people,
head height at the bar for animals, the top of a shape for objects. The
stage (`content/images/style.yaml` `stage`) puts a 3.5 ft bar in front of
everyone and draws 28 art pixels per foot at the bar, so a character shows
(height − 3.5 ft) above it. Short characters stand on an unseen stool and
show at least 1.75 ft; very tall ones are capped at 6 ft. A Small to Large
character's canvas is sized from that (plus the 20 rows behind the bar and
8 rows of headroom), and the top of the head is pinned 8 rows down, so a
9.5 ft ogre towers over a 4.3 ft dwarf. Humanoid framing follows how much of
the body is in the card. Tiny creatures stand on the bar on a coarser grid
(cell 16, a 40×52 card), so they come out about 2 ft tall with pixels the
cast's size; Huge creatures keep entering from the top left.

Every portrait also gets a 1-pixel outline in the palette's darkest colour,
so line art matches across the cast.

### Layering over the tavern

Portraits are made to stand side by side behind the bar in a tavern scene:

- **The bar hides the bottom.** The scene draws a counter across the bottom
  `counter` rows (20) of every card. Every figure is dropped onto the bottom
  edge, so however a bust or a pair of legs ends, it ends behind the bar.
- **No clipping.** Only the bottom edge may cut a figure. Huge and
  Gargantuan canvases may also bleed off the top and left (a T-rex entering
  the frame); put those at the left end of a lineup.
- **No floating.** At the counter line the figure must be solid across half
  its width (`minFooting`), so a head on a thin neck fails. Tiny creatures
  perch on a flagon that stands **on** the bar: their cards have no hidden
  rows (`counter: 0`) and sit on the bar's top edge, with a lower threshold
  because the flagon's base is narrow.

The same pass rejects three ways a candidate goes wrong: a sprite sheet of
copies (the largest shape holds under 80% of the sprite), greyscale ink
drawings (mean chroma under 0.025; grey-skinned characters with coloured
accents measure 0.03 and up), and, for humanoids, full-body poses (the
figure fills under 35% of the card above the bar).

`draft-images` checks every candidate (`scripts/src/lib/images/framing.ts`),
the review page marks failures and draws the bar over each card, `accept`
refuses failures without `--force`, and `validate` checks committed
portraits. Proportions, such as a big head on a small body, are left to the
GM's eye. Expect 2 or 3 of 4 candidates to pass for most sizes, fewer for Huge.

### Translucency

A character with `chrome.portrait.translucent: true` (Wendell, a gelatinous
cube clear as ice) gets glass: inside the cutout, cells close to the render's
own background colour, or pale and washed out, are the background showing
through. They keep their palette colour at the style's `glass.alpha` opacity
(112 of 255), so the tavern shows through the cube while its outline and
whatever is frozen inside stay solid. `validate` allows that one opacity, and
only on translucent characters. Translucent creatures still stand behind the
bar like everyone else; their base is hidden by the counter.

### Lighting

Portraits are shared by every tavern a character plays for, so tavern
lighting is never baked in. Every portrait renders with the same soft, even
light from the upper left; the negative prompt pushes away from coloured
light and dramatic shadows. Each tavern's mood is applied when a lineup is
composed: a palette remap that darkens by the tavern's ambient level and
pulls colours toward its light colour, then snaps back to the palette, so
sprites stay crisp. A candlelit winery, a dusk beer garden and a torchlit
dungeon are three settings of the same remap.

### Proportions

The prompt asks for waist-up framing, realistic adult proportions and broad
shoulders, and the negative prompt rejects oversized heads, chibi and
bobblehead styles. That made big heads rare in testing (none in 8 seeds of
the worst case), but no automatic check catches them reliably: silhouettes
can't tell a big head from narrow clothing. The GM's review is the guarantee.

### How a pixel image is made

```
subject text ──▶ content/images/style.yaml wraps it ──▶ ComfyUI renders (SDXL + pixel-art LoRA)
     ──▶ BiRefNet cuts out the subject (portraits) ──▶ pixelate: ÷8 grid, palette, frame
     ──▶ .image-drafts/ candidates ──▶ GM accepts one ──▶ committed PNG ──▶ validate checks it
```

- **Prompts:** per-image text is the subject only. `content/images/style.yaml`
  adds everything else: framing, outline, background, negative prompt, model
  settings and sizes. That file is the style. Change it by PR, and expect to
  regenerate the set.
- **Pixelate** (`scripts/src/lib/images/pixelate.ts`): the LoRA paints on
  SDXL's 8-pixel latent grid, so each art pixel is an exact 8×8 block. Each
  block becomes its most common colour. Colours are grouped (k-means, 12
  groups) and each group snaps to the nearest palette colour in OKLab, so one
  material doesn't split across two palette hues. Isolated pixels are
  cleaned up, and portraits are re-anchored bottom-centre.
- **Palette:** [Resurrect 64](https://lospec.com/palette-list/resurrect-64) by
  Kerrie Lake. It has few muted mid-tones, so browns lean red and greens lean
  olive. That's the price of a shared palette.

## Card faces

The playground's character cards show a face, not the whole figure: a window
cut from the painted portrait at the card art's aspect (148 × 104), made at
build time (`scripts/src/lib/images/face.ts`, `sims/src/playground-build.ts`).
By default the window is head and shoulders: 45% of the figure's width,
centred on the top band of the figure (where the head is, however the body
leans) and starting just above it. That suits people and most monsters.
Where it misses (a rhino's face is low and to one side, a dragon's sits off to
the right, a wisp's is mid-glow), the character sets `chrome.portrait.face`:
`{ x, y, width }` as fractions of the portrait, so it survives a re-render at
another size. Check a new portrait's crop on its card before accepting it.

## Making images

Start ComfyUI (see Setup), then from the repo root:

```bash
pnpm draft-images portraits --character bruno-the-bruiser
pnpm draft-images portraits --all                  # every portrait at status prompt or draft
pnpm draft-images covers --season season-01        # every mission chrome with imagePrompts.cover
```

Each target gets 4 candidates (`--candidates N`) on consecutive seeds. Seeds
start from a stable per-target number, so re-running gives the same images;
pass `--seed <n>` for new ones. Candidates go to `.image-drafts/`
(git-ignored). Open `.image-drafts/index.html` to compare them on a tavern
colour (the picker at the top changes it), then run the accept command printed
under the one you want:

```bash
pnpm draft-images accept --character bruno-the-bruiser --seed 412608729
pnpm draft-images accept --season season-01 --mission example-drowned-toll --seed 574353046
```

Accepting a portrait copies it to `characters/<id>/portrait.png` and sets
`portrait.status: draft`, `path` and `seed` in `character.yaml`, keeping the
file's comments. Review it in the PR and set `status: final`.

`validate` checks every pooled character's portrait and every cover in the
season against the mode. Painted: a portrait trimmed to one figure, in
colour, under 1.5 MB, or an opaque 1728×576 cover under 2 MB. Pixel:
exactly the style's size, palette colours only, no partial transparency,
under 32 KB.

## Importing outside images

When the local model can't get a character right, generate it elsewhere
(Gemini, a drawing) and import it:

```bash
pnpm draft-images import --character rhaa-baeh-skraa the-committee-gemini.png
```

ComfyUI cuts out the background, then the image goes through the same steps
as a render. Painted: checked and trimmed as it is, so ask for the whole
figure, standing, on plain white. Pixel: the figure is scaled to fit the
character's canvas (4 art pixels clear on each side, 8 above) and placed
bottom-centre, then pixelated and checked. Accepting it
records `imported: <file name>` instead of a seed. Ask for a composition
the shape of the card: portrait, about 4:5, plain white background. JPEG and WebP work too. A wide
image fits by width and ends up small, mostly hidden by the bar.

## Writing subjects

**Portraits:** who, what makes them recognisable, what they wear, and their
expression. No style words, framing or background; the style adds those.

```yaml
prompt: >-
  a hulking good-natured ogre with green skin, small tusks and a heavy brow,
  (friendly lopsided grin:1.3), wearing a white linen shirt under a
  too-small brown leather tavern apron
```

- No suits, ties or blazers: the negative prompt already pushes against
  them, and "man" alone drifts into office wear.
- Name the skin or body colour. "Ogre" alone came out human-skinned in 3 of 4.
- Weight the expression, as in `(… grin:1.3)`. The model scowls by default.
- Weight the species, not just the creature: the beast plan's generic
  "animal" turned "huge bear" into a lynx, a dog and a red panda until it
  read "(huge brown grizzly bear:1.4)".
- Use creature words SDXL knows, and weight the creature itself:
  "pseudodragon" came out as a man, then as a white bird;
  "(tiny red dragon with scales:1.4)" is a dragon.
- Set `chrome.portrait.bodyPlan` for anything that isn't a person: humanoid
  (default), beast, winged, blob, swarm, object, plant or multihead. It picks
  the prompt's opening and framing, and every non-humanoid plan pushes away
  from people. Without it, "tavern patron" turned a tiny dragon into a
  dragon-knight. Don't dress small creatures: a leather jerkin pulled Doug
  back toward a person.
- One or two props at most. They have to read at the size they're shown.
- Painted: the subject is weighted 1.35 as a whole. Some shapes don't
  survive it: two- and three-headed creatures (an ettin, a chimera) come out
  as separate figures, and "a man's face frozen inside a cube" draws the man
  holding a cube. Import those (see above).

**Covers:** the place only: landmarks, weather, time of day, sky. No people
or creatures, since the party changes weekly and the cover shouldn't spoil an
encounter.

## Why the settings are what they are

| Setting | Why |
|---|---|
| Painted: no LoRA | The pixel-art LoRA pulled subjects toward full-body game sprites and the wrong species. Without it, SDXL follows the subject. |
| Painted: full-resolution originals | Pixel grids, zooms, colour budgets and hard edges are all post-processing, so one stored image serves every look. 256-colour storage looked the same at a fifth of the size, but colour reduction belongs to the look, not the file. |
| Painted: whole figures, scaled at compose time | Any crop bakes in a guess about the stage. A whole figure can be scaled to height, so an 8 ft ogre and a 4 ft dwarf compare exactly. |
| Painted: "World of Warcraft art style" at 1.1 | At 1.3, and with "concept art", it drew character sheets, logos and green orcs. |
| LoRA strength 0.7 | At 1.0 every subject becomes a full-body game sprite whatever the prompt says. |
| Weighted framing, `(full body:1.5)` in the negative | The only way to get head-and-shoulders out of this LoRA. |
| "thick dark outline" + BiRefNet cutout | BiRefNet alone erases a white shirt on a white background: there is no edge to find. The outline gives it one. A magenta background was tried and rejected: SDXL ignored it and painted magenta onto lips and eyelids. |
| 12 colour groups, chroma weight 3 | More groups split one material (a leather strap) across two palette hues, which reads as speckle. Chroma weight 3 keeps hue over lightness when snapping. |
| Renders are output × 8, multiples of 64 | SDXL needs multiples of 64. Medium (896×1152) and covers (1728×576, exactly 3:1) are SDXL training sizes; Huge (1152×1472) is past them but held up in testing. |
| Eye-level camera, isometric and top-down in the negative | A cube seen from above looked like it floated behind the bar. Every portrait shares one straight-on camera at bar height. |
| Portrait grade (contrast 1.2, saturation 1.2) | Lineups looked washed out against the stages. The grade runs before palette snapping, on portraits only, so the cast stands out from the background. |
| Tiled VAE decode | Decoding a Huge canvas in one piece wants about 6 GB at once; it ran out of memory and crashed. Tile seams vanish in the pixel grid. |

**Known quirks:** some seeds draw the outline in white, and the cutout keeps
it as a light halo, so skip those candidates. Very wide covers sometimes repeat
a landmark; try more seeds rather than rewording.

## Setup

ComfyUI runs locally in its own container. Drafting is offline and
human-triggered, never in CI, like the LLM drafting scripts. The scripts only
talk to ComfyUI's HTTP API (`COMFYUI_URL`, default `http://127.0.0.1:8188`).

The reference setup is a Radeon RX 7800 XT (16 GB, ROCm) on Fedora Atomic
(Bazzite), with a distrobox. NVIDIA works the same with the CUDA wheels.

```bash
distrobox create --name comfyui --image docker.io/library/ubuntu:24.04
distrobox enter comfyui -- sudo apt-get install -y git python3-venv python3-dev build-essential libgl1 libglib2.0-0
git clone https://github.com/comfyanonymous/ComfyUI.git ~/Code/github.com/comfyanonymous/ComfyUI
```

Then inside the box, in that folder, install PyTorch with the index URL from
ComfyUI's README (ROCm 7.2 at the time of writing), then ComfyUI's
requirements:

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/rocm7.2
pip install -r requirements.txt
```

Models, by file name as `content/images/style.yaml` expects them:

| File | Folder under `ComfyUI/models/` | Source (Hugging Face) | sha256 |
|---|---|---|---|
| `sd_xl_base_1.0.safetensors` (6.9 GB) | `checkpoints/` | `stabilityai/stable-diffusion-xl-base-1.0` | `31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b` |
| `pixel-art-xl.safetensors` (170 MB) | `loras/` | `nerijs/pixel-art-xl` | `4234637cb80c998f41e348e6a6cb6bc20d8d038b2b0f256b6129b3b5e353eef7` |
| `birefnet.safetensors` (424 MB) | `background_removal/` | `Comfy-Org/BiRefNet`, file `background_removal/birefnet.safetensors` | `9ab37426bf4de0567af6b5d21b16151357149139362e6e8992021b8ce356a154` |

Check each model card's license before publishing images (see D-33).

Start it with async offloading off:

```bash
python main.py --listen 127.0.0.1 --port 8188 --disable-async-offload
```

On the RX 7800 XT, async weight offloading crashed the second image of a
batch with `Memory access fault by GPU`. Don't add `--highvram`: keeping SDXL,
its text encoders and BiRefNet all resident left BiRefNet out of memory. A
render takes 8–26 s at 28 steps, Tiny to Huge.
