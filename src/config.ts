import type { ExportManifest, ExportOptions, Frame, Size } from "./protocol.ts";

export interface ExportConfig extends ExportOptions {
  url: string;
  startMs: number;
  endMs: number | null;
  crf: number;
  preset: "fast" | "medium" | "slow";
  timeoutMs: number;
}
export interface FramePlan {
  firstIndex: number;
  endIndex: number;
  frameCount: number;
  warmupCount: number;
  actualStartMs: number;
  actualEndMs: number;
  durationMs: number;
}
function number(
  value: unknown,
  fallback: number,
  name: string,
  min: number,
  max: number,
  integer = false,
) {
  const n = value === undefined ? fallback : value;
  if (
    typeof n !== "number" ||
    !Number.isFinite(n) ||
    n < min ||
    n > max ||
    (integer && !Number.isInteger(n))
  ) {
    throw new Error(
      `${name}必须是 ${min}～${max} 范围内的${integer ? "整数" : "数字"}`,
    );
  }
  return n;
}
function size(value: unknown, fallback: Size, name: string, max: number): Size {
  if (value === undefined) return fallback;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name}格式错误`);
  const v = value as Record<string, unknown>;
  return {
    width: number(v.width, fallback.width, `${name}宽度`, 16, max, true),
    height: number(v.height, fallback.height, `${name}高度`, 16, max, true),
  };
}
export function parseUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096)
    throw new Error("请填写目标网页 URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("网页地址必须是完整的 http:// 或 https:// URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("仅支持不包含账号密码的 HTTP/HTTPS 地址");
  }
  return url.href;
}
export function parseConfig(raw: unknown): ExportConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("导出参数格式错误");
  const v = raw as Record<string, unknown>;
  if (v.fps !== undefined && v.fps !== 60)
    throw new Error("第一版固定输出 60 fps");
  const viewport = size(
    v.viewport,
    { width: 1920, height: 1080 },
    "布局尺寸",
    8192,
  );
  const output = size(v.output, viewport, "输出尺寸", 8192);
  if (output.width % 2 || output.height % 2)
    throw new Error("H.264 MP4 的输出宽高必须为偶数");
  if (output.width * output.height > 33_554_432)
    throw new Error("输出尺寸最多允许 3355 万像素");
  if (output.width * viewport.height !== output.height * viewport.width) {
    throw new Error("布局尺寸和输出尺寸必须保持相同宽高比；请同步调整布局尺寸");
  }
  const deviceScaleFactor = output.width / viewport.width;
  if (deviceScaleFactor < 0.25 || deviceScaleFactor > 4)
    throw new Error("输出尺寸应为布局尺寸的 0.25～4 倍");
  const preset = v.preset ?? "medium";
  if (!["fast", "medium", "slow"].includes(preset as string))
    throw new Error("编码速度选项无效");
  const startMs = number(v.startMs, 0, "起始时间", 0, 86_400_000);
  const endMs =
    v.endMs == null ? null : number(v.endMs, 0, "结束时间", 0, 86_400_000);
  if (endMs !== null && endMs <= startMs)
    throw new Error("结束时间必须大于起始时间");
  return {
    url: parseUrl(v.url),
    fps: 60,
    viewport,
    output,
    deviceScaleFactor,
    seed: number(v.seed, 12345, "随机种子", 0, 4_294_967_295, true),
    startMs,
    endMs,
    crf: number(v.crf, 18, "CRF", 0, 51, true),
    preset: preset as ExportConfig["preset"],
    timeoutMs: number(v.timeoutMs, 30_000, "单步超时", 1000, 300_000, true),
  };
}
export function parseManifest(raw: unknown): ExportManifest {
  if (!raw || typeof raw !== "object")
    throw new Error("getManifest() 必须返回动画信息");
  const m = raw as Record<string, unknown>;
  if (typeof m.name !== "string" || !m.name.trim() || m.name.length > 200)
    throw new Error("动画名称无效");
  if (typeof m.supportsSeeking !== "boolean")
    throw new Error("必须声明 supportsSeeking");
  if (m.recommendedViewport === undefined)
    throw new Error("必须提供 recommendedViewport");
  return {
    name: m.name,
    durationMs: number(m.durationMs, NaN, "动画时长", 0.001, 86_400_000),
    recommendedViewport: size(
      m.recommendedViewport,
      { width: 1920, height: 1080 },
      "推荐布局尺寸",
      8192,
    ),
    supportsSeeking: m.supportsSeeking,
  };
}
export function planFrames(
  config: ExportConfig,
  manifest: ExportManifest,
): FramePlan {
  const end = config.endMs ?? manifest.durationMs;
  if (end > manifest.durationMs || config.startMs >= end)
    throw new Error("导出区间超出动画总时长");
  // 固定采样网格：包含区间起点，不包含终点；容忍浮点乘除产生的极小误差。
  const firstIndex = Math.ceil((config.startMs * 60) / 1000 - 1e-9);
  const endIndex = Math.ceil((end * 60) / 1000 - 1e-9);
  const frameCount = endIndex - firstIndex;
  if (frameCount < 1)
    throw new Error("导出区间不包含任何 60 fps 采样帧，请扩大区间");
  return {
    firstIndex,
    endIndex,
    frameCount,
    warmupCount: manifest.supportsSeeking ? 0 : firstIndex,
    actualStartMs: (firstIndex * 1000) / 60,
    actualEndMs: (endIndex * 1000) / 60,
    durationMs: (frameCount * 1000) / 60,
  };
}
export function frameAt(index: number): Frame {
  return {
    index,
    timeMs: (index * 1000) / 60,
    deltaMs: index === 0 ? 0 : 1000 / 60,
  };
}
export function frameFilename(index: number) {
  return `frame-${String(index).padStart(8, "0")}.png`;
}
