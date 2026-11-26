function makeGameFullscreen(viewport, toggle, rotate, status) {
  const root = document.documentElement;
  const header = viewport.querySelector('header');
  const glyph = toggle.querySelector('path');
  const enterIcon = glyph.getAttribute('d');
  const exitIcon = 'M3 8h5V3m8 0v5h5m0 8h-5v5M8 21v-5H3';
  const native = () => (document.fullscreenElement ?? document.webkitFullscreenElement) === root;
  const touch = matchMedia('(pointer: coarse)');
  let mode = '', busy = false, statusTimer;
  let lockedOrientation, rotation;

  function sizeHeader() {
    if (mode) viewport.style.setProperty('--fullscreen-header-height', `${header.offsetHeight}px`);
  }
  new ResizeObserver(sizeHeader).observe(header);

  function showStatus(message) {
    clearTimeout(statusTimer);
    status.textContent = message;
    if (message) statusTimer = setTimeout(() => { status.textContent = ''; }, 5000);
  }

  function unlockOrientation(orientation) {
    try { orientation?.unlock?.(); }
    catch { /* The browser may already have ended the fullscreen session. */ }
  }

  function setMode(next) {
    if (mode === next) return;
    const previousRotation = rotation;
    rotation = undefined;
    rotate.removeAttribute('aria-disabled');
    unlockOrientation(lockedOrientation);
    if (previousRotation?.staleLock && previousRotation.orientation !== lockedOrientation) {
      unlockOrientation(previousRotation.orientation);
    }
    lockedOrientation = undefined;
    if (!next && document.activeElement === rotate) toggle.focus();
    mode = next;
    if (mode) root.dataset.fullscreenMode = mode;
    else delete root.dataset.fullscreenMode;
    sizeHeader();
    const label = mode === 'page' ? '退出网页内全屏' : mode ? '退出全屏' : '进入全屏';
    glyph.setAttribute('d', mode ? exitIcon : enterIcon);
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
    showStatus(mode === 'page' ? '浏览器未进入全屏，已切换到网页内模式。' : '');
  }

  function syncNative() {
    if (native()) setMode('native');
    else if (mode === 'native') setMode('');
  }

  document.addEventListener('fullscreenchange', syncNative);
  document.addEventListener('webkitfullscreenchange', syncNative);

  rotate.addEventListener('click', async () => {
    if (!mode || !touch.matches || rotation) return;
    const orientation = screen.orientation;
    const landscape = orientation?.type ? orientation.type.startsWith('landscape')
      : matchMedia('(orientation: landscape)').matches;
    const unavailable = '浏览器无法切换方向，请打开系统自动旋转后转动手机。';
    if (typeof orientation?.lock !== 'function') { showStatus(unavailable); return; }
    const request = rotation = {orientation, staleLock: false};
    rotate.setAttribute('aria-disabled', 'true');
    try {
      await orientation.lock(landscape ? 'portrait' : 'landscape');
      if (rotation === request) {
        lockedOrientation = orientation;
        showStatus('');
      } else if (rotation?.orientation === orientation) {
        // Unlocking here could cancel the new request; defer cleanup until it fails or exits.
        rotation.staleLock = true;
      } else if (lockedOrientation !== orientation) {
        unlockOrientation(orientation);
      }
    } catch {
      if (rotation === request) {
        if (request.staleLock && lockedOrientation !== orientation) unlockOrientation(orientation);
        showStatus(unavailable);
      }
    } finally {
      if (rotation === request) {
        rotation = undefined;
        rotate.removeAttribute('aria-disabled');
      }
    }
  });

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
            const changed = () => { if (native() !== leaving) finish(); };
            const failed = () => finish(new Error('Fullscreen unavailable'));
            const timer = setTimeout(failed, 1000);
            document.addEventListener(event, changed);
            document.addEventListener('webkitfullscreenerror', failed);
            try {
              const result = action.call(leaving ? document : root);
              if (result?.then) result.then(() => finish(), finish);
              else changed();
            } catch (error) { finish(error); }
          });
        } else if (leaving) await action.call(document);
        else await action.call(root, { navigationUI: 'hide' });
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
