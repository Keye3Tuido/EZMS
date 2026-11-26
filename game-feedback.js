function makeGameFeedback(toggle, motionToggle) {
  const root=document.documentElement;
  function motionReduced(){return root.dataset.motionMode==='reduced';}
  function reflectMotion(){
    const enabled=!motionReduced();
    motionToggle.setAttribute('aria-pressed',String(enabled));
    motionToggle.title=enabled?'关闭动画效果':'开启动画效果';
  }
  try { if(localStorage.getItem('ms-motion-mode')==='reduced') root.dataset.motionMode='reduced'; }
  catch {}
  const activeAnimations = new Set();
  motionToggle.addEventListener('click',()=>{
    if(motionReduced()) delete root.dataset.motionMode;
    else {
      root.dataset.motionMode='reduced';
      for(const animation of activeAnimations) animation.cancel();
      activeAnimations.clear();
    }
    try { if(motionReduced()) localStorage.setItem('ms-motion-mode','reduced'); else localStorage.removeItem('ms-motion-mode'); }
    catch {}
    reflectMotion();
  });
  reflectMotion();
  const playing = new WeakMap();
  const ease = 'cubic-bezier(.24,.85,.27,1)';
  const frames = {
    board: [{opacity:.52,translate:'0 5px'},{opacity:1,translate:'0 0'}],
    open: [{opacity:1,scale:1},{opacity:.9,scale:.84,offset:.34},{opacity:0,scale:.68}],
    flag: [{opacity:0,translate:'0 -9px',scale:.72},{opacity:1,translate:'0 1px',scale:1.12,offset:.66},{opacity:1,translate:'0 0',scale:1}],
    rejected: [{opacity:1},{opacity:1,offset:.72,easing:ease},{opacity:0}],
    ink: [{opacity:.85,scale:.72},{opacity:1,scale:1,offset:.25},{opacity:0,scale:1}],
    handoff: [{opacity:1},{opacity:.8,offset:.23},{opacity:0}]
  };
  const durations={board:255,open:330,flag:310,rejected:1800,ink:350,handoff:218};
  function visual(kind,node,delay=0) {
    if (!node?.animate || motionReduced()) return;
    playing.get(node)?.cancel();
    const rejected=kind==='rejected';
    const animation=node.animate(frames[kind],{delay,duration:durations[kind],
      easing:rejected?'linear':ease,fill:rejected?'both':'backwards'});
    playing.set(node,animation);
    activeAnimations.add(animation);
    const release=()=>{
      activeAnimations.delete(animation);
      if(playing.get(node)===animation) playing.delete(node);
    };
    animation.finished.then(release,release);
    return animation;
  }

  const effects=new WeakMap();
  function clearRejection(cell) {
    const effect=effects.get(cell);
    if(effect?.kind==='rejected') effect.remove();
  }
  function tile(kind,cell,delay=0) {
    const rejected=kind==='rejected';
    if (!cell || (!rejected && (!cell.animate || motionReduced()))) return;
    effects.get(cell)?.remove();
    const effect=document.createElement('span');
    effect.className='tile-effect'; effect.dataset.effect=kind;
    effect.setAttribute('aria-hidden','true');
    cell.append(effect);
    const animation=visual(kind==='blue'?'ink':kind,effect,delay);
    let timer;
    const entry={kind,remove};
    effects.set(cell,entry);
    function remove() {
      clearTimeout(timer);
      if(animation && animation.playState!=='finished') animation.cancel();
      effect.remove();
      if(effects.get(cell)===entry) effects.delete(cell);
    }
    // Keep the warning visible even if motion is disabled while it is shown.
    if(rejected) timer=setTimeout(remove,durations.rejected);
    else if(animation) animation.finished.then(remove,remove);
    else remove();
  }

  function handoff(ink) {
    if (!ink?.animate || motionReduced() || !ink.querySelector('.red')) return;
    const previous=ink.cloneNode(false);
    previous.classList.add('retiring-ink');
    previous.append(...Array.from(ink.querySelectorAll('.red'),path=>path.cloneNode(false)));
    ink.before(previous);
    visual('handoff',previous).finished.then(()=>previous.remove(),()=>previous.remove());
  }

  const notes = {
    click:[700], enabled:[660], ink:[480], erase:[370], ready:[587,784], commit:[440,660],
    open:[530], flag:[590], rejected:[220], won:[523,659,784]
  };
  const Audio=window.AudioContext || window.webkitAudioContext;
  const preference='ms-sound-mode';
  let context, output, resuming, nextTap=0, enabled=!!Audio;
  const pendingSounds=[], activeTones=new Set();
  try { if(localStorage.getItem(preference)==='muted') enabled=false; }
  catch {}
  toggle.disabled=!Audio;

  function play(kind,count) {
    const now=context.currentTime;
    const light=kind==='click' || kind==='ink' || kind==='erase';
    const first=light?Math.max(now,nextTap):now;
    const spacing=Math.min(.040,.14/count)/(1+12*(first-now));
    if(light) nextTap=first+count*spacing;
    for(let i=0;i<count;i++) for (const [j,hz] of notes[kind].entries()) {
      const start=first+i*spacing+j*.055, end=start+(light ? .045 : .105);
      const tone=context.createOscillator(), gain=context.createGain();
      tone.type=kind==='rejected'?'sine':'triangle';
      tone.frequency.value=hz;
      gain.gain.setValueAtTime(.001,start);
      const volume=light?(kind==='click' ? .022 : .034)/Math.sqrt(Math.max(1,count/4)):.062;
      gain.gain.exponentialRampToValueAtTime(volume,start+(light ? .006 : .013));
      gain.gain.exponentialRampToValueAtTime(.001,end);
      tone.connect(gain).connect(output);
      activeTones.add(tone);
      tone.onended=()=>{activeTones.delete(tone);tone.disconnect();gain.disconnect();};
      tone.start(start); tone.stop(end);
    }
  }

  function flush() {
    if(!enabled || context?.state!=='running') return;
    for(const [kind,count,at] of pendingSounds.splice(0)) if(performance.now()-at<1000) play(kind,count);
  }

  function sound(kind,count=1) {
    if(!enabled || !count) return;
    if(context?.state==='running') {flush();play(kind,count);}
    else {
      if(pendingSounds.length===16) pendingSounds.shift();
      pendingSounds.push([kind,count,performance.now()]);
    }
  }

  function unlock() {
    if(!enabled || resuming) return;
    try {
      if(!context || context.state==='closed') {
        const audio=new Audio(), gain=audio.createGain();
        gain.connect(audio.destination);
        context=audio; output=gain; nextTap=0;
      }
      if(context.state==='running') {flush();return;}
      resuming=Promise.resolve(context.resume()).then(flush,()=>{}).finally(()=>{resuming=undefined;});
    } catch { /* Audio is optional; another gesture can retry. */ }
  }

  function clickTarget(event) {
    return event.target.closest?.('button,input[type=checkbox],input[type=radio],a[href]');
  }

  // Touch unlocks on pointer release; mouse, right click and keyboard can unlock earlier.
  for(const name of ['pointerdown','pointerup','keydown','contextmenu','click']) {
    document.addEventListener(name,event=>{
      if(!event.isTrusted || name==='pointerdown' && event.pointerType!=='mouse') return;
      if(name==='click' && clickTarget(event)===toggle) return;
      unlock();
    },true);
  }
  document.addEventListener('click',event=>{
    const target=clickTarget(event);
    if(target && target!==toggle && !target.disabled && !target.closest('[inert],[aria-disabled=true],[data-cell],[data-sound-handled]')) sound('click');
  },true);

  function reflect() {
    toggle.setAttribute('aria-pressed',String(enabled));
    toggle.querySelector('use').setAttribute('href',enabled?'#volumeOn':'#volumeOff');
    toggle.title=enabled?'关闭反馈音效':'开启反馈音效';
  }
  toggle.addEventListener('click',()=>{
    if (!Audio) return;
    enabled=!enabled;
    reflect();
    try {
      if(enabled) localStorage.removeItem(preference);
      else localStorage.setItem(preference,'muted');
    } catch {}
    if(!enabled) {
      if(output) output.gain.value=0;
      for(const tone of activeTones) tone.stop();
      pendingSounds.length=0;
      nextTap=0;
      return;
    }
    if(output) output.gain.value=1;
    unlock();
    sound('enabled');
  });
  reflect();
  return {visual,tile,clearRejection,handoff,sound};
}
