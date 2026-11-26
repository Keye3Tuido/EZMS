const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {runInNewContext} = require('node:vm');

const source = readFileSync(`${__dirname}/game-fullscreen.js`, 'utf8');

function setup(install = () => {}, {orientation, touch = true, landscape = false} = {}) {
  const root = {dataset: {}};
  const document = Object.assign(new EventTarget(), {documentElement: root});
  const status = {textContent: ''};
  const header = {offsetHeight: 54};
  const viewport = {querySelector: () => header, style: {setProperty() {}}};
  const glyph = {getAttribute: () => 'enter', setAttribute() {}};
  let click, rotateClick, focused = false;
  const toggle = {
    querySelector: () => glyph,
    setAttribute() {},
    focus: () => { focused = true; },
    addEventListener: (_, listener) => { click = listener; }
  };
  const rotate = {
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
    addEventListener: (_, listener) => { rotateClick = listener; }
  };
  install(root, document);
  const controller = runInNewContext(`${source}\nmakeGameFullscreen(viewport, toggle, rotate, status)`, {
    document, viewport, toggle, rotate, status,
    screen: {orientation},
    matchMedia: query => ({matches: query === '(pointer: coarse)' ? touch : landscape}),
    ResizeObserver: class {observe() {}},
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      if (ms === 5000) timer.unref();
      return timer;
    },
    clearTimeout
  });
  return {root, document, status, rotate, controller, focused: () => focused,
    click: () => click(), rotateClick: () => rotateClick(), mode: () => root.dataset.fullscreenMode};
}

function nativeFullscreen(root, document) {
  root.requestFullscreen = async () => { document.fullscreenElement = root; };
  document.exitFullscreen = async () => { document.fullscreenElement = null; };
}

test('a phone tap requests native fullscreen during the click and a second tap exits it', async () => {
  let requests = 0;
  const ui = setup((root, document) => {
    root.requestFullscreen = async function (options) {
      assert.equal(this, root);
      assert.equal(options.navigationUI, 'hide');
      requests++;
      document.fullscreenElement = root;
      document.dispatchEvent(new Event('fullscreenchange'));
    };
    document.exitFullscreen = async function () {
      assert.equal(this, document);
      document.fullscreenElement = null;
      document.dispatchEvent(new Event('fullscreenchange'));
    };
  });
  const entered = ui.click();
  assert.equal(requests, 1);
  await entered;
  assert.equal(ui.mode(), 'native');
  assert.equal(ui.status.textContent, '');
  await ui.click();
  assert.equal(ui.mode(), undefined);
  assert.equal(ui.document.fullscreenElement, null);
});

test('leaving native fullscreen from the browser resets the game layout', async () => {
  const ui = setup((root, document) => {
    root.requestFullscreen = async () => { document.fullscreenElement = root; };
  });
  await ui.click();
  assert.equal(ui.mode(), 'native');
  ui.document.fullscreenElement = null;
  ui.document.dispatchEvent(new Event('fullscreenchange'));
  assert.equal(ui.mode(), undefined);
});

test('an absent or rejected request uses clearly labeled, escapable web-only mode', async () => {
  for (const request of [undefined, async () => { throw new Error('Fullscreen denied'); }, async () => {}]) {
    const ui = setup(root => { root.requestFullscreen = request; });
    await ui.click();
    assert.equal(ui.mode(), 'page');
    assert.match(ui.status.textContent, /浏览器未进入全屏/);
    assert.equal(ui.controller.escape(), true);
    assert.equal(ui.mode(), undefined);
    assert.equal(ui.status.textContent, '');
    await ui.click();
    await ui.click();
    assert.equal(ui.mode(), undefined);
  }
});

test('legacy WebKit confirms entry and exit with prefixed events', async () => {
  const ui = setup((root, document) => {
    root.webkitRequestFullscreen = () => setImmediate(() => {
      document.webkitFullscreenElement = root;
      document.dispatchEvent(new Event('webkitfullscreenchange'));
    });
    document.webkitExitFullscreen = () => setImmediate(() => {
      document.webkitFullscreenElement = null;
      document.dispatchEvent(new Event('webkitfullscreenchange'));
    });
  });
  await ui.click();
  assert.equal(ui.mode(), 'native');
  await ui.click();
  assert.equal(ui.mode(), undefined);
});

