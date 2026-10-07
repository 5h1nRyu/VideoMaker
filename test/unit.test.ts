import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  frameAt,
  frameFilename,
  parseConfig,
  parseManifest,
  planFrames,
} from "../src/config.ts";
import { validateFrames } from "../src/encoder.ts";
import { runProcess } from "../src/process.ts";
import { Jobs } from "../src/jobs.ts";
import type { Job } from "../src/exporter.ts";

const manifest = parseManifest({
  name: "测试",
  durationMs: 1000,
  recommendedViewport: { width: 320, height: 180 },
  supportsSeeking: false,
});
const config = () =>
  parseConfig({
    url: "http://localhost:5173",
    viewport: { width: 320, height: 180 },
  });
test("配置支持 1080p、4K、任意同宽高比及合法 URL", () => {
  assert.equal(
    parseConfig({
      url: "https://example.com",
      output: { width: 3840, height: 2160 },
    }).deviceScaleFactor,
    2,
  );
  assert.equal(
    parseConfig({
      url: "http://localhost",
      viewport: { width: 720, height: 960 },
      output: { width: 1080, height: 1440 },
    }).deviceScaleFactor,
    1.5,
  );
  assert.equal(config().fps, 60);
});
test("拒绝非法尺寸、比例、帧率、URL、时间和画质", () => {
  for (const input of [
    { output: { width: 1921, height: 1080 } },
    { output: { width: 1920, height: 1200 } },
    { fps: 30 },
    { url: "file:///tmp/page" },
    { url: "https://user:password@example.com" },
    { startMs: 1000, endMs: 500 },
    { crf: -1 },
    { seed: 1.2 },
    { timeoutMs: NaN },
    { viewport: { width: 0, height: 1080 } },
    { output: { width: 8192, height: 8192 } },
  ])
    assert.throws(() => parseConfig({ url: "http://localhost", ...input }));
  assert.throws(() => parseConfig([]));
  assert.throws(() => parseManifest({ ...manifest, durationMs: 0 }));
  assert.throws(() => parseManifest({ ...manifest, supportsSeeking: "yes" }));
  assert.throws(() =>
    parseManifest({ ...manifest, recommendedViewport: undefined }),
  );
});
test("固定采样网格、终点排除、首帧 delta 和中途预推进", () => {
  const p = planFrames(config(), manifest);
  assert.equal(p.frameCount, 60);
  assert.equal(p.endIndex, 60);
  assert.equal(p.durationMs, 1000);
  assert.deepEqual(frameAt(0), { index: 0, timeMs: 0, deltaMs: 0 });
  assert.equal(frameAt(60).timeMs, 1000);
  assert.equal(frameAt(60).deltaMs, 1000 / 60);
  const part = planFrames({ ...config(), startMs: 500, endMs: 1000 }, manifest);
  assert.equal(part.firstIndex, 30);
  assert.equal(part.frameCount, 30);
  assert.equal(part.warmupCount, 30);
  assert.equal(
    planFrames(config(), { ...manifest, durationMs: 1000 / 60 }).frameCount,
    1,
  );
  const fraction = planFrames({ ...config(), startMs: 1, endMs: 20 }, manifest);
  assert.equal(fraction.firstIndex, 1);
  assert.equal(fraction.frameCount, 1);
  assert.equal(
    planFrames(
      { ...config(), startMs: 500 },
      { ...manifest, supportsSeeking: true },
    ).warmupCount,
    0,
  );
  assert.throws(() => planFrames({ ...config(), endMs: 2000 }, manifest));
  assert.throws(() =>
    planFrames({ ...config(), startMs: 1, endMs: 2 }, manifest),
  );
});
test("检查 PNG 编号、数量、文件头和尺寸", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "videomaker-unit-"));
  const plan = planFrames({ ...config(), endMs: 1000 / 60 }, manifest);
  const header = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
  header.write("IHDR", 12);
  header.writeUInt32BE(320, 16);
  header.writeUInt32BE(180, 20);
  try {
    await assert.rejects(validateFrames(dir, config(), plan), /帧数/);
    await writeFile(path.join(dir, frameFilename(0)), header);
    await validateFrames(dir, config(), plan);
    header.writeUInt32BE(322, 16);
    await writeFile(path.join(dir, frameFilename(0)), header);
    await assert.rejects(validateFrames(dir, config(), plan), /尺寸/);
    await writeFile(path.join(dir, frameFilename(0)), Buffer.alloc(24));
    await assert.rejects(validateFrames(dir, config(), plan), /损坏/);
    await rm(path.join(dir, frameFilename(0)));
    await writeFile(path.join(dir, frameFilename(1)), header);
    await assert.rejects(validateFrames(dir, config(), plan), /不连续/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("外部进程错误、超时和取消向上传递", async () => {
  await assert.rejects(
    runProcess("videomaker-nonexistent-command", []),
    /无法运行/,
  );
  await assert.rejects(
    runProcess(process.execPath, ["-e", "process.exit(2)"]),
    /退出码 2/,
  );
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeoutMs: 50,
    }),
    /超时/,
  );
  const controller = new AbortController();
  const running = runProcess(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(running, /取消/);
});
test("服务重启加载任务并标记中断任务，保留 PNG", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "videomaker-restart-"));
  const id = "11111111-1111-4111-8111-111111111111";
  const job: Job = {
    id,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    config: config(),
    stage: "rendering",
    completedFrames: 2,
    warmedFrames: 0,
    encodedFrames: 0,
    currentFrame: 1,
  };
  try {
    const jobs = new Jobs(dir);
    await jobs.save(job);
    await mkdir(path.join(dir, id, "frames"));
    await writeFile(path.join(dir, id, "frames", frameFilename(0)), "retained");
    const restored = new Jobs(dir);
    await restored.init();
    assert.equal(restored.get(id).stage, "failed");
    assert.equal(restored.get(id).error?.stage, "rendering");
    await assert.rejects(restored.reencode(id, {}), /尚未完整/);
    await restored.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
