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
    enabled:[660], ink:[480], ready:[587,784], commit:[440,660], flag:[590], rejected:[220], won:[523,659,784]
  };
  const Audio=window.AudioContext || window.webkitAudioContext;
  let context, output, enabled=false, last=-Infinity;
  toggle.disabled=!Audio;

  function sound(kind) {
    if (!enabled || context?.state!=='running') return;
    const now=context.currentTime;
    const time=performance.now();
    if (kind==='ink' && time-last<85) return;
    last=time;
    for (const [i,hz] of notes[kind].entries()) {
      const start=now+i*.055, end=start+.105;
      const tone=context.createOscillator(), gain=context.createGain();
      tone.type=kind==='rejected'?'sine':'triangle';
      tone.frequency.value=hz;
      gain.gain.setValueAtTime(.001,start);
      gain.gain.exponentialRampToValueAtTime(.062,start+.013);
      gain.gain.exponentialRampToValueAtTime(.001,end);
      tone.connect(gain).connect(output);
      tone.onended=()=>{tone.disconnect();gain.disconnect();};
      tone.start(start); tone.stop(end);
    }
  }

  function reflect() {
    toggle.setAttribute('aria-pressed',String(enabled));
    toggle.querySelector('use').setAttribute('href',enabled?'#volumeOn':'#volumeOff');
    toggle.title=enabled?'关闭反馈音效':'开启反馈音效';
  }
  toggle.addEventListener('click',async()=>{
    if (!Audio) return;
    enabled=!enabled;
    reflect();
    if (!enabled) { if (output) output.gain.value=0; return; }
    try {
      if (!context) {
        context=new Audio();
        output=context.createGain();
        output.connect(context.destination);
      }
      output.gain.value=1;
      if (context.state!=='running') await context.resume();
      sound('enabled');
    } catch {
      enabled=false;
      reflect();
    }
  });
  return {visual,tile,clearRejection,handoff,sound};
}
