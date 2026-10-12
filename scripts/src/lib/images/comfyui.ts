/**
 * Client for a local ComfyUI server (docs/images.md has the setup).
 *
 * Offline and human-triggered, like the LLM drafting scripts: never in CI.
 * Talks to the HTTP API only, so the server can run in its own container.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { ValidationFailure } from '../main';
import type { BodyPlan } from './body-plans';
import { negativePrompt, positivePrompt, renderSize } from './style';
import type { CreatureSize, ImageKind, ImageStyle } from './style';

export const DEFAULT_COMFYUI_URL = 'http://127.0.0.1:8188';

export interface RenderRequest {
  readonly kind: ImageKind;
  /** Portraits: the creature size, which sets the canvas. */
  readonly size?: CreatureSize;
  /** Portraits: the body plan, which sets anchor, framing and extra negatives. Default humanoid. */
  readonly bodyPlan?: BodyPlan;
  readonly subject: string;
  readonly seed: number;
  /** ComfyUI output filename prefix, e.g. "league-of-taverns/portrait/bruno-the-bruiser-s42". */
  readonly prefix: string;
}

type Graph = Record<string, { readonly class_type: string; readonly inputs: Record<string, unknown> }>;

/** The ComfyUI API-format graph for one render: SDXL + LoRA, then BiRefNet when the kind wants a cutout. */
export function renderGraph(style: ImageStyle, request: RenderRequest): Graph {
  const { model } = style;
  const kind = style[request.kind];
  const render = renderSize(style, request.kind, request.size);
  const graph: Graph = {
    checkpoint: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: model.checkpoint } },
    lora: {
      class_type: 'LoraLoader',
      inputs: {
        lora_name: model.lora,
        strength_model: model.loraStrength,
        strength_clip: model.loraStrength,
        model: ['checkpoint', 0],
        clip: ['checkpoint', 1],
      },
    },
    positive: { class_type: 'CLIPTextEncode', inputs: { text: positivePrompt(style, request.kind, request.subject, request.size, request.bodyPlan), clip: ['lora', 1] } },
    negative: { class_type: 'CLIPTextEncode', inputs: { text: negativePrompt(style, request.kind, request.bodyPlan), clip: ['lora', 1] } },
    latent: { class_type: 'EmptyLatentImage', inputs: { width: render.width, height: render.height, batch_size: 1 } },
    sample: {
      class_type: 'KSampler',
      inputs: {
        seed: request.seed,
        steps: model.steps,
        cfg: model.cfg,
        sampler_name: model.sampler,
        scheduler: model.scheduler,
        denoise: 1,
        model: ['lora', 0],
        positive: ['positive', 0],
        negative: ['negative', 0],
        latent_image: ['latent', 0],
      },
    },
    // Tiled: a whole-image decode of a Huge canvas wants ~6 GB at once, which ran out of memory and then
    // crashed ROCm on a 16 GB card with SDXL resident. Seams vanish when pixelated to the 8-pixel grid.
    decode: {
      class_type: 'VAEDecodeTiled',
      inputs: { samples: ['sample', 0], vae: ['checkpoint', 2], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 },
    },
    save: { class_type: 'SaveImage', inputs: { filename_prefix: request.prefix, images: ['decode', 0] } },
  };
  if (kind.cutout) {
    graph['cutoutModel'] = { class_type: 'LoadBackgroundRemovalModel', inputs: { bg_removal_name: model.backgroundRemoval } };
    graph['foreground'] = { class_type: 'RemoveBackground', inputs: { bg_removal_model: ['cutoutModel', 0], image: ['decode', 0] } };
    // JoinImageWithAlpha treats its mask as "what to hide", so invert the foreground mask first.
    graph['background'] = { class_type: 'InvertMask', inputs: { mask: ['foreground', 0] } };
    graph['rgba'] = { class_type: 'JoinImageWithAlpha', inputs: { image: ['decode', 0], alpha: ['background', 0] } };
    graph['save'] = { class_type: 'SaveImage', inputs: { filename_prefix: request.prefix, images: ['rgba', 0] } };
  }
  return graph;
}

export class ComfyUi {
  constructor(readonly baseUrl: string = process.env['COMFYUI_URL'] ?? DEFAULT_COMFYUI_URL) {}

  /** Fail early, with a pointer to the setup doc, when the server is down or a model file is missing. */
  async checkReady(style: ImageStyle): Promise<void> {
    const needs: ReadonlyArray<readonly [string, string]> = [
      ['checkpoints', style.model.checkpoint],
      ['loras', style.model.lora],
      ...(style.portrait.cutout || style.cover.cutout ? [['background_removal', style.model.backgroundRemoval] as const] : []),
    ];
    const missing: string[] = [];
    for (const [folder, file] of needs) {
      const listed = (await this.json(`/models/${folder}`)) as unknown;
      if (!Array.isArray(listed) || !listed.includes(file)) missing.push(`models/${folder}/${file}`);
    }
    if (missing.length > 0) {
      throw new ValidationFailure(`ComfyUI at ${this.baseUrl} is missing ${missing.join(', ')}. See docs/images.md § Setup.`);
    }
  }

