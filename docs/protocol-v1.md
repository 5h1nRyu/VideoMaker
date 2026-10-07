# 网页逐帧协议 v1

完整类型见 [`src/protocol.ts`](../src/protocol.ts)，可运行示例见 [`example/animation.js`](../example/animation.js)。本协议规定目标网页的责任，导出器不会通过强行禁用 CSS 动画、拦截所有计时器等方式替网页实现确定性。

## 启动与生命周期

导出器在任何网页脚本运行前注入 `window.__VIDEO_EXPORT_REQUEST__`，其值为只读的 `ExportOptions`。目标网页从启动阶段检查这个标记，存在时禁用自动播放以及所有会自行推动可见状态的循环。不要等到 `prepare()` 才停止已经运行的模拟。

```js
const exporting = !!window.__VIDEO_EXPORT_REQUEST__;
if (!exporting) startNormalPlayback();
```

网页暴露 `window.__VIDEO_EXPORT__`。调用顺序为：

1. 打开网页，等待接口出现，验证 `version === 1` 和全部方法。
2. `getManifest()`：提供元数据，不启动动画、不要求已调用 `prepare()`。界面读取信息也调用它。
3. `prepare(options)`：进入导出模式，配置渲染尺寸、固定种子，等待字体、图片、数据及绘图资源准备完成。
4. `reset()`：恢复时间轴起点、随机数发生器、历史缓冲、积分状态、事件标记、平滑变量及待处理任务。
5. 连续调用 `renderFrame(frame)`，一次完成后才开始下一次。
6. `dispose()`：释放资源、停止待处理任务。仅检查元数据时也可能调用，须安全支持尚未 prepare 的情况。

所有方法允许返回 Promise。`prepare/reset/renderFrame` 有超时，失败即终止任务。资源准备不能依赖页面的实时动画循环推进，否则会死锁或产生不确定状态。

## 接口定义

```ts
interface ExportOptions {
  fps: 60;
  viewport: { width: number; height: number }; // CSS px
  output: { width: number; height: number }; // 图片像素
  deviceScaleFactor: number;
  seed: number; // uint32
}
interface ExportManifest {
  name: string;
  durationMs: number; // 0 < 时长 <= 24 小时
  recommendedViewport: { width: number; height: number };
  supportsSeeking: boolean;
}
interface Frame {
  index: number; // 从 0 开始的全局时间轴帧号
  timeMs: number; // index * 1000 / 60
  deltaMs: number; // 第 0 帧为 0，之后为 1000 / 60
}
interface VideoExportAPI {
  version: 1;
  getManifest(): ExportManifest | Promise<ExportManifest>;
  prepare(options: ExportOptions): void | Promise<void>;
  reset(): void | Promise<void>;
  renderFrame(frame: Frame): void | Promise<void>;
  dispose(): void | Promise<void>;
}
```

时间单位是毫秒。`index` 不是当前导出片段中的 PNG 编号。例如从 10 秒开始导出，PNG 00000000 对应时间轴帧 600。禁止反复累加四舍五入后的 16.667。

## 顺序推进与时间跳转

`supportsSeeking: false` 是基础能力：`reset()` 后必定收到 0、1、2……帧。第 0 帧应绘制初始状态，不积分推进一次。导出中间片段时工具会先顺序调用所有前置帧，随后才截图；预推进帧也必须完成逻辑、DOM 和实际绘制。

`supportsSeeking: true` 是强承诺：任何一次 `renderFrame()` 都能仅凭目标绝对时间，重建该时刻完整状态，与调用历史无关。工具可能在 reset 后直接请求第 600 帧。其 `deltaMs` 仍是 1/60 秒，不是从 0 到 10 秒的差值；有积分状态的项目不能靠该字段跳转，须自己重建或声明 false。

## 当前帧完成的含义

`renderFrame()` 返回前，网页必须完成：

- 计算该帧全部可见状态，包括延迟事件、图表轴范围、表格滚动与入场效果。
- 等待 React/Vue 等框架的提交和必要布局，避免状态尚未提交就返回。
- 实际绘制 Canvas/WebGL。WebGL 后处理、资源上传与 GPU 完成需由项目的绘图实现负责。
- 等待该帧依赖的异步工作；不得留出稍后改变画面的计时器或请求。

返回后画面必须保持不变，直到下一次 `renderFrame()`。允许使用浏览器绘制机会来完成一次提交，但不得在等待期间更新到另一个时间。导出器不使用固定睡眠猜测就绪状态。

工具额外等待 `document.fonts.ready` 和当前 DOM 中的图片 decode；这不能替代项目对背景图、字体加载失败、懒加载、异步数据与 WebGL 纹理的检查。准备阶段应显式加载需要的字体，主动加载图片和纹理并确认成功。

## 将全部可见效果交给同一时间轴

| 机制                             | 导出模式的实现要求                                           |
| -------------------------------- | ------------------------------------------------------------ |
| `requestAnimationFrame` 自动循环 | 启动时禁用循环，由 renderFrame 更新和绘制                    |
| `setTimeout` 延迟显示            | 用 `timeMs >= triggerMs` 判断；从时间计算状态                |
| CSS transition                   | 移除实时过渡，用目标时间计算插值并写入样式                   |
| CSS animation / Web Animations   | 创建后 pause，由时间轴设置 currentTime；避免运行中的播放状态 |
| 图表平滑、粒子、物理积分         | 按固定 deltaMs 顺序推进，reset 恢复历史状态                  |
| 随机运动                         | 使用自己的带种子发生器；reset 恢复；不要依赖 Math.random     |
| 日期、performance.now            | 可见时间使用 timeMs，固定展示日期或作为项目参数              |
| 嵌入视频、GIF、第三方内容        | 显式控制帧/解码并等待完成，无法控制时不满足协议              |

导出截图使用 `animations: 'allow'`，保留网页已经手动设置的动画状态。Playwright 的 `'disabled'` 会快进或取消动画，不能充当逐帧时间控制。

## 高清绘图

Canvas 典型做法：

```js
canvas.style.width = `${options.viewport.width}px`;
canvas.style.height = `${options.viewport.height}px`;
canvas.width = options.output.width;
canvas.height = options.output.height;
ctx.setTransform(
  options.deviceScaleFactor,
  0,
  0,
  options.deviceScaleFactor,
  0,
  0,
);
```

Three.js 项目通常配置 `renderer.setPixelRatio(options.deviceScaleFactor)` 与 `renderer.setSize(viewport.width, viewport.height)`，再按当前帧调用 `renderer.render(...)`。项目必须避免自己再次乘上 DPR，导致双重放大。

截图只取固定视口，不使用 fullPage，网页应填满画布并避免滚动条。普通 MP4 保留网页背景，透明网页像素会按截图默认不透明背景处理；建议项目显式绘制期望背景。

## 接入自检

1. 固定尺寸和 seed，prepare → reset → 顺序渲染同一组帧两遍，逐帧 PNG 应一致。
2. renderFrame 完成后间隔不同实际时间截图，画面应相同。
3. 导出完整动画和中途片段，相同全局帧的画面应一致。
4. 4K 输出检查文字边缘及 Canvas/WebGL 内部像素是否真正增加。
5. reset 后重复渲染，延迟事件、随机序列和历史平滑状态不受上一轮影响。

## 参考资料

- [Playwright Page API](https://playwright.dev/docs/api/class-page)：addInitScript、evaluate、screenshot。
- [FFmpeg image2 格式](https://ffmpeg.org/ffmpeg-formats.html#image2-1)：连续图像序列与输入帧率。
