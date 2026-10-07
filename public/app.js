const $ = (id) => document.getElementById(id);
const stages = {
  queued: "等待中",
  loading: "加载网页",
  preparing: "准备资源",
  warming: "预推进",
  rendering: "逐帧截图",
  validating: "校验 PNG",
  encoding: "编码视频",
  verifying: "验证视频",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};
let outputDirectory = "",
  lastSnapshot = "",
  refreshing = false;
const terminal = (stage) =>
  ["completed", "failed", "cancelled"].includes(stage);
function notice(message) {
  $("notice").hidden = !message;
  $("notice").textContent = message;
}
async function api(url, data) {
  const response = await fetch(
    url,
    data === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "请求失败");
  return result;
}
function config() {
  return {
    url: $("url").value,
    viewport: {
      width: Number($("layout-width").value),
      height: Number($("layout-height").value),
    },
    output: {
      width: Number($("width").value),
      height: Number($("height").value),
    },
    startMs: Number($("start").value) * 1000,
    endMs: $("end").value === "" ? null : Number($("end").value) * 1000,
    seed: Number($("seed").value),
    crf: Number($("crf").value),
    preset: $("preset").value,
    timeoutMs: Number($("timeout").value) * 1000,
  };
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function link(text, href, className = "") {
  const node = element("a", className, text);
  node.href = href;
  return node;
}
function button(text, action) {
  const node = element("button", "", text);
  node.type = "button";
  node.addEventListener("click", async () => {
    node.disabled = true;
    try {
      await action();
      notice("");
      await refresh(true);
    } catch (e) {
      notice(e.message);
    } finally {
      node.disabled = false;
    }
  });
  return node;
}
function card(job) {
  const node = element("article", "job");
  node.dataset.job = job.id;
  const head = element("div", "job-head"),
    title = element("div");
  title.append(
    element("h3", "", job.manifest?.name || "网页动画"),
    element("small", "", new Date(job.createdAt).toLocaleString()),
  );
  head.append(title, element("span", `status ${job.stage}`, stages[job.stage]));
  node.append(head);
  const c = job.config,
    plan = job.plan;
  node.append(
    element(
      "div",
      "job-meta",
      `${c.output.width} × ${c.output.height} · 60 FPS · ${plan ? (plan.durationMs / 1000).toFixed(3) + " 秒 · " + plan.frameCount + " 帧" : "正在确定时长"}`,
    ),
  );
  if (!terminal(job.stage)) {
    let ratio = 0,
      text = stages[job.stage];
    if (plan) {
      if (job.stage === "warming") {
        ratio = job.warmedFrames / Math.max(1, plan.warmupCount);
        text = `预推进 ${job.warmedFrames} / ${plan.warmupCount} 帧`;
      } else if (job.stage === "rendering") {
        ratio = job.completedFrames / plan.frameCount;
        text = `截图 ${job.completedFrames} / ${plan.frameCount} 帧`;
      } else if (job.stage === "encoding") {
        ratio = job.encodedFrames / plan.frameCount;
        text = `编码 ${job.encodedFrames} / ${plan.frameCount} 帧`;
      } else if (["validating", "verifying"].includes(job.stage)) ratio = 1;
    }
    const bar = element("div", "progress"),
      fill = element("div");
    fill.style.width = `${Math.min(100, ratio * 100)}%`;
    bar.append(fill);
    node.append(bar, element("div", "job-progress", text));
  }
  if (job.error)
    node.append(
      element(
        "pre",
        "job-error",
        `${stages[job.error.stage]}${job.error.frame !== undefined ? " · 时间轴第 " + job.error.frame + " 帧" : ""}\n${job.error.message}`,
      ),
    );
  const actions = element("div", "job-actions"),
    base = `/api/jobs/${job.id}`;
  if (job.stage === "completed")
    actions.append(link("下载 MP4", base + "/video.mp4?download", "download"));
  if (job.completedFrames)
    actions.append(link("下载首帧 PNG", base + "/frame?index=0"));
  if (terminal(job.stage) && plan && job.completedFrames === plan.frameCount)
    actions.append(
      button("按当前画质重新编码", () =>
        api(base + "/reencode", {
          crf: Number($("crf").value),
          preset: $("preset").value,
        }),
      ),
    );
  if (!terminal(job.stage))
    actions.append(button("取消任务", () => api(base + "/cancel", {})));
  actions.append(link("任务信息", base + "/job.json"));
  node.append(actions);
  if (outputDirectory)
    node.append(
      element("div", "job-path", `文件位置：${outputDirectory}/${job.id}`),
    );
  if (job.stage === "completed") {
    const video = element("video");
    video.controls = true;
    video.preload = "none";
    video.src = base + "/video.mp4";
    node.append(video);
  }
  return node;
}
async function refresh(force = false) {
  if (refreshing) return;
  refreshing = true;
  try {
    const jobs = await api("/api/jobs"),
      snapshot = JSON.stringify(jobs);
    if (force || snapshot !== lastSnapshot) {
      lastSnapshot = snapshot;
      if (jobs.length) {
        // 更新变化的任务，避免每次轮询重建正在播放的视频。
        const container = $("jobs");
        if (container.querySelector(".empty")) container.replaceChildren();
        for (let index = 0; index < jobs.length; index++) {
          const job = jobs[index],
            old = container.querySelector(`[data-job="${job.id}"]`),
            key = JSON.stringify(job);
          if (old?.dataset.snapshot === key) continue;
          const next = card(job);
          next.dataset.snapshot = key;
          if (old) old.replaceWith(next);
          else container.insertBefore(next, container.children[index] || null);
        }
      }
    }
  } catch (e) {
    notice(e.message);
  } finally {
    refreshing = false;
  }
}
document.querySelectorAll(".preset").forEach((node) =>
  node.addEventListener("click", () => {
    document
      .querySelectorAll(".preset")
      .forEach((n) => n.classList.remove("selected"));
    node.classList.add("selected");
    if (node.dataset.width) {
      $("width").value = node.dataset.width;
      $("height").value = node.dataset.height;
    } else {
      $("width").focus();
    }
  }),
);
for (const id of ["width", "height"])
  $(id).addEventListener("input", () => {
    document
      .querySelectorAll(".preset")
      .forEach((n) =>
        n.classList.toggle("selected", n.hasAttribute("data-custom")),
      );
  });
$("use-demo").addEventListener("click", () => {
  $("url").value = location.origin + "/example/";
  $("manifest").hidden = true;
});
$("url").value = location.origin + "/example/";
$("inspect").addEventListener("click", async () => {
  $("inspect").disabled = true;
  notice("");
  try {
    const { manifest, plan } = await api("/api/inspect", config());
    $("manifest").textContent =
      `${manifest.name} · 总时长 ${manifest.durationMs / 1000} 秒 · ${manifest.supportsSeeking ? "支持时间跳转" : "顺序推进"}\n推荐布局 ${manifest.recommendedViewport.width}×${manifest.recommendedViewport.height}；本次 ${plan.frameCount} 帧，实际时长 ${(plan.durationMs / 1000).toFixed(3)} 秒`;
    $("manifest").hidden = false;
  } catch (e) {
    notice(e.message);
  } finally {
    $("inspect").disabled = false;
  }
});
$("export-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("submit").disabled = true;
  notice("");
  try {
    await api("/api/jobs", config());
    await refresh(true);
  } catch (e) {
    notice(e.message);
  } finally {
    $("submit").disabled = false;
  }
});
try {
  const health = await api("/api/health");
  outputDirectory = health.outputDirectory;
  const ok = health.dependencies.every((d) => d.ok);
  $("health").textContent = ok
    ? "FFmpeg / FFprobe 已就绪"
    : "编码环境未就绪，请安装 FFmpeg 并加入 PATH";
  $("health").className = ok ? "health-ok" : "health-error";
} catch (e) {
  notice(e.message);
}
await refresh();
setInterval(() => {
  void refresh();
}, 1000);
