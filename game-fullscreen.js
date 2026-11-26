function makeGameFullscreen(viewport, toggle, status) {
  const root = document.documentElement;
  const header = viewport.querySelector('header');
  const glyph = toggle.querySelector('path');
  const enterIcon = glyph.getAttribute('d');
  const exitIcon = 'M3 8h5V3m8 0v5h5m0 8h-5v5M8 21v-5H3';
  const native = () => (document.fullscreenElement ?? document.webkitFullscreenElement) === root;
  let mode = '', busy = false;

  function sizeHeader() {
    if (mode) viewport.style.setProperty('--fullscreen-header-height', `${header.offsetHeight}px`);
  }
  new ResizeObserver(sizeHeader).observe(header);

  function setMode(next) {
    if (mode === next) return;
    mode = next;
    if (mode) root.dataset.fullscreenMode = mode;
    else delete root.dataset.fullscreenMode;
    sizeHeader();
    const label = mode === 'page' ? '退出网页内全屏' : mode ? '退出全屏' : '进入全屏';
    glyph.setAttribute('d', mode ? exitIcon : enterIcon);
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
    status.textContent = mode === 'page' ? '网页内全屏' : '';
  }

  function syncNative() {
    if (native()) setMode('native');
    else if (mode === 'native') setMode('');
  }

  document.addEventListener('fullscreenchange', syncNative);
  document.addEventListener('webkitfullscreenchange', syncNative);

  toggle.addEventListener('click', async () => {
    if (busy) return;
    if (mode === 'page') { setMode(''); return; }
    const leaving = native();
    const action = leaving ? document.exitFullscreen ?? document.webkitExitFullscreen
      : root.requestFullscreen ?? root.webkitRequestFullscreen;
    const event = action === root.webkitRequestFullscreen || action === document.webkitExitFullscreen
      ? 'webkitfullscreenchange' : 'fullscreenchange';
    busy = true;
    try {
      if (action) {
        // Older WebKit methods return void; wait until the fullscreen state actually changes.
        if (event === 'webkitfullscreenchange') {
          await new Promise((resolve, reject) => {
            const finish = error => {
              clearTimeout(timer);
              document.removeEventListener(event, changed);
              document.removeEventListener('webkitfullscreenerror', failed);
              if (error) reject(error); else resolve();
            };
            const changed = () => finish();
            const failed = () => finish(new Error('Fullscreen unavailable'));
            const timer = setTimeout(failed, 1000);
            document.addEventListener(event, changed);
            document.addEventListener('webkitfullscreenerror', failed);
            try {
              const result = action.call(leaving ? document : root);
              if (result) result.then(changed, finish);
              else if (native() !== leaving) changed();
            } catch (error) { finish(error); }
          });
        } else await action.call(leaving ? document : root);
      }
    } catch {
      // Fullscreen can be denied by the browser or by an embedding page.
    } finally {
      busy = false;
      syncNative();
    }
    if (!leaving && !native()) setMode('page');
  });

  return {
    escape() {
      if (mode !== 'page') return mode === 'native';
      setMode('');
      return true;
    }
  };
}
