const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {runInNewContext} = require('node:vm');

const source = readFileSync(`${__dirname}/game-fullscreen.js`, 'utf8');

function setup(install = () => {}) {
  const root = {dataset: {}};
  const document = Object.assign(new EventTarget(), {documentElement: root});
  const status = {textContent: ''};
  const header = {offsetHeight: 54};
  const viewport = {querySelector: () => header, style: {setProperty() {}}};
  const glyph = {getAttribute: () => 'enter', setAttribute() {}};
  let click;
  const toggle = {
    querySelector: () => glyph,
    setAttribute() {},
    addEventListener: (_, listener) => { click = listener; }
  };
  install(root, document);
  const controller = runInNewContext(`${source}\nmakeGameFullscreen(viewport, toggle, status)`, {
    document, viewport, toggle, status,
    navigator: {userAgent: 'Android Mobile'},
    matchMedia: () => ({matches: true}),
    ResizeObserver: class {observe() {}},
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      if (ms === 5000) timer.unref();
      return timer;
    },
    clearTimeout
  });
  return {root, document, status, toggle, controller, click: () => click(), mode: () => root.dataset.fullscreenMode};
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
