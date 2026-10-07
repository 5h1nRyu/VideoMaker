import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ExportConfig, FramePlan } from "./config.ts";
import type { ExportManifest } from "./protocol.ts";
import type { VideoInfo } from "./encoder.ts";
import { frameAt, frameFilename, planFrames } from "./config.ts";
import { bounded, openTarget, prepareTarget } from "./browser.ts";
import { encode, validateFrames } from "./encoder.ts";

export type Stage =
  | "queued"
  | "loading"
  | "preparing"
  | "warming"
  | "rendering"
  | "validating"
  | "encoding"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";
export interface Job {
  id: string;
  createdAt: string;
  updatedAt: string;
  config: ExportConfig;
  stage: Stage;
  completedFrames: number;
  warmedFrames: number;
  encodedFrames: number;
  currentFrame?: number;
  manifest?: ExportManifest;
  plan?: FramePlan;
  video?: VideoInfo;
  error?: { stage: Stage; frame?: number; message: string };
  browserVersion?: string;
}
export async function exportJob(
  job: Job,
  directory: string,
  signal: AbortSignal,
  changed: () => Promise<void>,
) {
  const stage = async (s: Stage) => {
    job.stage = s;
    await changed();
  };
  await stage("loading");
  const target = await openTarget(job.config, signal);
  try {
    job.browserVersion = target.browser.version();
    job.manifest = target.manifest;
    job.plan = planFrames(job.config, target.manifest);
    await stage("preparing");
    await prepareTarget(target.page, job.config, signal);
    target.assertHealthy();
    const framesDir = path.join(directory, "frames");
    await mkdir(framesDir, { recursive: true });
    const firstRenderIndex = target.manifest.supportsSeeking
      ? job.plan.firstIndex
      : 0;
    await stage(job.plan.warmupCount ? "warming" : "rendering");
    for (let index = firstRenderIndex; index < job.plan.endIndex; index++) {
      signal.throwIfAborted();
      job.currentFrame = index;
      if (index === job.plan.firstIndex) await stage("rendering");
      await bounded(
        target.page.evaluate(async (frame) => {
          await window.__VIDEO_EXPORT__!.renderFrame(frame);
        }, frameAt(index)),
        job.config.timeoutMs,
        `renderFrame(${index})`,
        signal,
      );
      target.assertHealthy();
      if (index < job.plan.firstIndex) job.warmedFrames++;
      else {
        await target.page.screenshot({
          path: path.join(framesDir, frameFilename(job.completedFrames)),
          type: "png",
          fullPage: false,
          scale: "device",
          animations: "allow",
          caret: "hide",
          omitBackground: false,
          timeout: job.config.timeoutMs,
        });
        target.assertHealthy();
        job.completedFrames++;
      }
      // 顺序推进；保存进度不必等到整个任务结束。
      if (index % 10 === 0 || index + 1 === job.plan.endIndex) await changed();
    }
  } finally {
    await target.close();
  }
  signal.throwIfAborted();
  await encodeJob(job, directory, signal, changed);
}
export async function encodeJob(
  job: Job,
  directory: string,
  signal: AbortSignal,
  changed: () => Promise<void>,
) {
  if (!job.plan) throw new Error("任务没有帧计划，无法重新编码");
  job.currentFrame = undefined;
  job.stage = "validating";
  await changed();
  await validateFrames(
    path.join(directory, "frames"),
    job.config,
    job.plan,
    signal,
  );
  job.stage = "encoding";
  job.encodedFrames = 0;
  await changed();
  job.video = await encode(
    directory,
    job.config,
    job.plan,
    signal,
    (frames) => {
      job.encodedFrames = frames;
    },
    () => {
      job.stage = "verifying";
    },
  );
  job.stage = "completed";
  job.error = undefined;
  await changed();
}
