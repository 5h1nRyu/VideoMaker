import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createApp } from "../src/server.ts";
import type { Job } from "../src/exporter.ts";
import { frameFilename, parseConfig } from "../src/config.ts";
import { openTarget, prepareTarget } from "../src/browser.ts";

async function pause(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
async function until<T>(
  read: () => T,
  predicate: (value: T) => boolean,
  timeout = 90_000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = read();
    if (predicate(value)) return value;
    await pause(50);
  }
  throw new Error("测试等待超时");
}
const html = (
  mode: string,
) => `<!doctype html><style>html,body{margin:0;overflow:hidden;background:#111}canvas{display:block;width:100vw;height:100vh}</style><canvas></canvas><script>
if(!window.__VIDEO_EXPORT_REQUEST__) throw new Error('缺少启动前标记');
let x=0,last=-1,opts;const c=document.querySelector('canvas'),ctx=c.getContext('2d');
window.__VIDEO_EXPORT__={version:${mode === "version" ? 2 : 1},getManifest(){return{name:'顺序测试',durationMs:10000,recommendedViewport:{width:320,height:180},supportsSeeking:false}},
prepare(o){opts=o;c.width=o.output.width;c.height=o.output.height},reset(){x=0;last=-1},
async renderFrame(f){
 if(f.index!==last+1) throw new Error('未按顺序推进');last=f.index;
 if('${mode}'==='throw'&&f.index===2) throw new Error('故意失败');
 if('${mode}'==='timeout') await new Promise(()=>{});
 if('${mode}'==='slow') await new Promise(r=>setTimeout(r,20));
 x+=f.deltaMs*.05;ctx.setTransform(opts.deviceScaleFactor,0,0,opts.deviceScaleFactor,0,0);ctx.fillStyle='#123456';ctx.fillRect(0,0,320,180);ctx.fillStyle='#bcf576';ctx.fillRect(x,40,30,30);
},dispose(){}};
</script>`;

