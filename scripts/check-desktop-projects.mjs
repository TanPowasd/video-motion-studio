// Actual hidden Electron window; isolated projects and preferences, no native picker automation.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';
const packaged = process.argv.includes('--packaged');
await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(path.resolve('artifacts/desktop-projects-'));
const preferences = path.join(root, 'preferences'),
  projects = path.join(root, 'projects');
await mkdir(preferences);
await mkdir(projects);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, message, timeout = 20000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(100);
  }
  throw new Error(`${message}: ${last?.message ?? 'timeout'}`);
}
async function launch() {
  const allocator = net.createServer();
  await new Promise((resolve) => allocator.listen(0, '127.0.0.1', resolve));
  const port = allocator.address().port;
  await new Promise((resolve) => allocator.close(resolve));
  const executable = path.resolve(
    packaged ? 'release/Vmotion/Vmotion.exe' : 'node_modules/electron/dist/electron.exe',
  );
  const child = spawn(executable, [...(packaged ? [] : ['.']), `--remote-debugging-port=${port}`], {
    cwd: path.resolve('.'),
    windowsHide: true,
    env: {
      ...process.env,
      VMOTION_UI_TEST: '1',
      VMOTION_TEST_USER_DATA: preferences,
      ELECTRON_RUN_AS_NODE: undefined,
      VMOTION_SMOKE: undefined,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += String(data);
  });
  let exited = false;
  const exit = new Promise((resolve) =>
    child.once('exit', (code) => {
      exited = true;
      resolve(code);
    }),
  );
  const pending = new Map();
  let id = 0;
  let socket;
  try {
    const target = await until(async () => {
      if (exited) throw new Error(`Electron exited: ${stderr}`);
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return targets.find(
        (target) => target.type === 'page' && target.url.startsWith('http://127.0.0.1:'),
      );
    }, 'Cannot connect to desktop');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    socket.addEventListener('message', (event) => {
      const response = JSON.parse(event.data);
      const promise = pending.get(response.id);
      if (promise) {
        pending.delete(response.id);
        response.error
          ? promise.reject(new Error(response.error.message))
          : promise.resolve(response.result);
      }
    });
    socket.addEventListener('close', () => {
      for (const promise of pending.values()) promise.reject(new Error('Debugger closed'));
      pending.clear();
    });
    const call = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const request = ++id,
          timer = setTimeout(() => {
            pending.delete(request);
            reject(new Error(`Debugger timed out: ${method}`));
          }, 15000);
        pending.set(request, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        socket.send(JSON.stringify({ id: request, method, params }));
      });
    const evaluate = async (expression) => {
      const value = await call('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (value.exceptionDetails)
        throw new Error(
          value.exceptionDetails.exception?.description ?? value.exceptionDetails.text,
        );
      return value.result.value;
    };
    await until(() => evaluate("!!document.querySelector('.project-home')"), 'Home did not mount');
    return {
      evaluate,
      call,
      async close() {
        try {
          await call('Page.close');
        } catch {}
        socket.close();
        const done = await Promise.race([exit, delay(5000).then(() => 'timeout')]);
        if (done === 'timeout') {
          child.kill();
          await exit;
        }
        await writeFile(path.join(root, 'desktop-stderr.log'), stderr);
      },
    };
  } catch (error) {
    socket?.close();
    if (!exited) child.kill();
    await exit;
    throw error;
  }
}
const report = { packaged, root, checks: [] };
let desktop = await launch();
const check = (name, value) => {
  assert.ok(value, name);
  report.checks.push(name);
};
const click = (label) =>
  desktop.evaluate(
    `Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim().startsWith(${JSON.stringify(label)})).click()`,
  );
const capture = () =>
  until(
    () => desktop.evaluate('window.vmotionDesktop.captureTestWindow()'),
    'Hidden window did not produce a frame',
    5000,
  );
const formSet = (label, value) =>
  desktop.evaluate(`(() => {
  const field=Array.from(document.querySelectorAll('.new-project-form label')).find(label=>label.firstChild.textContent.trim()===${JSON.stringify(label)}).querySelector('input,select');
  Object.getOwnPropertyDescriptor(field.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(String(value))});
  field.dispatchEvent(new Event(field.tagName==='SELECT'?'change':'input',{bubbles:true}));
})()`);
try {
  check(
    'launches project home',
    await desktop.evaluate(
      "location.hash === '#/welcome' && document.body.innerText.includes('新建项目')",
    ),
  );
  check('does not mount demo editor', await desktop.evaluate("!document.querySelector('.topbar')"));
  const homeImage = await capture();
  await writeFile(path.join(root, 'home.png'), Buffer.from(homeImage, 'base64'));
  await desktop.call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'n',
    code: 'KeyN',
    modifiers: 2,
  });
  await desktop.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'n', code: 'KeyN' });
  await until(
    () => desktop.evaluate("!!document.querySelector('.new-project-form')"),
    'Ctrl+N did not open creation',
  );
  await until(
    () => desktop.evaluate("document.querySelector('.project-directory input').value.length > 0"),
    'No default directory',
  );
  await formSet('项目名称', '空白动画');
  await formSet('保存位置', projects);
  await formSet('宽度', '1280');
  await formSet('高度', '720');
  await formSet('帧率', '30000/1001');
  await formSet('初始时长（秒）', '12');
  const formImage = await capture();
  await writeFile(path.join(root, 'new-project.png'), Buffer.from(formImage, 'base64'));
  await click('创建并打开');
  await until(
    () =>
      desktop.evaluate(
        "document.querySelector('.project-title')?.textContent.includes('空白动画')",
      ),
    'Blank creation did not open editor',
  );
  const manifest = JSON.parse(
    await readFile(path.join(projects, '空白动画/project.vmotion.json'), 'utf8'),
  );
  const scene = JSON.parse(
    await readFile(path.join(projects, '空白动画/scenes/intro.json'), 'utf8'),
  );
  check('creates real blank scene', scene.nodes.length === 0);
  const rawPreview = await desktop.evaluate(
    `(async()=>{const response=await fetch('/api/frame?frame=0&width=320&height=180&format=rgba');const bytes=await response.arrayBuffer();const image=new ImageData(new Uint8ClampedArray(bytes),320,180),bitmap=await createImageBitmap(image),canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();return {format:response.headers.get('X-Vmotion-Format'),bytes:bytes.byteLength,alpha:canvas.getContext('2d').getImageData(0,0,1,1).data[3]};})()`,
  );
  check(
    'browser presents lossless RGBA preview',
    rawPreview.format === 'rgba' && rawPreview.bytes === 320 * 180 * 4 && rawPreview.alpha === 255,
  );
  check(
    'saves chosen canvas and rational fps',
    manifest.width === 1280 &&
      manifest.height === 720 &&
      manifest.fps.num === 30000 &&
      manifest.fps.den === 1001,
  );
  const seq = JSON.parse(
    await readFile(path.join(projects, '空白动画/sequences/main.json'), 'utf8'),
  );
  check('saves initial duration', seq.duration === 360);
  const state = await desktop.evaluate(
    "fetch('/api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'state'})}).then(r=>r.json())",
  );
  check(
    'blank project reaches shared service',
    state.result.snapshot.scenes[0].nodes.length === 0 && state.result.diagnostics.length === 0,
  );
  const revision = state.result.snapshot.revision;
  const fail = await desktop.evaluate(
    `window.vmotionDesktop.openProject(${JSON.stringify(path.join(root, 'missing'))}).then(()=>null,error=>error.message)`,
  );
  check('invalid open reports error', typeof fail === 'string' && fail.length > 0);
  const after = await desktop.evaluate(
    "fetch('/api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'state'})}).then(r=>r.json())",
  );
  check(
    'invalid open retains active project',
    after.result.snapshot.revision === revision && after.result.root === state.result.root,
  );
  await click('新建');
  await until(
    () => desktop.evaluate("!!document.querySelector('.new-project-form')"),
    'Editor creation entry failed',
  );
  await until(
    () => desktop.evaluate("document.querySelector('.project-directory input').value.length > 0"),
    'No directory',
  );
  await formSet('项目名称', '空白动画');
  await formSet('保存位置', projects);
  await click('创建并打开');
  await until(
    () =>
      desktop.evaluate(
        "document.querySelector('.project-form-error')?.textContent.includes('empty')",
      ),
    'Existing directory was not rejected',
  );
  check(
    'duplicate creation preserves existing project',
    (await readFile(path.join(projects, '空白动画/scenes/intro.json'), 'utf8')) ===
      JSON.stringify(scene, null, 2) + '\n',
  );
  await formSet('项目名称', '科普动画');
  await formSet('起始内容', 'science');
  await click('创建并打开');
  await until(
    () =>
      desktop.evaluate(
        "document.querySelector('.project-title')?.textContent.includes('科普动画')",
      ),
    'Science creation failed',
  );
  check(
    'science template is optional',
    JSON.parse(
      await readFile(path.join(projects, '科普动画/scenes/intro.json'), 'utf8'),
    ).nodes.some((node) => node.id === 'wave'),
  );
  await desktop.evaluate('document.querySelector(\'[aria-label="项目首页"]\').click()');
  await until(
    () =>
      desktop.evaluate(
        "document.querySelector('.recent-projects')?.innerText.includes('空白动画')",
      ),
    'Recent projects did not appear',
  );
  check(
    'records both projects',
    await desktop.evaluate("document.querySelectorAll('.recent-projects > button').length === 2"),
  );
  await desktop.close();
  desktop = await launch();
  check('restart defaults to home', await desktop.evaluate("location.hash === '#/welcome'"));
  await until(
    () => desktop.evaluate("document.querySelectorAll('.recent-projects > button').length === 2"),
    'Recent projects did not persist',
  );
  await desktop.evaluate(
    "Array.from(document.querySelectorAll('.recent-projects > button')).find(button=>button.textContent.includes('空白动画')).click()",
  );
  await until(
    () =>
      desktop.evaluate(
        "document.querySelector('.project-title')?.textContent.includes('空白动画')",
      ),
    'Recent reopen failed',
  );
  check('reopens chosen project after restart', true);
  if (process.argv.includes('--sound')) {
    await click('素材');
    await until(
      () => desktop.evaluate(`!!document.querySelector('[aria-label="新建声音"]')`),
      'Sound creation button is missing',
    );
    await desktop.evaluate(`document.querySelector('[aria-label="新建声音"]').click()`);
    await until(
      () => desktop.evaluate(`document.querySelectorAll('.sound-roll rect').length===4`),
      'Sound editor did not load',
    );
    check('opens independent editable music score', true);
    await desktop.evaluate(
      `document.querySelector('.sound-roll rect').dispatchEvent(new MouseEvent('click',{bubbles:true}))`,
    );
    await until(
      () =>
        desktop.evaluate(
          `Array.from(document.querySelectorAll('.sound-note-controls label')).some(label=>label.textContent.includes('MIDI 音高'))`,
        ),
      'Note selection failed',
    );
    await desktop.evaluate(
      `(()=>{const field=Array.from(document.querySelectorAll('.sound-note-controls label')).find(label=>label.textContent.includes('MIDI 音高')).querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'67');field.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await click('试听草稿');
    await until(
      () =>
        desktop.evaluate(
          `document.querySelector('.sound-editor audio')?.src.startsWith('data:audio/wav;base64,')`,
        ),
      'Candidate audition did not produce playable audio',
      30000,
    );
    const soundImage = await capture();
    await writeFile(path.join(root, 'sound-editor.png'), Buffer.from(soundImage, 'base64'));
    check(
      'auditions unsaved music without changing the project',
      JSON.parse(await readFile(path.join(projects, '空白动画/project.vmotion.json'), 'utf8'))
        .assets.length === 0,
    );
    await click('保存到素材库');
    await until(
      () =>
        desktop.evaluate(
          `!document.querySelector('.sound-editor')&&document.querySelector('.asset-row strong')?.textContent==='新乐曲'`,
        ),
      'Sound publication did not update the asset library',
    );
    const soundProject = JSON.parse(
        await readFile(path.join(projects, '空白动画/project.vmotion.json'), 'utf8'),
      ),
      soundAsset = soundProject.assets.find((a) => a.soundSource),
      soundDoc = JSON.parse(
        await readFile(path.join(projects, '空白动画', soundAsset.soundSource), 'utf8'),
      );
    check(
      'saves selected note to an editable library resource',
      soundDoc.tracks[0].events[0].note === 67,
    );
    await click('加入主时间轴');
    await until(
      () =>
        desktop.evaluate(
          `Array.from(document.querySelectorAll('.tl-clip')).some(clip=>clip.textContent.includes('新乐曲'))`,
        ),
      'Sound did not reach the timeline',
    );
    check(
      'places published music on an audio track',
      JSON.parse(
        await readFile(path.join(projects, '空白动画/sequences/main.json'), 'utf8'),
      ).tracks.some((t) => t.type === 'audio' && t.clips.some((c) => c.assetId === soundAsset.id)),
    );
  }
  if (process.argv.includes('--visual')) {
    await click('动画');
    await desktop.evaluate(`document.querySelector('[aria-label="Shape"]').click()`);
    await until(
      () =>
        desktop.evaluate(
          `!!document.querySelector('.inspector-heading')||document.querySelector('.inspector').innerText.includes('Rect')`,
        ),
      'Shape selection failed',
    );
    await click('效果');
    await until(
      () => desktop.evaluate(`!!document.querySelector('[aria-label="添加效果"]')`),
      'Effect inspector not mounted',
    );
    for (const type of ['bloom', 'gradientMap', 'radialRays']) {
      await desktop.evaluate(
        `(()=>{const field=document.querySelector('[aria-label="添加效果"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(field,${JSON.stringify(type)});field.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      );
      await until(async () => {
        const state = await desktop.evaluate(
          `fetch('/api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'state'})}).then(r=>r.json())`,
        );
        return state.result.snapshot.scenes[0].nodes.some((node) =>
          node.effects.some((effect) => effect.type === type),
        );
      }, `Effect ${type} was not saved`);
    }
    check('adds editable bloom/gradient map/rays through the desktop inspector', true);
    const visualImage = await capture();
    await writeFile(path.join(root, 'visual-effects.png'), Buffer.from(visualImage, 'base64'));
  }
  const editorImage = await capture();
  await writeFile(path.join(root, 'editor.png'), Buffer.from(editorImage, 'base64'));
} catch (error) {
  try {
    await writeFile(path.join(root, 'failure.png'), Buffer.from(await capture(), 'base64'));
    report.failure = await desktop.evaluate(
      `({hash:location.hash,text:document.body.innerText.slice(-6000)})`,
    );
  } catch {}
  throw error;
} finally {
  await desktop.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
