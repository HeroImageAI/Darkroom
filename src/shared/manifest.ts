import type { WorkflowSpec } from './workflow.js';

export type Aspect = '1:1' | '4:5' | '3:2' | '16:9' | '9:16';
export const ASPECTS: Aspect[] = ['1:1', '4:5', '3:2', '16:9', '9:16'];

export interface ImageModel {
  label: string;
  tagline: string;
  licence: string;
  t2i: string;
  ref: string;
  maxRefs: number;
  refNote?: string;
  aspects: Record<Aspect, [number, number]>;
  defaults: { steps: number; cfg: number };
  ranges: { steps: [number, number]; cfg: [number, number] };
  /** Optional quality presets (Qwen: Draft / Native 2K; Klein: Standard / High). No steps = the model's own steps setting. */
  quality?: Record<string, { label: string; note: string; steps?: number; aspects: Record<Aspect, [number, number]> }>;
}

export type VideoQuality = 'draft' | 'final' | 'hd';
export type Orientation = 'landscape' | 'portrait' | 'square';

export interface VideoModel {
  label: string;
  tagline: string;
  workflow: string;
  supportsEndFrame: boolean;
  endFrameNote?: string;
  fps: number;
  framesFor: string;
  maxSeconds: number;
  unavailable?: string;
  /** Per tier: sizes, and optionally its own graph (1080p = the two-stage graph) and time growth. A model may lack a tier. */
  quality: Partial<Record<VideoQuality, { label: string; short: string; workflow?: string; timeExponent?: number } & Record<Orientation, [number, number]>>>;
  /** Seconds of compute per second of video, measured (BENCHMARKS.md). */
  secondsPerSecond?: Partial<Record<VideoQuality, number>>;
  /** Fixed overhead (model load, decode) in seconds, measured. */
  overheadSec?: Partial<Record<VideoQuality, number>>;
  /** Time grows like seconds^exponent (attention cost); fitted from measurements. Default 1. */
  timeExponent?: number;
}

export interface Manifest {
  version: number;
  models: Record<string, ImageModel>;
  video: Record<string, VideoModel>;
  workflows: Record<string, WorkflowSpec>;
  /** Edit mode → image model key → workflow name. */
  edit?: Record<string, Record<string, string>>;
}

export function orientationOf(width: number, height: number): Orientation {
  const r = width / height;
  if (r > 1.15) return 'landscape';
  if (r < 0.87) return 'portrait';
  return 'square';
}

/** Frame count for a clip length, respecting the model's frame grid (4n+1 for Wan, 8n+1 for LTX). */
export function framesFor(model: VideoModel, seconds: number): number {
  const s = Math.min(Math.max(seconds, 1), model.maxSeconds);
  const raw = Math.round(model.fps * s);
  const grid = model.workflow.startsWith('ltx') ? 8 : 4;
  return Math.round(raw / grid) * grid + 1;
}

export interface VideoPlan {
  width: number;
  height: number;
  fps: number;
  frames: number;
  seconds: number;
  /** The graph for this tier (1080p has its own two-stage graph). */
  workflow: string;
  estimateSec: number | null;
}

export function planVideo(model: VideoModel, quality: VideoQuality, seconds: number, srcW: number, srcH: number): VideoPlan {
  const tier = model.quality[quality] ?? model.quality.final!;
  const [width, height] = tier[orientationOf(srcW, srcH)];
  const frames = framesFor(model, seconds);
  const realSeconds = (frames - 1) / model.fps;
  const sps = model.secondsPerSecond?.[quality];
  const over = model.overheadSec?.[quality] ?? 0;
  const exp = tier.timeExponent ?? model.timeExponent ?? 1;
  return { width, height, fps: model.fps, frames, seconds: realSeconds, workflow: tier.workflow ?? model.workflow, estimateSec: sps ? Math.round(over + sps * Math.pow(realSeconds, exp)) : null };
}
