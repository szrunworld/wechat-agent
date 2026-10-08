// The Recognizer port: profiles, applicability, and recognize() over an
// artifact image file. This module only READS image files; it has no way to
// capture a screen or send input.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Applicability, Id, ImageInput, ImageMeta, LayoutProfile, PageFacts, Recognizer, TextItem } from '@wechat-agent/ports';
import { analyze } from './analyze.ts';
import { createOcrRunner, DEFAULT_OCR_PATH, OcrError, type OcrRunner } from './ocr.ts';
import { decodePng, NO_PIXELS, PixelSampler, PngError, type Sampler } from './png.ts';
import { Geometry, loadProfiles, publicProfile, type WeChatLayoutProfile } from './profile.ts';

export interface RecognizerOptions {
  /** The OCR helper binary (ocr/ocr); built by `npm run build:ocr`. */
  ocrPath?: string;
  /** Replaces the subprocess, for tests. */
  ocr?: OcrRunner;
  /** Profiles to serve; defaults to every JSON in ./profiles. */
  profiles?: WeChatLayoutProfile[];
  /** Called with timings, for the README's performance record. */
  onTiming?: (t: { decodeMs: number; ocrMs: number; analyzeMs: number; totalMs: number }) => void;
}

export type ThemeRead = { theme: 'dark' | 'light' | 'unknown'; luma: number };

/** The capture's theme from the profile's background strips (median of samples; no guessing between the bands). */
export function readTheme(sampler: Sampler, profile: WeChatLayoutProfile): ThemeRead {
  const g = new Geometry(profile);
  const T = profile.layout.theme;
  const lumas = T.samples.map((s) => sampler.meanLuma(g.rect(s))).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (lumas.length === 0) return { theme: 'unknown', luma: NaN };
  const luma = lumas[Math.floor(lumas.length / 2)];
  if (luma <= T.darkMaxLuma) return { theme: 'dark', luma };
  if (luma >= T.lightMinLuma) return { theme: 'light', luma };
  return { theme: 'unknown', luma };
}

export function createRecognizer(options: RecognizerOptions = {}): Recognizer {
  const profiles = options.profiles ?? loadProfiles();
  const ocr = options.ocr ?? createOcrRunner(options.ocrPath ?? DEFAULT_OCR_PATH);
  const byId = new Map(profiles.map((p) => [p.profileId, p]));

  function applicability(image: ImageMeta, preferred?: Id): Applicability {
    const ordered = preferred ? [...profiles].sort((a, b) => Number(b.profileId === preferred) - Number(a.profileId === preferred)) : profiles;
    let reason: Extract<Applicability, { applicable: false }>['reason'] = 'no_profile';
    for (const p of ordered) {
      const g = new Geometry(p);
      const tolerance = g.px(p.sizeTolerancePoints);
      const sizeOk = Math.abs(image.width - g.imageWidth) <= tolerance && Math.abs(image.height - g.imageHeight) <= tolerance;
      const frameOk = !image.windowFrame
        || (Math.abs(image.windowFrame.width - p.window.width) <= p.sizeTolerancePoints && Math.abs(image.windowFrame.height - p.window.height) <= p.sizeTolerancePoints);
      if (!sizeOk || !frameOk) { if (reason === 'no_profile') reason = 'size_mismatch'; continue; }
      if (image.scale !== p.scale) { reason = 'scale_mismatch'; continue; }
      // Theme needs pixels, which ImageMeta does not carry: recognize() samples it and reports `unreadable`.
      return { applicable: true, profile: publicProfile(p) };
    }
    return { applicable: false, reason };
  }

  function unreadable(profile: LayoutProfile, image: ImageMeta, warnings: string[], texts: TextItem[] = []): PageFacts {
    return {
      page: 'unknown', coverage: 'unreadable', profileId: profile.profileId, buttons: [], texts, warnings, confidence: 0,
      evidenceRef: { artifactId: image.artifactId, sha256: image.sha256 },
    };
  }

  async function recognize(image: ImageInput, profile: LayoutProfile): Promise<PageFacts> {
    const started = performance.now();
    const full = byId.get(profile.profileId);
    if (!full) return unreadable(profile, image, [`no_profile: ${profile.profileId} is not a profile of this recognizer`]);
    if (full.revision !== profile.revision) return unreadable(profile, image, [`profile revision ${profile.revision} differs from ${full.revision}`]);
    const fit = applicability(image, profile.profileId);
    if (!fit.applicable || fit.profile.profileId !== profile.profileId) {
      return unreadable(profile, image, [`${fit.applicable ? 'size_mismatch' : fit.reason}: capture ${image.width}x${image.height}@${image.scale}x does not fit ${profile.profileId}`]);
    }

    let tempDir: string | undefined;
    let path = image.path;
    const warnings: string[] = [];
    try {
      let bytes: Uint8Array | undefined = image.bytes;
      if (!path) {
        if (!bytes) return unreadable(profile, image, ['image has neither path nor bytes']);
        tempDir = await mkdtemp(join(tmpdir(), 'wechat-agent-recognition-'));
        path = join(tempDir, 'capture.png');
        await writeFile(path, bytes, { mode: 0o600 });
      }
      bytes ??= await readFile(path);

      // Pixels: theme check and colour hints. A non-PNG artifact still gets OCR, without colour.
      const decodeStart = performance.now();
      let sampler: Sampler = NO_PIXELS;
      try {
        const pixels = decodePng(bytes);
        if (pixels.width !== image.width || pixels.height !== image.height) {
          return unreadable(profile, image, [`size_mismatch: file is ${pixels.width}x${pixels.height}, metadata says ${image.width}x${image.height}`]);
        }
        sampler = new PixelSampler(pixels);
        const theme = readTheme(sampler, full);
        if (theme.theme !== full.theme) {
          return unreadable(profile, image, [`theme_mismatch: background luma ${theme.luma.toFixed(0)} reads as ${theme.theme}, profile is ${full.theme}`]);
        }
      } catch (e) {
        if (!(e instanceof PngError)) throw e;
        warnings.push(`no pixel sampling: ${e.message}; theme unverified, colour hints off`);
        return unreadable(profile, image, [...warnings, 'theme_mismatch: theme could not be sampled']);
      }
      const decodeMs = performance.now() - decodeStart;

      const ocrStart = performance.now();
      let texts: TextItem[];
      try {
        texts = await ocr.readText(path);
      } catch (e) {
        if (!(e instanceof OcrError)) throw e;
        return unreadable(profile, image, [...warnings, `ocr_failed: ${e.message}`]);
      }
      const ocrMs = performance.now() - ocrStart;

      const analyzeStart = performance.now();
      const facts = analyze({ texts, sampler, warnings, evidenceRef: { artifactId: image.artifactId, sha256: image.sha256 } }, full);
      const analyzeMs = performance.now() - analyzeStart;
      options.onTiming?.({ decodeMs, ocrMs, analyzeMs, totalMs: performance.now() - started });
      return facts;
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true });
    }
  }

  return {
    profiles: () => profiles.map(publicProfile),
    applicability,
    recognize,
  };
}