test(
  "真实浏览器导出、顺序推进、尺寸、稳定性、失败与本地界面",
  { timeout: 300_000 },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "videomaker-integration-"),
    );
    const app = await createApp(root);
    app.server.listen(0, "127.0.0.1");
    await once(app.server, "listening");
    const address = app.server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    const fixture = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html(req.url!.slice(1)));
    });
    fixture.listen(0, "127.0.0.1");
    await once(fixture, "listening");
    const fixtureBase = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
    const cfg = (
      url = base + "/example/",
      extra: Record<string, unknown> = {},
    ) =>
      parseConfig({
        url,
        viewport: { width: 320, height: 180 },
        endMs: 1000,
        crf: 23,
        preset: "fast",
        ...extra,
      });
    async function finish(job: Job) {
      return until(
        () => app.jobs.get(job.id),
        (j) => ["completed", "failed", "cancelled"].includes(j.stage),
      );
    }
    async function exported(url?: string, extra?: Record<string, unknown>) {
      const job = await app.jobs.create(cfg(url, extra));
      await finish(job);
      assert.equal(job.stage, "completed", JSON.stringify(job.error));
      return job;
    }
    async function hash(job: Job, index: number) {
      return createHash("sha256")
        .update(
          await readFile(
            path.join(root, job.id, "frames", frameFilename(index)),
          ),
        )
        .digest("hex");
    }
    let first: Job;
    try {
      await t.test(
        "60 fps 60 帧无音频 MP4，重复导出 PNG 哈希一致",
        async () => {
          first = await exported();
          const second = await exported();
          assert.deepEqual(first.video, {
            width: 320,
            height: 180,
            fps: 60,
            frames: 60,
            durationMs: 1000,
          });
          for (let i = 0; i < 60; i++)
            assert.equal(
              await hash(first, i),
              await hash(second, i),
              `重复导出第 ${i} 帧`,
            );
        },
      );
      await t.test("顺序项目片段先预推进，与整段相同全局帧一致", async () => {
        const full = await exported(fixtureBase + "/sequential");
        const part = await exported(fixtureBase + "/sequential", {
          startMs: 500,
        });
        assert.equal(part.warmedFrames, 30);
        assert.equal(part.completedFrames, 30);
        for (let i = 0; i < 30; i++)
          assert.equal(await hash(full, i + 30), await hash(part, i));
      });
      await t.test("1080p、2 倍 DPR 4K、自定义尺寸实际输出", async () => {
        for (const size of [
          { width: 1920, height: 1080 },
          { width: 3840, height: 2160 },
        ]) {
          const job = await exported(base + "/example/", {
            viewport: { width: 1920, height: 1080 },
            output: size,
            endMs: 100,
          });
          assert.equal(job.video?.width, size.width);
          assert.equal(job.video?.height, size.height);
          assert.equal(job.video?.frames, 6);
        }
        const custom = await exported(base + "/example/", {
          viewport: { width: 240, height: 320 },
          output: { width: 360, height: 480 },
          endMs: 100,
        });
        assert.equal(custom.video?.width, 360);
      });
      await t.test("渲染接口返回后不随实际时间变化", async () => {
        const target = await openTarget(cfg());
        try {
          await prepareTarget(target.page, cfg());
          await target.page.evaluate(async () => {
            await window.__VIDEO_EXPORT__!.renderFrame({
              index: 30,
              timeMs: 500,
              deltaMs: 1000 / 60,
            });
          });
          const a = await target.page.screenshot();
          await pause(200);
          const b = await target.page.screenshot();
          assert.deepEqual(a, b);
        } finally {
          await target.close();
        }
      });
      await t.test("异常与超时保留具体帧和已有 PNG", async () => {
        const broken = await app.jobs.create(cfg(fixtureBase + "/throw"));
        await finish(broken);
        assert.equal(broken.stage, "failed");
        assert.equal(broken.error?.frame, 2);
        assert.equal(broken.completedFrames, 2);
        const timeout = await app.jobs.create(
          cfg(fixtureBase + "/timeout", { timeoutMs: 1000 }),
        );
        await finish(timeout);
        assert.equal(timeout.stage, "failed");
        assert.match(timeout.error!.message, /超时/);
        assert.equal(timeout.error?.frame, 0);
        const version = await app.jobs.create(cfg(fixtureBase + "/version"));
        await finish(version);
        assert.match(version.error!.message, /版本/);
        const absent = await app.jobs.create(
          cfg(base + "/", { timeoutMs: 1000 }),
        );
        await finish(absent);
        assert.match(absent.error!.message, /未找到/);
      });
      await t.test("取消运行中任务和排队任务", async () => {
        const slow = await app.jobs.create(
          cfg(fixtureBase + "/slow", { endMs: 10000 }),
        );
        const queued = await app.jobs.create(cfg());
        await app.jobs.cancel(queued.id);
        assert.equal(queued.stage, "cancelled");
        await until(
          () => slow,
          (j) => j.completedFrames >= 1,
        );
        await app.jobs.cancel(slow.id);
        await finish(slow);
        assert.equal(slow.stage, "cancelled");
      });
      await t.test("完整 PNG 重新编码，不访问原网页；缺帧则失败", async () => {
        const originalUrl = first.config.url;
        first.config.url = "http://127.0.0.1:1/unreachable";
        await app.jobs.reencode(first.id, { crf: 20, preset: "fast" });
        await finish(first);
        assert.equal(first.stage, "completed", first.error?.message);
        first.config.url = originalUrl;
        await rm(path.join(root, first.id, "frames", frameFilename(3)));
        await app.jobs.reencode(first.id, {});
        await finish(first);
        assert.equal(first.stage, "failed");
        assert.match(first.error!.message, /帧数/);
      });
      await t.test("网页界面、接口读取、视频下载和本机访问保护", async () => {
        const target = await openTarget(cfg());
        try {
          const page = target.page;
          const errors: string[] = [];
          page.on("pageerror", (e) => errors.push(e.message));
          await page.goto(base);
          await page.getByRole("button", { name: "读取信息" }).click();
          await page.locator("#manifest").waitFor({ state: "visible" });
          assert.match(await page.locator("#manifest").innerText(), /示例动画/);
          assert.deepEqual(errors, []);
          await page.getByRole("button", { name: "4K", exact: true }).click();
          assert.equal(await page.locator("#width").inputValue(), "3840");
          await page.setViewportSize({ width: 390, height: 844 });
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
            true,
          );
        } finally {
          await target.close();
        }
        const jobs = (await fetch(base + "/api/jobs").then((r) =>
          r.json(),
        )) as Job[];
        const completed = jobs.find((j) => j.stage === "completed")!;
        const response = await fetch(
          `${base}/api/jobs/${completed.id}/video.mp4`,
          { headers: { Range: "bytes=0-15" } },
        );
        assert.equal(response.status, 206);
        assert.equal((await response.arrayBuffer()).byteLength, 16);
        assert.equal(
          (
            await fetch(base + "/api/jobs", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Origin: "https://foreign.example",
              },
              body: "{}",
            })
          ).status,
          403,
        );
      });
      await t.test("界面删除确认、单条删除、全部清空和空状态", async () => {
        const target = await openTarget(cfg());
        try {
          const page = target.page;
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(base);
          const remove = page.getByRole("button", {
            name: "删除记录及文件",
            exact: true,
          });
          await remove.first().waitFor();
          const count = await remove.count();
          const id = await remove
            .first()
            .evaluate((node) =>
              node.closest("[data-job]")!.getAttribute("data-job"),
            );
          page.once("dialog", (dialog) => dialog.dismiss());
          await remove.first().click();
          assert.equal(app.jobs.list().length, count);
          const deleted = page.waitForResponse(
            (response) =>
              response.request().method() === "DELETE" &&
              response.url().endsWith("/" + id),
          );
          page.once("dialog", (dialog) => dialog.accept());
          await remove.first().click();
          assert.equal((await deleted).status(), 200);
          await page
            .locator('[data-job="' + id + '"]')
            .waitFor({ state: "detached" });
          assert.equal(app.jobs.list().length, count - 1);
          assert.equal((await readdir(root)).includes(id!), false);
          const clear = page.getByRole("button", {
            name: "清空导出文件",
            exact: true,
          });
          page.once("dialog", (dialog) => dialog.dismiss());
          await clear.click();
          assert.equal(app.jobs.list().length, count - 1);
          const cleared = page.waitForResponse(
            (response) =>
              response.request().method() === "DELETE" &&
              response.url().endsWith("/api/jobs"),
          );
          page.once("dialog", (dialog) => dialog.accept());
          await clear.click();
          assert.equal((await cleared).status(), 200);
          await page.locator("#jobs .empty").waitFor();
          assert.deepEqual(await readdir(root), []);
          await page.reload();
          await page.locator("#jobs .empty").waitFor();
          assert.equal(await page.locator("#jobs [data-job]").count(), 0);
          assert.deepEqual(errors, []);
        } finally {
          await target.close();
        }
      });
    } finally {
      await app.close();
      fixture.close();
      fixture.closeAllConnections();
      await rm(root, { recursive: true, force: true });
    }
  },
);
