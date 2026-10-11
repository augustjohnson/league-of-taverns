# Images

Every character gets a pixel-art lineup portrait, and every mission gets a
wide pixel-art cover. They are chrome, so they never affect play. The style
aims for an NFL "starting lineup" intro in 16-bit sports-game pixel art: one
framing, one outline, one palette, so 64 separately generated characters read
as one set.

| Image | Size | Committed at | Subject comes from |
|---|---|---|---|
| Portrait | by creature size (below), transparent background | `characters/<id>/portrait.png` | `chrome.portrait.prompt` in `character.yaml` |
| Mission cover | 216×72 (3:1) | `seasons/<s>/chrome/<mission>.cover.png` | `imagePrompts.cover` in the mission's chrome |

The UI scales them up with `image-rendering: pixelated` and puts the tavern's
colours behind portraits, so a character's portrait doesn't change when they
change taverns.

Portrait canvases follow the base's Open5e creature size, at the same pixel
scale, so a Large creature's card is literally bigger than a Small one's.
Cards line up on their bottom edge, so big creatures stand taller in a lineup.
`draft-images` looks the size up in the newest pinned snapshot (or
`--snapshot <id>`); `validate` checks it against the season's snapshot.

| Size | Canvas | Render |
|---|---|---|
| Tiny | 80×104 | 640×832 |
| Small | 96×120 | 768×960 |
| Medium | 112×144 | 896×1152 |
| Large | 128×160 | 1024×1280 |
| Huge | 144×184 | 1152×1472 |
| Gargantuan | 160×200 | 1280×1600 |

## How an image is made

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
season: it must exist, be exactly the style's size, use only palette colours
with no partial transparency, and be under 32 KB.

## Writing subjects

**Portraits:** who, what makes them recognisable, what they wear, and their
expression. No style words, framing or background; the style adds those.

```yaml
prompt: >-
  a hulking good-natured ogre with green skin, small tusks and a heavy brow,
  (friendly lopsided grin:1.3), wearing a white linen shirt under a
  too-small brown leather tavern apron
```

- Name the skin or body colour. "Ogre" alone came out human-skinned in 3 of 4.
- Weight the expression, as in `(… grin:1.3)`. The model scowls by default.
- Use creature words SDXL knows. "Pseudodragon" came out as a man in a
  leather jacket; "tiny red dragon" doesn't. Non-humanoid framing is still
  open (the style asks for head and shoulders).
- One or two props at most. They have to read at 112×144.

**Covers:** the place only: landmarks, weather, time of day, sky. No people
or creatures, since the party changes weekly and the cover shouldn't spoil an
encounter.

## Why the settings are what they are

| Setting | Why |
|---|---|
| LoRA strength 0.7 | At 1.0 every subject becomes a full-body game sprite whatever the prompt says. |
| Weighted framing, `(full body:1.5)` in the negative | The only way to get head-and-shoulders out of this LoRA. |
| "thick dark outline" + BiRefNet cutout | BiRefNet alone erases a white shirt on a white background: there is no edge to find. The outline gives it one. A magenta background was tried and rejected: SDXL ignored it and painted magenta onto lips and eyelids. |
| 12 colour groups, chroma weight 3 | More groups split one material (a leather strap) across two palette hues, which reads as speckle. Chroma weight 3 keeps hue over lightness when snapping. |
| Renders are output × 8, multiples of 64 | SDXL needs multiples of 64. Medium (896×1152) and covers (1728×576, exactly 3:1) are SDXL training sizes; Huge (1152×1472) is past them but held up in testing. |
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
