import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Jobs } from "./jobs.ts";
import { parseConfig, planFrames, frameFilename } from "./config.ts";
import { openTarget } from "./browser.ts";
import { checkDependencies } from "./process.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new Error("请求必须使用 JSON");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 16_384) throw new Error("请求参数过大");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("JSON 格式错误");
  }
}
async function sendFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  type: string,
  download?: string,
) {
  const info = await stat(file);
  const headers: Record<string, string | number> = {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
  };
  if (download)
    headers["Content-Disposition"] = `attachment; filename="${download}"`;
  let start = 0,
    end = info.size - 1,
    status = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416);
      res.end();
      return;
    }
    if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
    else {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    }
    if (start > end || start >= info.size) {
      res.writeHead(416, { "Content-Range": `bytes */${info.size}` });
      res.end();
      return;
    }
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${info.size}`;
  }
  headers["Content-Length"] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(file, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}
export async function createApp(
  outputRoot = process.env.OUTPUT_DIR || path.join(projectRoot, "exports"),
) {
  const jobs = new Jobs(path.resolve(outputRoot));
  await jobs.init();
  let inspecting = false;
  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? "";
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) {
        json(res, 403, { error: "仅允许本机访问" });
        return;
      }
      if (
        req.method === "POST" &&
        req.headers.origin &&
        req.headers.origin !== `http://${host}`
      ) {
        json(res, 403, { error: "不允许跨站请求" });
        return;
      }
      const url = new URL(req.url ?? "/", `http://${host}`);
      const route = url.pathname;
      if (req.method === "GET" && route === "/api/health") {
        const dependencies = await checkDependencies();
        json(res, 200, { dependencies, outputDirectory: jobs.root, fps: 60 });
        return;
      }
      if (req.method === "GET" && route === "/api/jobs") {
        json(res, 200, jobs.list());
        return;
      }
      if (req.method === "POST" && route === "/api/jobs") {
        json(res, 201, await jobs.create(parseConfig(await body(req))));
        return;
      }
      if (req.method === "POST" && route === "/api/inspect") {
        const config = parseConfig(await body(req));
        if (inspecting) {
          json(res, 409, { error: "正在读取另一个网页，请稍后再试" });
          return;
        }
        inspecting = true;
        const controller = new AbortController();
        const abort = () => controller.abort();
        res.on("close", abort);
        try {
          const target = await openTarget(config, controller.signal);
          try {
            json(res, 200, {
              manifest: target.manifest,
              plan: planFrames(config, target.manifest),
            });
          } finally {
            await target.close();
          }
        } finally {
          inspecting = false;
          res.off("close", abort);
        }
        return;
      }
      const match =
        /^\/api\/jobs\/([\da-f-]{36})(?:\/(cancel|reencode|video\.mp4|job\.json|frame))?$/.exec(
          route,
        );
      if (match) {
        const [, id, action] = match;
        const job = jobs.get(id);
        if (req.method === "GET" && !action) {
          json(res, 200, job);
          return;
        }
        if (req.method === "POST" && action === "cancel") {
          await body(req);
          json(res, 200, await jobs.cancel(id));
          return;
        }
        if (req.method === "POST" && action === "reencode") {
          json(res, 200, await jobs.reencode(id, await body(req)));
          return;
        }
        if (
          ["GET", "HEAD"].includes(req.method ?? "") &&
          action === "video.mp4"
        ) {
          if (job.stage !== "completed") throw new Error("视频尚未完成");
          await sendFile(
            req,
            res,
            path.join(jobs.directory(id), "video.mp4"),
            "video/mp4",
            url.searchParams.has("download") ? "video.mp4" : undefined,
          );
          return;
        }
        if (req.method === "GET" && action === "job.json") {
          json(res, 200, job);
          return;
        }
        if (req.method === "GET" && action === "frame") {
          const index = Number(url.searchParams.get("index") ?? 0);
          if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= job.completedFrames
          )
            throw new Error("该 PNG 帧不存在");
          await sendFile(
            req,
            res,
            path.join(jobs.directory(id), "frames", frameFilename(index)),
            "image/png",
            frameFilename(index),
          );
          return;
        }
      }
      const assets: Record<string, [string, string]> = {
        "/": ["public/index.html", "text/html; charset=utf-8"],
        "/app.js": ["public/app.js", "text/javascript; charset=utf-8"],
        "/style.css": ["public/style.css", "text/css; charset=utf-8"],
        "/example/": ["example/index.html", "text/html; charset=utf-8"],
        "/example/animation.js": [
          "example/animation.js",
          "text/javascript; charset=utf-8",
        ],
        "/protocol": ["docs/protocol-v1.md", "text/plain; charset=utf-8"],
      };
      if (["GET", "HEAD"].includes(req.method ?? "") && assets[route]) {
        const [file, type] = assets[route];
        await sendFile(req, res, path.join(projectRoot, file), type);
        return;
      }
      json(res, 404, { error: "页面或接口不存在" });
    } catch (e) {
      if (res.headersSent) res.destroy();
      else json(res, 400, { error: (e as Error).message });
    }
  });
  return {
    server,
    jobs,
    close: async () => {
      await jobs.close();
      server.close();
      server.closeIdleConnections();
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const port = Number(process.env.PORT || 3333);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT 必须是 1～65535 的整数");
  const app = await createApp();
  app.server.listen(port, "127.0.0.1", () =>
    console.log(
      `VideoMaker 已启动：http://127.0.0.1:${port}\n导出目录：${app.jobs.root}`,
    ),
  );
  app.server.on("error", (e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
  const stop = async () => {
    console.log("正在停止任务…");
    await app.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
