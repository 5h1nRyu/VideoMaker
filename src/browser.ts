import { chromium } from "playwright";
import type { Page } from "playwright";
import type { ExportConfig } from "./config.ts";
import { parseManifest } from "./config.ts";
import type { ExportOptions } from "./protocol.ts";

export async function bounded<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    signal?.throwIfAborted();
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} 超时（${timeoutMs} ms）`)),
          timeoutMs,
        );
        abort = () => reject(new Error("任务已取消"));
        signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}
export function exportOptions(config: ExportConfig): ExportOptions {
  return {
    fps: 60,
    viewport: config.viewport,
    output: config.output,
    deviceScaleFactor: config.deviceScaleFactor,
    seed: config.seed,
  };
}
export async function openTarget(config: ExportConfig, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const browser = await chromium.launch({
    headless: true,
    timeout: config.timeoutMs,
    ...(process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {}),
  });
  const abort = () => {
    void browser.close().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  let page: Page | undefined;
  const errors: string[] = [];
  try {
    signal?.throwIfAborted();
    const context = await browser.newContext({
      viewport: config.viewport,
      deviceScaleFactor: config.deviceScaleFactor,
      locale: "zh-CN",
      timezoneId: "UTC",
      colorScheme: "light",
      serviceWorkers: "block",
    });
    await context.addInitScript((options) => {
      Object.defineProperty(window, "__VIDEO_EXPORT_REQUEST__", {
        value: Object.freeze({
          ...options,
          viewport: Object.freeze(options.viewport),
          output: Object.freeze(options.output),
        }),
        writable: false,
      });
    }, exportOptions(config));
    page = await context.newPage();
    page.setDefaultTimeout(config.timeoutMs);
    page.on("pageerror", (e) => {
      errors.push(e.message);
      if (errors.length > 20) errors.shift();
    });
    const response = await page.goto(config.url, {
      waitUntil: "domcontentloaded",
      timeout: config.timeoutMs,
    });
    if (response && response.status() >= 400)
      throw new Error(`网页返回 HTTP ${response.status()}`);
    await page
      .waitForFunction(() => !!window.__VIDEO_EXPORT__, null, {
        polling: 100,
        timeout: config.timeoutMs,
      })
      .catch(() => {
        throw new Error("未找到 window.__VIDEO_EXPORT__；请先接入逐帧协议 v1");
      });
    const raw = await bounded(
      page.evaluate(async () => {
        const api = window.__VIDEO_EXPORT__!;
        if (api.version !== 1) throw new Error(`不支持协议版本 ${api.version}`);
        for (const method of [
          "getManifest",
          "prepare",
          "reset",
          "renderFrame",
          "dispose",
        ] as const) {
          if (typeof api[method] !== "function")
            throw new Error(`缺少协议方法 ${method}`);
        }
        return await api.getManifest();
      }),
      config.timeoutMs,
      "getManifest()",
      signal,
    );
    const manifest = parseManifest(raw);
    const assertHealthy = () => {
      if (errors.length)
        throw new Error(`目标网页脚本异常：${errors.join("\n")}`);
    };
    assertHealthy();
    return {
      browser,
      page,
      manifest,
      assertHealthy,
      close: async () => {
        signal?.removeEventListener("abort", abort);
        try {
          if (!page!.isClosed())
            await bounded(
              page!.evaluate(async () => {
                await window.__VIDEO_EXPORT__?.dispose();
              }),
              Math.min(3000, config.timeoutMs),
              "dispose()",
            );
        } catch {
          /* 任务原始错误优先；dispose 超时后仍关闭浏览器。 */
        }
        await browser.close();
      },
    };
  } catch (e) {
    signal?.removeEventListener("abort", abort);
    await browser.close();
    throw e;
  }
}
export async function prepareTarget(
  page: Page,
  config: ExportConfig,
  signal?: AbortSignal,
) {
  await bounded(
    page.evaluate(async (options) => {
      await window.__VIDEO_EXPORT__!.prepare(options);
      await document.fonts.ready;
      await Promise.all(
        Array.from(document.images).map(async (img) => {
          if (img.currentSrc || img.src) {
            await img.decode();
            if (!img.naturalWidth)
              throw new Error(`图片加载失败：${img.currentSrc}`);
          }
        }),
      );
      await window.__VIDEO_EXPORT__!.reset();
    }, exportOptions(config)),
    config.timeoutMs,
    "prepare()/reset()/资源准备",
    signal,
  );
}
