// 可直接阅读和改造的协议 v1 示例。正常浏览用 RAF，导出模式从启动起禁用 RAF。
const canvas = document.getElementById("scene");
const ctx = canvas.getContext("2d");
const durationMs = 6000;
let options = {
  viewport: { width: innerWidth, height: innerHeight },
  deviceScaleFactor: devicePixelRatio,
  seed: 12345,
};
let particles = [],
  raf = 0;
function randomGenerator(seed) {
  let n = seed >>> 0;
  return () => {
    n = (Math.imul(1664525, n) + 1013904223) >>> 0;
    return n / 4294967296;
  };
}
function resize() {
  canvas.width = Math.round(options.viewport.width * options.deviceScaleFactor);
  canvas.height = Math.round(
    options.viewport.height * options.deviceScaleFactor,
  );
}
function reset() {
  const random = randomGenerator(options.seed);
  particles = Array.from({ length: 50 }, () => ({
    x: random(),
    y: random(),
    radius: 1 + random() * 3,
    speed: 0.01 + random() * 0.04,
  }));
  draw(0);
}
function smooth(value) {
  const x = Math.min(1, Math.max(0, value));
  return x * x * (3 - 2 * x);
}
function draw(timeMs) {
  const w = options.viewport.width,
    h = options.viewport.height,
    s = options.deviceScaleFactor,
    t = timeMs / 1000;
  // 使用固定设计画布，内部位图按输出 DPR 放大，维持高分辨率清晰度。
  ctx.setTransform((s * w) / 1920, 0, 0, (s * h) / 1080, 0, 0);
  ctx.fillStyle = "#111519";
  ctx.fillRect(0, 0, 1920, 1080);
  ctx.strokeStyle = "#283034";
  ctx.lineWidth = 1;
  for (let x = 0; x < 1920; x += 80) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 1080);
    ctx.stroke();
  }
  for (let y = 0; y < 1080; y += 80) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(1920, y);
    ctx.stroke();
  }
  for (const p of particles) {
    ctx.fillStyle = "#bcf576";
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.arc(
      ((p.x + t * p.speed) % 1) * 1920,
      p.y * 1080,
      p.radius,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  const enter = smooth((t - 0.25) / 1.2);
  ctx.save();
  ctx.translate(140 - (1 - enter) * 70, 0);
  ctx.globalAlpha = enter;
  ctx.fillStyle = "#bcf576";
  ctx.font = "22px sans-serif";
  ctx.fillText("VIDEOMAKER / OFFLINE RENDER", 0, 230);
  ctx.fillStyle = "#edf0ee";
  ctx.font = "bold 104px sans-serif";
  ctx.fillText("Every frame.", 0, 380);
  ctx.fillText("Your timeline.", 0, 510);
  ctx.fillStyle = "#929d9f";
  ctx.font = "28px sans-serif";
  ctx.fillText("PNG SEQUENCE  /  60 FPS  /  MP4", 0, 590);
  ctx.restore();
  const circle = smooth((t - 0.75) / 1.5),
    cx = 1420,
    cy = 475;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(t * 0.55);
  ctx.globalAlpha = circle;
  ctx.strokeStyle = "#bcf576";
  ctx.lineWidth = 14;
  ctx.strokeRect(-140 * circle, -140 * circle, 280 * circle, 280 * circle);
  ctx.strokeStyle = "#edf0ee";
  ctx.lineWidth = 2;
  ctx.strokeRect(-180 * circle, -180 * circle, 360 * circle, 360 * circle);
  ctx.restore();
  ctx.fillStyle = "#283034";
  ctx.fillRect(140, 810, 1640, 3);
  ctx.fillStyle = "#bcf576";
  ctx.fillRect(140, 810, 1640 * Math.min(1, timeMs / durationMs), 3);
  ctx.fillStyle = "#edf0ee";
  ctx.font = "24px monospace";
  ctx.fillText(`TIME  ${t.toFixed(3)} s`, 140, 865);
  ctx.fillText("60 FPS", 1650, 865);
}
window.__VIDEO_EXPORT__ = {
  version: 1,
  getManifest() {
    return {
      name: "VideoMaker 示例动画",
      durationMs,
      recommendedViewport: { width: 1920, height: 1080 },
      supportsSeeking: true,
    };
  },
  async prepare(next) {
    cancelAnimationFrame(raf);
    options = next;
    await document.fonts.ready;
    resize();
  },
  reset,
  // 所有可见状态均由绝对时间决定，因此无需历史状态，也可任意跳转。
  async renderFrame(frame) {
    draw(frame.timeMs);
  },
  dispose() {
    cancelAnimationFrame(raf);
  },
};
if (!window.__VIDEO_EXPORT_REQUEST__) {
  resize();
  reset();
  const start = performance.now();
  const tick = (now) => {
    draw((now - start) % durationMs);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}
