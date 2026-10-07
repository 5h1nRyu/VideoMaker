import { spawn } from "node:child_process";

/** 直接传递参数数组，不使用 shell；日志限定大小。 */
export async function runProcess(
  command: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    onLine?: (line: string) => void;
  } = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      pending = "",
      timedOut = false,
      killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2000);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs ?? 3_600_000);
    options.signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stdout = (stdout + chunk).slice(-1_000_000);
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) options.onLine?.(line);
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-16_000);
    });
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", stop);
    };
    child.once("error", (error) => {
      cleanup();
      reject(new Error(`无法运行 ${command}：${error.message}`));
    });
    child.once("close", (code) => {
      cleanup();
      if (options.signal?.aborted) reject(new Error("任务已取消"));
      else if (timedOut) reject(new Error(`${command} 执行超时`));
      else if (code !== 0)
        reject(new Error(`${command} 退出码 ${code}\n${stderr}`));
      else resolve(stdout);
    });
  });
}
export const ffmpegPath = () => process.env.FFMPEG_PATH || "ffmpeg";
export const ffprobePath = () => process.env.FFPROBE_PATH || "ffprobe";
export async function checkDependencies() {
  const entries = await Promise.all(
    [ffmpegPath(), ffprobePath()].map(async (command) => {
      try {
        return {
          command,
          ok: true,
          version: (
            await runProcess(command, ["-version"], { timeoutMs: 5000 })
          ).split("\n")[0],
        };
      } catch (e) {
        return { command, ok: false, version: (e as Error).message };
      }
    }),
  );
  return entries;
}
