// End-to-end browser test driven by Playwright (chromium headless).
// Covers the complete workflow plus the FLAC/WASM path and a heap-size guard
// that proves long files are processed without loading them into memory.
//
// Run: npm run build && npx tsx scripts/e2e.ts

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEST_DIR = join(ROOT, 'test-data-e2e');
const PORT = 4317;
const BASE = `http://localhost:${PORT}`;
const CHROMIUM = join(
  process.env.HOME!,
  'Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
);

let failures = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

function sh(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stderr}`);
}

// ---- 1. Prepare test fixtures ------------------------------------------------
rmSync(TEST_DIR, { recursive: true, force: true });
mkdirSync(TEST_DIR, { recursive: true });
console.log('▶ 生成合成 WAV 测试文件…');
sh('npx', ['tsx', 'scripts/make-test-wav.ts', '120', TEST_DIR]);
const wavName = `SITE07_20260412_213000_synth120s.wav`;
const wavPath = join(TEST_DIR, wavName);
check('WAV 测试文件存在', existsSync(wavPath));
const flacName = wavName.replace(/\.wav$/, '.flac');
const flacPath = join(TEST_DIR, flacName);
console.log('▶ ffmpeg 转 FLAC（带 vorbis 注释）…');
sh('ffmpeg', ['-y', '-i', wavPath, '-c:a', 'flac',
  '-metadata', 'location=SITE07', '-metadata', 'date=2026-04-12T21:30:00', flacPath]);
check('FLAC 测试文件存在', existsSync(flacPath));

// ---- 2. Start preview server -------------------------------------------------
console.log('▶ 启动 vite preview…');
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server start timeout')), 30000);
  server.stdout?.on('data', (d: Buffer) => {
    if (d.toString().includes(String(PORT))) {
      clearTimeout(timer);
      resolve();
    }
  });
  server.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
});

const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
const page = await browser.newPage();
const consoleErrors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

try {
  // ---- 3. Project + synthetic import ---------------------------------------
  await page.goto(BASE);
  await page.fill('input[placeholder*="新项目"]', 'E2E 验证项目');
  await page.click('button.primary:has-text("新建项目")');
  await page.waitForURL(/#\/import\//);

  await page.fill('.card input[type="number"]', '120');
  await page.click('button:has-text("生成并导入合成测试录音")');
  await page.waitForSelector('text=已导入', { timeout: 60000 });
  check('合成录音导入成功', (await page.locator('table tbody tr').count()) >= 1);

  // ---- 4. Run analysis via worker -------------------------------------------
  await page.click('button:has-text("前往自动检测")');
  await page.waitForURL(/#\/detect\//);
  const heapBefore = await page.evaluate(() =>
    (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);
  await page.click('button:has-text("批量分析全部录音")');
  await page.waitForSelector('.pill.status-analyzed', { timeout: 300000 });
  // Allow the table refresh to land.
  await page.waitForTimeout(1000);
  const heapAfter = await page.evaluate(() =>
    (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);

  const gtBadge = await page.locator('.pill.high', { hasText: '最大误差' }).first().textContent();
  console.log('埋点核对徽章：', gtBadge);
  const m = gtBadge?.match(/(\d+)\/(\d+).*?([\d.]+)s/);
  check('埋点鸣声全部检出', !!m && m[1] === m[2], gtBadge ?? '');
  check('最大时间误差 ≤ 0.5s', !!m && Number(m[3]) <= 0.5, gtBadge ?? '');
  check('分析后主线程堆 < 350MB', heapAfter < 350 * 1024 * 1024,
    `before=${(heapBefore / 1048576).toFixed(1)}MB after=${(heapAfter / 1048576).toFixed(1)}MB`);

  // ---- 5. Spectrogram + annotation ------------------------------------------
  await page.click('button:has-text("打开语谱图")');
  await page.waitForURL(/#\/annotate\//);
  await page.waitForTimeout(2500); // tile paging
  const canvasInfo = await page.evaluate(() => {
    const c = document.querySelector('canvas.spec-canvas') as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonBlack = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 24) nonBlack++;
    return { nonBlack, total: data.length / 4 };
  });
  check('语谱图瓦片已渲染（非黑像素 > 1%）', canvasInfo.nonBlack / canvasInfo.total > 0.01,
    `${canvasInfo.nonBlack}/${canvasInfo.total}`);

  // Drag a band box on the overlay canvas.
  const box = await page.locator('canvas.overlay-layer').boundingBox();
  if (!box) throw new Error('overlay canvas missing');
  const x0 = box.x + box.width * 0.35;
  const y0 = box.y + box.height * 0.3;
  const x1 = box.x + box.width * 0.55;
  const y1 = box.y + box.height * 0.6;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await page.fill('input[placeholder*="物种"]', 'Turdus_merula');
  await page.click('button:has-text("保存标注")');
  await page.waitForTimeout(800);
  // A manual annotation created from a free band-drag has no linked detection,
  // so verify it via the species input being cleared + export content later.
  const speciesCleared = await page.inputValue('input[placeholder*="物种"]');
  check('标注保存成功（表单重置，无报错）', speciesCleared === '');

  // Playback transport: click play, wait, check time label advanced.
  await page.click('.transport button.primary');
  await page.waitForTimeout(1500);
  const timeText = await page.locator('.transport .time').textContent();
  const headSecs = timeText?.split('/')[0].trim().split(':').reduce((a, v) => a * 60 + Number(v), 0) ?? 0;
  check('播放头随播放推进', headSecs > 0.5, timeText ?? '');
  await page.click('.transport button.primary'); // pause (now labelled 暂停)

  // ---- 6. Export --------------------------------------------------------------
  await page.goto(`${BASE}#/export/${page.url().match(/#\/annotate\/([^/]+)/)![1]}`);
  await page.waitForTimeout(800);

  const [csvDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('button:has-text("导出 CSV")'),
  ]);
  const csvPath = join(TEST_DIR, 'export.csv');
  await csvDownload.saveAs(csvPath);
  const csv = readFileSync(csvPath, 'utf-8');
  const csvLines = csv.trim().split('\n');
  check('CSV 表头正确', csvLines[0].includes('species') && csvLines[0].includes('start_sec'));
  check('CSV 含人工标注物种行', csv.includes('Turdus_merula'));
  check('CSV 含自动检出行（物种留空）', csvLines.some((l) => l.endsWith(',') || l.endsWith(',auto') || l.split(',').includes('')));

  const [ravenDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('button:has-text("导出 Raven")'),
  ]);
  const ravenPath = join(TEST_DIR, 'raven.txt');
  await ravenDownload.saveAs(ravenPath);
  const raven = readFileSync(ravenPath, 'utf-8');
  check('Raven 表头符合 1.6 格式',
    raven.includes('Selection') && raven.includes('Begin Time (s)') && raven.includes('Low Freq (Hz)'));
  check('Raven 为制表符分隔', raven.split('\n')[1]?.includes('\t'));
  check('Raven 含标注物种', raven.includes('Turdus_merula'));

  // ---- 7. FLAC path -----------------------------------------------------------
  await page.goto(`${BASE}#/import/${page.url().match(/#\/(?:annotate|export)\/([^/]+)/)![1]}`);
  await page.waitForTimeout(600);
  await page.setInputFiles('input[accept*="flac"]', flacPath);
  await page.waitForSelector('button:has-text("全部导入")', { timeout: 15000 });
  await page.waitForTimeout(800); // header preview
  await page.click('button:has-text("全部导入")');
  await page.waitForTimeout(1000);
  check('FLAC 已导入列表', (await page.locator('table tbody tr').count()) >= 2);

  await page.click('button:has-text("前往自动检测")');
  await page.waitForTimeout(500);
  await page.click('button:has-text("批量分析全部录音")');
  // Wait specifically for the FLAC row to reach analyzed (the WAV row may
  // re-run in the same batch and briefly flip back to analyzing).
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('table tbody tr')).some((tr) => {
      const text = tr.textContent ?? '';
      return text.includes('.flac') && text.includes('analyzed');
    }),
    { timeout: 300000 },
  );
  await page.waitForFunction(
    () => !Array.from(document.querySelectorAll('.pill')).some((p) =>
      (p.textContent ?? '').includes('analyzing')),
    { timeout: 300000 },
  );
  const analyzedCount = await page.locator('.pill.status-analyzed').count();
  check('WAV 与 FLAC 均分析完成', analyzedCount >= 2, `${analyzedCount} analyzed`);
  const detCounts = await page.locator('table tbody tr').allInnerTexts();
  const flacRow = detCounts.find((r) => r.includes('.flac')) ?? '';
  check('FLAC 经 WASM 解码后产出检出', flacRow.includes('analyzed') && !/\t0\t/.test(flacRow),
    flacRow.replace(/\n/g, ' | '));

  // ---- 8. Console hygiene -----------------------------------------------------
  const serious = consoleErrors.filter((e) =>
    !/favicon|AudioContext|autoplay|The play\(\) request/i.test(e));
  check('浏览器控制台无严重错误', serious.length === 0, serious.slice(0, 3).join(' || '));
} catch (err) {
  console.error('E2E 异常：', err);
  failures++;
} finally {
  await browser.close();
  server.kill();
}

console.log(failures === 0 ? '\n🎉 E2E 全部通过' : `\n💥 ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