test('touch fullscreen only locks on a rotation tap and switches from the actual screen direction', async () => {
  const calls = [];
  const orientation = {
    type: 'landscape-secondary',
    async lock(direction) {
      calls.push(direction);
      this.type = `${direction}-primary`;
    },
    unlock() { calls.push('unlock'); }
  };
  const ui = setup(nativeFullscreen, {orientation});
  await ui.rotateClick();
  await ui.click();
  assert.deepEqual(calls, []);
  const pending = ui.rotateClick();
  assert.deepEqual(calls, ['portrait']);
  await ui.rotateClick();
  await pending;
  assert.deepEqual(calls, ['portrait']);
  await ui.rotateClick();
  ui.document.activeElement = ui.rotate;
  await ui.click();
  assert.deepEqual(calls, ['portrait', 'landscape', 'unlock']);
  assert.equal(ui.focused(), true);
});

test('desktop fullscreen ignores the rotation control', async () => {
  let locks = 0;
  const ui = setup(nativeFullscreen, {touch: false, orientation: {async lock() { locks++; }}});
  await ui.click();
  await ui.rotateClick();
  assert.equal(locks, 0);
});

test('missing and rejected rotation APIs give the same manual fallback', async () => {
  for (const orientation of [undefined, {async lock(direction) {
    assert.equal(direction, 'portrait');
    throw new Error('Orientation denied');
  }}]) {
    const ui = setup(undefined, {orientation, landscape: true});
    await ui.click();
    assert.equal(ui.mode(), 'page');
    await ui.rotateClick();
    assert.match(ui.status.textContent, /请打开系统自动旋转后转动手机/);
    ui.controller.escape();
    assert.equal(ui.status.textContent, '');
  }
});

test('a rotation that completes after browser exit is released without affecting the next session', async () => {
  let release, unlocks = 0;
  const orientation = {lock: () => new Promise(resolve => { release = resolve; }), unlock() { unlocks++; }};
  const ui = setup(nativeFullscreen, {orientation});
  await ui.click();
  const pending = ui.rotateClick();
  ui.document.fullscreenElement = null;
  ui.document.dispatchEvent(new Event('fullscreenchange'));
  assert.equal(ui.mode(), undefined);
  assert.equal(unlocks, 0);
  await ui.click();
  release();
  await pending;
  assert.equal(unlocks, 1);
  assert.equal(ui.mode(), 'native');
  assert.equal(ui.status.textContent, '');
});

for (const [staleOutcome, currentOutcome, staleFirst] of [
  ['resolve', 'resolve', true],
  ['reject', 'resolve', true],
  ['resolve', 'resolve', false],
  ['resolve', 'reject', true],
  ['resolve', 'exit', true]
]) {
  test(`old rotation ${staleOutcome}, new rotation ${currentOutcome} (old settles first: ${staleFirst})`, async () => {
    const requests = [];
    let unlocks = 0;
    const orientation = {
      lock: () => new Promise((resolve, reject) => { requests.push({resolve, reject}); }),
      unlock() { unlocks++; }
    };
    const ui = setup(nativeFullscreen, {orientation});
    const rotateIsBusy = () => ui.rotate.attributes.get('aria-disabled') === 'true';

    await ui.click();
    const stale = ui.rotateClick();
    assert.equal(rotateIsBusy(), true);
    await ui.click();
    assert.equal(rotateIsBusy(), false);
    await ui.click();
    const current = ui.rotateClick();
    assert.equal(requests.length, 2);
    assert.equal(rotateIsBusy(), true);

    if (!staleFirst) {
      requests[1].resolve();
      await current;
    }
    requests[0][staleOutcome](new Error('Stale rotation'));
    await stale;
    assert.equal(rotateIsBusy(), staleFirst);
    assert.equal(ui.status.textContent, '');
    assert.equal(unlocks, 0);

    if (staleFirst) {
      await ui.rotateClick();
      assert.equal(requests.length, 2);
      if (currentOutcome !== 'exit') {
        requests[1][currentOutcome](new Error('Rotation denied'));
        await current;
        assert.equal(rotateIsBusy(), false);
      }
    }
    if (currentOutcome === 'reject') {
      assert.match(ui.status.textContent, /请打开系统自动旋转后转动手机/);
      assert.equal(unlocks, 1);
    }
    await ui.click();
    assert.equal(unlocks, 1);
    assert.equal(rotateIsBusy(), false);
    if (currentOutcome === 'exit') {
      requests[1].reject(new Error('Fullscreen ended'));
      await current;
      assert.equal(ui.status.textContent, '');
    }
  });
}
