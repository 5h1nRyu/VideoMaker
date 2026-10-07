/** VideoMaker 网页逐帧协议 v1；所有时间字段均为毫秒。 */
export interface Size {
  width: number;
  height: number;
}
export interface ExportOptions {
  fps: 60;
  viewport: Size;
  output: Size;
  deviceScaleFactor: number;
  seed: number;
}
export interface ExportManifest {
  name: string;
  durationMs: number;
  recommendedViewport: Size;
  supportsSeeking: boolean;
}
export interface Frame {
  /** 全局时间轴帧号，不是输出 PNG 的编号。 */
  index: number;
  timeMs: number;
  deltaMs: number;
}
export interface VideoExportAPI {
  version: 1;
  getManifest(): ExportManifest | Promise<ExportManifest>;
  prepare(options: ExportOptions): void | Promise<void>;
  reset(): void | Promise<void>;
  renderFrame(frame: Frame): void | Promise<void>;
  dispose(): void | Promise<void>;
}
declare global {
  interface Window {
    /** 在网页脚本运行前注入；目标项目据此从启动阶段禁用自动播放。 */
    __VIDEO_EXPORT_REQUEST__?: Readonly<ExportOptions>;
    __VIDEO_EXPORT__?: VideoExportAPI;
  }
}
