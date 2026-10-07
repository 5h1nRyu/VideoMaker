import { open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { ExportConfig, FramePlan } from "./config.ts";
import { frameFilename } from "./config.ts";
import { ffmpegPath, ffprobePath, runProcess } from "./process.ts";

export async function validateFrames(
  directory: string,
  config: ExportConfig,
  plan: FramePlan,
  signal?: AbortSignal,
) {
  const names = (await readdir(directory))
    .filter((n) => n.endsWith(".png"))
    .sort();
  if (names.length !== plan.frameCount)
    throw new Error(
      `PNG 帧数错误：实际 ${names.length}，预期 ${plan.frameCount}`,
    );
  for (let i = 0; i < names.length; i++) {
    signal?.throwIfAborted();
    if (names[i] !== frameFilename(i))
      throw new Error(`PNG 序列不连续，缺少 ${frameFilename(i)}`);
    const file = await open(path.join(directory, names[i]), "r");
    try {
      const header = Buffer.alloc(24);
      const { bytesRead } = await file.read(header, 0, 24, 0);
      if (
        bytesRead !== 24 ||
        !header
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        header.toString("ascii", 12, 16) !== "IHDR"
      )
        throw new Error(`PNG 文件损坏：${names[i]}`);
      if (
        header.readUInt32BE(16) !== config.output.width ||
        header.readUInt32BE(20) !== config.output.height
      ) {
        throw new Error(
          `PNG 尺寸错误：${names[i]}，预期 ${config.output.width}×${config.output.height}`,
        );
      }
    } finally {
      await file.close();
    }
  }
}
export interface VideoInfo {
  width: number;
  height: number;
  fps: number;
  frames: number;
  durationMs: number;
}
export async function verifyVideo(
  file: string,
  config: ExportConfig,
  plan: FramePlan,
  signal?: AbortSignal,
): Promise<VideoInfo> {
  const result = JSON.parse(
    await runProcess(
      ffprobePath(),
      [
        "-v",
        "error",
        "-count_frames",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        file,
      ],
      { signal },
    ),
  );
  const streams = result.streams as Array<Record<string, string | number>>;
  const video = streams.find((s) => s.codec_type === "video");
  if (!video || streams.length !== 1 || video.codec_name !== "h264")
    throw new Error("输出必须是单一 H.264 视频轨道");
  const [num, den] = String(video.avg_frame_rate).split("/").map(Number);
  const info = {
    width: Number(video.width),
    height: Number(video.height),
    fps: num / den,
    frames: Number(video.nb_read_frames),
    durationMs: Number(video.duration ?? result.format.duration) * 1000,
  };
  if (
    info.width !== config.output.width ||
    info.height !== config.output.height ||
    info.fps !== 60 ||
    info.frames !== plan.frameCount ||
    Math.abs(info.durationMs - plan.durationMs) > 2
  ) {
    throw new Error(`输出视频校验失败：${JSON.stringify(info)}`);
  }
  return info;
}
export async function encode(
  directory: string,
  config: ExportConfig,
  plan: FramePlan,
  signal: AbortSignal,
  progress: (frames: number) => void,
  verifying: () => void,
): Promise<VideoInfo> {
  const temporary = path.join(directory, "video.partial.mp4");
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    "-framerate",
    "60",
    "-start_number",
    "0",
    "-i",
    path.join(directory, "frames", "frame-%08d.png"),
    "-frames:v",
    String(plan.frameCount),
    "-an",
    "-c:v",
    "libx264",
    "-crf",
    String(config.crf),
    "-preset",
    config.preset,
    "-pix_fmt",
    "yuv420p",
    "-r",
    "60",
    "-movflags",
    "+faststart",
    "-progress",
    "pipe:1",
    "-nostats",
    temporary,
  ];
  try {
    await runProcess(ffmpegPath(), args, {
      signal,
      onLine: (line) => {
        if (line.startsWith("frame="))
          progress(Math.min(plan.frameCount, Number(line.slice(6)) || 0));
      },
    });
    verifying();
    const info = await verifyVideo(temporary, config, plan, signal);
    signal.throwIfAborted();
    await rename(temporary, path.join(directory, "video.mp4"));
    return info;
  } catch (e) {
    await rm(temporary, { force: true });
    throw e;
  }
}
