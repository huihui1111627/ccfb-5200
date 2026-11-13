# 鸟鸣筛查台 · Bird Song Screener

浏览器内运行的野外录音鸟鸣筛查工具。TypeScript + Web Audio API + Web Worker + IndexedDB，
无需后端服务，八小时长录音不需要一次性读入内存。

## 解决的问题

野外录音机一晚录 8 小时，人工听辨要点位要好几天。本工具把流程拆成五个页面：

1. **项目列表** — 调查项目的增删
2. **录音导入** — 批量导入 WAV / FLAC，自动读取录音机写入的时间与点位；也可一键生成带已知埋点的合成测试录音
3. **自动检测** — Worker 内流式分块算语谱图，按频段能量与谱通量检出疑似鸣声，自动标记风噪/雨噪时段
4. **人工标注** — 滚动语谱图、变速试听、框选时间×频段标注物种
5. **导出** — CSV 与 Raven Pro 选择表

## 快速开始

```bash
npm install
npm run dev        # 开发服务器
npm run build      # 类型检查 + 生产构建到 dist/
npm run selftest   # Node 侧算法自测（合成→检测→埋点误差核对）
npm run e2e        # 浏览器端到端测试（需本机有 Chromium，见下）
npm run make-test  # 生成一个 10 分钟合成 WAV + ground truth 到 test-data/
```

E2E 使用 Playwright 驱动的 Chromium（`playwright-core`，不下载浏览器），默认路径指向
`~/Library/Caches/ms-playwright/chromium-1254`，可在 `scripts/e2e.ts` 顶部修改
`CHROMIUM` 路径。FLAC 用例依赖本机 `ffmpeg`。

## 关键指标（自测结果）

`npm run selftest` 用确定性种子合成 2 分钟与 10 分钟录音，埋入已知时间点的鸣声、风段、雨段：

- 晴天条件下鸣声召回率 100%，精确率 100%
- 检出起止时间相对埋点的**最大误差约 0.05 s**（要求 ≤ 0.5 s）
- 风/雨天气段全部正确标出；被天气物理遮蔽的鸣声计入单独的"遮蔽漏报"，不参与通过门槛
- 浏览器 E2E 实测分析前后主线程 JS 堆稳定在 ~39 MB（不随录音时长增长）

`npx tsx scripts/stress-long.ts` 用 1 小时合成录音（跨 110+ 个 32 秒分块边界）验证时间轴不漂移：

- 晴天召回 100%，全部召回 96.7%（缺失项全部位于风/雨遮蔽段）
- 最大起点误差 0.162 s、终点误差 0.137 s，仍远优于 0.5 s 要求
- 雨段 2/2 准确；长风段会因阵风间隙被细分为多段（符合真实野外情况，仅作人工跳过提示，不参与鸣声检测）

## 架构与内存设计

八小时文件不整载入内存，核心是流式管线（`src/workers/analysis.worker.ts`）：

```
Blob (IndexedDB)
  → 1MB 字节窗口随机读取
  → WAV 直接切片 / FLAC 喂 WASM 流式解码器
  → 32s 分析块（块间带 fftSize-hop 重叠，边界不丢帧）
  → STFT(1024/Hann/512 hop) → 256×256 灰度语谱图瓦片 + 逐帧统计量
  → 瓦片/统计量分页写入 IndexedDB，原始 PCM 即用即弃
  → 合并统计量 → 事件检测 + 天气掩码 → 检出/天气段入库
```

- **瓦片懒加载**：语谱图查看器（`src/components/spectrogram-viewer.ts`）只取视口附近的瓦片，滚动时按需从 IDB 分页。
- **分块时间轴对齐**：每帧时间戳由"块起始样本号 + 帧 hop"直接推导，块间重叠 `fftSize-hop` 样本并按时间戳去重，从根上避免跨块时间漂移。
- **播放流式调度**：`src/audio/player.ts` 每次只解码 2 秒窗口、前瞻 3 个窗口，支持 0.25–4× 变速、带通滤波、区间循环。FLAC 随机访问基于分析期建立的字节/样本锚点。

## 检测算法（`src/dsp/`）

- `fft.ts` 手写迭代 radix-2 FFT；`analyze.ts` 逐帧算 RMS、谱通量、谱质心与低/中/高三频带能量
- `detect.ts`：
  - 全局 20 分位 + 60 秒宽窗中值取最小，作为自适应噪声地板（避免鸣声自身高能帧污染地板）
  - 两段式激活：谱通量瞬态"上膛"，之后靠频段 SNR 维持（稳态鸣声帧通量天然接近零）
  - 形态学闭运算桥接短间隙、事件首尾用峰值能量/通量重定位（抑制 FFT 谱泄漏造成的提前量）
  - 天气掩码先算：风 = 低频持续抬升 + 低质心 + 低中频带差；雨 = 三频带齐平 + 高质心；掩码帧不参与鸣声检测

## 数据与格式

- IndexedDB 库 `bird-song-screener`，含 projects / recordings / blobs / chunks / tiles /
  frameStats / detections / annotations / weather 九个对象仓
- 文件名解析支持 `点位_日期_时间`、`录音机序列号_..._点位` 等常见野外录音机约定；
  WAV 读取 LIST/INFO 与 bext，FLAC 读取 STREAMINFO 与 vorbis comment，元数据来源可追溯
- 导出 CSV 含绝对时间/点位/录音机字段；Raven 表为 1.6 兼容的制表符选择表（带 UTF-8 BOM）

## 目录

```
src/
  dsp/           FFT、STFT 语谱图、事件与天气检测（纯 TS，Worker 与 Node 自测共用）
  audio/         WAV/FLAC 解析、流式解码、播放引擎、WAV 编码
  workers/       分析 Worker
  components/    语谱图查看器
  pages/         五个页面
  services/      Worker 客户端、导入与浏览器合成
scripts/
  synth.ts       确定性合成器（浏览器与 Node 共用）
  selftest.ts    算法精度自测
  stress-long.ts 1 小时长录音压测
  e2e.ts         浏览器端到端测试
```
