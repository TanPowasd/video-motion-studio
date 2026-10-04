import path from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Application } from '../src/service/application.js';
import { chapters } from './deepseek-flash-story.js';
const root = path.resolve('productions/deepseek-v4-1-flash'),
  app = await new Application(root).open(false);
try {
  const reports = [];
  for (const chapter of chapters) {
    const scene = app.service.snapshot.scenes.find((s) => s.id === chapter.id)!,
      frames = [30, 90, Math.floor(scene.duration / 2), Math.max(0, scene.duration - 31)],
      report = await app.dispatch('visualAudit', {
        sceneId: scene.id,
        frames,
        width: 480,
        maxImages: 4,
        output: path.join(root, `exports/audit-${scene.id}.png`),
      });
    reports.push({
      sceneId: scene.id,
      frames,
      summary: report.summary,
      findings: report.findings,
      diagnostics: report.diagnostics,
    });
  }
  const sheet = createCanvas(1920, 1080),
    ctx = sheet.getContext('2d');
  ctx.fillStyle = '#0a1525';
  ctx.fillRect(0, 0, 1920, 1080);
  for (const [i, chapter] of chapters.entries()) {
    const image = await loadImage(await readFile(path.join(root, `exports/${chapter.id}.png`))),
      x = (i % 4) * 480,
      y = Math.floor(i / 4) * 540;
    ctx.drawImage(image, x, y + 40, 480, 270);
    ctx.fillStyle = '#adc7e8';
    ctx.font = '22px Microsoft YaHei';
    ctx.fillText(chapter.label, x + 16, y + 20);
  }
  await writeFile(path.join(root, 'exports/storyboard.png'), await sheet.encode('png'));
  await writeFile(
    path.join(root, 'exports/visual-audit.json'),
    JSON.stringify(reports, null, 2) + '\n',
  );
  const sample = await app.dispatch('audioPreview', {
    sequenceId: 'main',
    startSample: 0,
    sampleCount: 48000 * 8,
    output: path.join(root, 'exports/opening-audio.wav'),
  });
  console.log(
    JSON.stringify(
      {
        reports: reports.map((r) => ({
          scene: r.sceneId,
          summary: r.summary,
          codes: [...new Set(r.findings.map((f: { code: string }) => f.code))],
        })),
        audio: sample,
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
}