  /**
   * Cut the subject out of an outside image with the style's background
   * removal model; returns an RGBA PNG whose background is transparent.
   */
  async cutout(style: ImageStyle, png: Uint8Array, name: string): Promise<Uint8Array> {
    const form = new FormData();
    form.append('image', new Blob([png], { type: 'image/png' }), name);
    form.append('overwrite', 'true');
    const uploaded = (await (await this.fetch('/upload/image', { method: 'POST', body: form })).json()) as { name?: string; subfolder?: string };
    if (typeof uploaded.name !== 'string') throw new Error(`ComfyUI upload failed: ${JSON.stringify(uploaded)}`);
    const image = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
    const graph: Graph = {
      load: { class_type: 'LoadImage', inputs: { image } },
      cutoutModel: { class_type: 'LoadBackgroundRemovalModel', inputs: { bg_removal_name: style.model.backgroundRemoval } },
      foreground: { class_type: 'RemoveBackground', inputs: { bg_removal_model: ['cutoutModel', 0], image: ['load', 0] } },
      background: { class_type: 'InvertMask', inputs: { mask: ['foreground', 0] } },
      rgba: { class_type: 'JoinImageWithAlpha', inputs: { image: ['load', 0], alpha: ['background', 0] } },
      save: { class_type: 'SaveImage', inputs: { filename_prefix: 'league-of-taverns/import/cutout', images: ['rgba', 0] } },
    };
    const queued = (await this.json('/prompt', { prompt: graph })) as { prompt_id?: string };
    if (typeof queued.prompt_id !== 'string') throw new Error(`ComfyUI rejected the cutout graph: ${JSON.stringify(queued)}`);
    return this.waitForImage(queued.prompt_id);
  }

  /**
   * Queue renders, wait for each, and return its PNG bytes in request order.
   * `onDone` gets each image as soon as it finishes, so a long batch can save
   * as it goes and survive a crash part-way.
   */
  async render(
    style: ImageStyle,
    requests: ReadonlyArray<RenderRequest>,
    onDone?: (request: RenderRequest, png: Uint8Array) => void,
  ): Promise<Uint8Array[]> {
    const ids: string[] = [];
    for (const request of requests) {
      const queued = (await this.json('/prompt', { prompt: renderGraph(style, request) })) as { prompt_id?: string; node_errors?: unknown };
      if (typeof queued.prompt_id !== 'string') throw new Error(`ComfyUI rejected the graph: ${JSON.stringify(queued)}`);
      ids.push(queued.prompt_id);
    }
    const images: Uint8Array[] = [];
    for (const [i, id] of ids.entries()) {
      const png = await this.waitForImage(id);
      images.push(png);
      onDone?.(requests[i]!, png);
    }
    return images;
  }

  private async waitForImage(promptId: string, timeoutMs = 10 * 60_000): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const history = (await this.json(`/history/${promptId}`)) as Record<string, HistoryEntry>;
      const entry = history[promptId];
      if (entry !== undefined) {
        if (entry.status?.status_str !== 'success') {
          throw new Error(`ComfyUI run ${promptId} failed: ${JSON.stringify(entry.status?.messages ?? entry.status)}`);
        }
        const image = Object.values(entry.outputs ?? {}).flatMap((output) => output.images ?? [])[0];
        if (image === undefined) throw new Error(`ComfyUI run ${promptId} produced no image`);
        const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type });
        const response = await this.fetch(`/view?${query}`);
        return new Uint8Array(await response.arrayBuffer());
      }
      await sleep(1000);
    }
    throw new Error(`timed out waiting for ComfyUI run ${promptId}`);
  }

  private async json(path: string, body?: unknown): Promise<unknown> {
    const response = await this.fetch(
      path,
      body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    return response.json();
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.baseUrl), init);
    } catch (error) {
      const reason = error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error);
      throw new ValidationFailure(`Can't reach ComfyUI at ${this.baseUrl} (${reason}). Start it first: docs/images.md § Setup.`);
    }
    if (!response.ok) throw new Error(`ComfyUI ${init?.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`);
    return response;
  }
}

interface HistoryEntry {
  readonly status?: { readonly status_str?: string; readonly messages?: unknown };
  readonly outputs?: Record<string, { readonly images?: ReadonlyArray<{ filename: string; subfolder: string; type: string }> }>;
}
