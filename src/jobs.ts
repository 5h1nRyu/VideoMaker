import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parseConfig } from "./config.ts";
import type { ExportConfig } from "./config.ts";
import { encodeJob, exportJob } from "./exporter.ts";
import type { Job } from "./exporter.ts";

const terminal = new Set(["completed", "failed", "cancelled"]);
export class Jobs {
  root: string;
  items = new Map<string, Job>();
  queue: Array<{ job: Job; encodeOnly: boolean }> = [];
  active?: { job: Job; controller: AbortController };
  running?: Promise<void>;
  stopping = false;
  private mutating = false;
  constructor(root: string) {
    this.root = path.resolve(root);
  }
  directory(id: string) {
    if (!/^[\da-f-]{36}$/.test(id)) throw new Error("任务 ID 不合法");
    return this.childPath(id);
  }
  private childPath(name: string) {
    const target = path.resolve(this.root, name);
    if (path.dirname(target) !== this.root)
      throw new Error("只能删除导出目录内的内容");
    return target;
  }
  private async mutate<T>(action: () => Promise<T>): Promise<T> {
    if (this.mutating) throw new Error("正在处理任务操作，请稍后再试");
    this.mutating = true;
    try {
      return await action();
    } finally {
      this.mutating = false;
    }
  }
  async remove(id: string) {
    return this.mutate(async () => {
      const job = this.get(id);
      if (!terminal.has(job.stage) || this.active?.job.id === id)
        throw new Error("任务仍在运行或排队，请先取消并等待结束后再删除");
      await rm(this.directory(id), {
        recursive: true,
        force: true,
        maxRetries: 3,
      });
      this.items.delete(id);
    });
  }
  async clear() {
    return this.mutate(async () => {
      if (
        this.active ||
        this.queue.length ||
        this.list().some((job) => !terminal.has(job.stage))
      )
        throw new Error("有任务正在运行或排队，请先取消并等待结束后再清空");
      // 逐个删除直属条目，保留导出目录本身；也清理未能加载为任务的文件。
      for (const name of await readdir(this.root)) {
        await rm(this.childPath(name), {
          recursive: true,
          force: true,
          maxRetries: 3,
        });
        this.items.delete(name);
      }
      this.items.clear();
    });
  }
  async save(job: Job) {
    job.updatedAt = new Date().toISOString();
    const dir = this.directory(job.id);
    await mkdir(dir, { recursive: true });
    const temp = path.join(dir, "job.json.tmp");
    await writeFile(temp, JSON.stringify(job, null, 2) + "\n");
    await rename(temp, path.join(dir, "job.json"));
  }
  async init() {
    await mkdir(this.root, { recursive: true });
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[\da-f-]{36}$/.test(entry.name)) continue;
      try {
        const job: Job = JSON.parse(
          await readFile(path.join(this.root, entry.name, "job.json"), "utf8"),
        );
        if (job.id !== entry.name) continue;
        job.config = parseConfig(job.config);
        if (!terminal.has(job.stage)) {
          job.error = {
            stage: job.stage,
            frame: job.currentFrame,
            message:
              "上次运行被中断；已保留 PNG，可重新编码完整序列或创建新任务",
          };
          job.stage = "failed";
          await this.save(job);
        }
        this.items.set(job.id, job);
      } catch (e) {
        console.error(`读取任务 ${entry.name} 失败：`, (e as Error).message);
      }
    }
  }
  get(id: string) {
    const job = this.items.get(id);
    if (!job) throw new Error("任务不存在");
    return job;
  }
  list() {
    return [...this.items.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }
  async create(config: ExportConfig) {
    return this.mutate(async () => {
      if (this.stopping || this.queue.length >= 5)
        throw new Error("任务队列已满或服务正在退出");
      const job: Job = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        config,
        stage: "queued",
        completedFrames: 0,
        warmedFrames: 0,
        encodedFrames: 0,
      };
      await this.save(job);
      this.items.set(job.id, job);
      this.queue.push({ job, encodeOnly: false });
      this.kick();
      return job;
    });
  }
  async reencode(id: string, quality: unknown) {
    return this.mutate(async () => {
      const job = this.get(id);
      if (!terminal.has(job.stage)) throw new Error("任务仍在运行或排队");
      if (!job.plan || job.completedFrames !== job.plan.frameCount)
        throw new Error("PNG 序列尚未完整，无法重新编码");
      if (this.stopping || this.queue.length >= 5)
        throw new Error("任务队列已满或服务正在退出");
      if (!quality || typeof quality !== "object")
        throw new Error("编码参数格式错误");
      const q = quality as Record<string, unknown>;
      job.config = parseConfig({
        ...job.config,
        crf: q.crf ?? job.config.crf,
        preset: q.preset ?? job.config.preset,
      });
      job.error = undefined;
      job.stage = "queued";
      job.video = undefined;
      job.encodedFrames = 0;
      await this.save(job);
      this.queue.push({ job, encodeOnly: true });
      this.kick();
      return job;
    });
  }
  async cancel(id: string) {
    return this.mutate(async () => {
      const job = this.get(id);
      if (this.active?.job.id === id) this.active.controller.abort();
      else if (job.stage === "queued") {
        this.queue = this.queue.filter((item) => item.job.id !== id);
        job.stage = "cancelled";
        await this.save(job);
      }
      return job;
    });
  }
  kick() {
    if (this.running || this.stopping || !this.queue.length) return;
    this.running = this.drain().finally(() => {
      this.running = undefined;
      this.kick();
    });
  }
  async drain() {
    while (this.queue.length && !this.stopping) {
      const { job, encodeOnly } = this.queue.shift()!;
      const controller = new AbortController();
      this.active = { job, controller };
      try {
        await (encodeOnly ? encodeJob : exportJob)(
          job,
          this.directory(job.id),
          controller.signal,
          () => this.save(job),
        );
      } catch (e) {
        job.error = {
          stage: job.stage,
          frame: job.currentFrame,
          message: (e as Error).message,
        };
        job.stage = controller.signal.aborted ? "cancelled" : "failed";
        try {
          await this.save(job);
        } catch (error) {
          console.error("保存失败任务出错：", error);
        }
      } finally {
        this.active = undefined;
      }
    }
  }
  async close() {
    this.stopping = true;
    this.active?.controller.abort();
    await this.running;
    for (const { job } of this.queue) {
      job.stage = "cancelled";
      await this.save(job);
    }
    this.queue = [];
  }
}
