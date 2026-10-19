import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import { once } from "node:events";
import { createApp } from "../src/server.ts";
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

function savedJob(id: string, stage: Job["stage"] = "completed"): Job {
  return {
    id,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    config: config(),
    stage,
    completedFrames: 0,
    warmedFrames: 0,
    encodedFrames: 0,
  };
}
test("删除单条任务和清空全部导出文件，重启后不会恢复且不越过目录", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "videomaker-cleanup-"));
  const root = path.join(temp, "exports");
  const outside = path.join(temp, "outside");
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  try {
    const jobs = new Jobs(root);
    await jobs.init();
    for (const id of ids) {
      const job = savedJob(id);
      await jobs.save(job);
      jobs.items.set(id, job);
      await mkdir(path.join(root, id, "frames"));
      await writeFile(path.join(root, id, "frames", frameFilename(0)), "PNG");
      await writeFile(path.join(root, id, "video.mp4"), "MP4");
    }
    await jobs.remove(ids[0]);
    assert.throws(() => jobs.get(ids[0]), /不存在/);
    assert.deepEqual(await readdir(root), [ids[1]]);
    const restored = new Jobs(root);
    await restored.init();
    assert.deepEqual(
      restored.list().map((job) => job.id),
      [ids[1]],
    );
    assert.throws(() => jobs.directory("../outside"), /ID/);
    await mkdir(path.join(root, "orphan", "nested"), { recursive: true });
    await writeFile(
      path.join(root, "orphan", "nested", "partial.png"),
      "partial",
    );
    await writeFile(path.join(root, "loose.txt"), "loose");
    await mkdir(outside);
    await writeFile(path.join(outside, "keep.txt"), "keep");
    // 清理目录链接本身，不得递归删除链接指向的外部文件。
    await symlink(
      outside,
      path.join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await jobs.clear();
    assert.deepEqual(await readdir(root), []);
    assert.deepEqual(jobs.list(), []);
    assert.equal(
      await readFile(path.join(outside, "keep.txt"), "utf8"),
      "keep",
    );
    const empty = new Jobs(root);
    await empty.init();
    assert.deepEqual(empty.list(), []);
    await jobs.clear();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
test("清理保护运行中、排队中和正在保存的任务", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "videomaker-cleanup-guard-"),
  );
  const id = "11111111-1111-4111-8111-111111111111";
  const jobs = new Jobs(root);
  try {
    await jobs.init();
    const job = savedJob(id, "queued");
    jobs.items.set(id, job);
    await jobs.save(job);
    await assert.rejects(jobs.remove(id), /运行或排队/);
    await assert.rejects(jobs.clear(), /运行或排队/);
    job.stage = "completed";
    jobs.active = { job, controller: new AbortController() };
    await assert.rejects(jobs.remove(id), /运行或排队/);
    await assert.rejects(jobs.clear(), /运行或排队/);
    jobs.active = undefined;
    jobs.queue.push({ job, encodeOnly: false });
    await assert.rejects(jobs.clear(), /运行或排队/);
    jobs.queue = [];
    assert.equal(
      await readFile(path.join(root, id, "job.json"), "utf8")
        .then(JSON.parse)
        .then((j) => j.id),
      id,
    );
    const save = jobs.save.bind(jobs);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    jobs.save = async (created) => {
      await pending;
      await save(created);
    };
    jobs.kick = () => {};
    const creating = jobs.create(config());
    try {
      await assert.rejects(jobs.clear(), /正在处理/);
      await assert.rejects(jobs.remove(id), /正在处理/);
    } finally {
      release();
      await creating;
    }
  } finally {
    await jobs.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("删除接口同步文件与记录，并拒绝跨站 DELETE 请求", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "videomaker-cleanup-api-"));
  const app = await createApp(root);
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base =
    "http://127.0.0.1:" + (app.server.address() as { port: number }).port;
  const id = "11111111-1111-4111-8111-111111111111";
  const job = savedJob(id);
  try {
    await app.jobs.save(job);
    app.jobs.items.set(id, job);
    for (const route of ["/api/jobs", "/api/jobs/" + id]) {
      const response = await fetch(base + route, {
        method: "DELETE",
        headers: { Origin: "https://foreign.example" },
      });
      assert.equal(response.status, 403);
      assert.equal(app.jobs.list().length, 1);
    }
    job.stage = "rendering";
    for (const route of ["/api/jobs", "/api/jobs/" + id]) {
      const response = await fetch(base + route, { method: "DELETE" });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /运行或排队/);
    }
    job.stage = "completed";
    assert.equal(
      (await fetch(base + "/api/jobs/" + id, { method: "DELETE" })).status,
      200,
    );
    assert.deepEqual(await fetch(base + "/api/jobs").then((r) => r.json()), []);
    assert.deepEqual(await readdir(root), []);
    await writeFile(path.join(root, "untracked.txt"), "orphan");
    assert.equal(
      (await fetch(base + "/api/jobs", { method: "DELETE" })).status,
      200,
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
