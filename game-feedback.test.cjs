const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {runInNewContext} = require('node:vm');

const source = readFileSync(`${__dirname}/game-feedback.js`, 'utf8');
const key = 'ms-sound-mode';
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup({settings = new Map(), resume, supported = true, storageBlocked = false} = {}) {
  const listeners = {}, starts = [], stops = [], contexts = [];
  function button() {
    return {
      attrs: {}, listeners: {},
      setAttribute(k,v) { this.attrs[k] = v; },
      querySelector() { return this; },
      addEventListener(k,f) { this.listeners[k] = f; }
    };
  }
  const toggle = button(), motion = button();
  class AudioContext {
    state = 'suspended';
    currentTime = 3;
    constructor() { contexts.push(this); }
    resume() {
      if(resume) return resume(this);
      this.state = 'running';
      return Promise.resolve();
    }
    createGain() {
      return {gain:{value:1,setValueAtTime(){},exponentialRampToValueAtTime(){}}, connect(){}, disconnect(){}};
    }
    createOscillator() {
      return {
        frequency:{}, connect(gain){return gain;}, disconnect(){},
        start(at){starts.push([at,this.frequency.value]);}, stop(at){stops.push(at);}
      };
    }
  }
  const feedback = runInNewContext(`${source}\nmakeGameFeedback(toggle,motion)`, {
    toggle, motion, window:supported?{AudioContext}:{},
    document:{
      documentElement:{dataset:{}},
      addEventListener(name, f){(listeners[name]??=[]).push(f);}
    },
    localStorage:{
      getItem(name){if(storageBlocked) throw Error(); return settings.get(name);},
      setItem(name,value){if(storageBlocked) throw Error(); settings.set(name,value);},
      removeItem(name){if(storageBlocked) throw Error(); settings.delete(name);}
    },
    performance:{now:()=>0}
  });
  function dispatch(name,{trusted=true, pointerType='mouse', target={disabled:false}}={}) {
    for(const fn of listeners[name]) fn({isTrusted:trusted,pointerType,target:{closest:selector=>selector.startsWith('button')?target:null}});
    if(name==='click' && target===toggle) toggle.listeners.click();
  }
  const click = ({handled=false,disabled=false}={}) => dispatch('click',{target:{disabled,closest:()=>handled}});
  return {feedback,toggle,contexts,starts,stops,dispatch,click,switchSound:()=>dispatch('click',{target:toggle})};
}

test('sound starts enabled but the page is silent until interaction; the first click is retained', async () => {
  const ui=setup();
  assert.equal(ui.toggle.attrs['aria-pressed'],'true');
  assert.equal(ui.toggle.attrs.href,'#volumeOn');
  assert.equal(ui.contexts.length,0);
  ui.click(); await tick();
  assert.equal(ui.contexts.length,1);
  assert.deepEqual(ui.starts,[[3,700]]);
});

test('mute stops scheduled tones, persists on reload, and unmuting plays once', async () => {
  const settings=new Map(), ui=setup({settings});
  ui.click(); await tick();
  ui.feedback.sound('ink',3);
  ui.switchSound();
  assert.equal(settings.get(key),'muted');
  assert.equal(ui.toggle.attrs['aria-pressed'],'false');
  assert.equal(ui.stops.filter(at=>at===undefined).length,4);
  const reloaded=setup({settings});
  reloaded.click();
  assert.equal(reloaded.contexts.length,0);
  reloaded.switchSound(); await tick();
  assert.equal(settings.has(key),false);
  assert.deepEqual(reloaded.starts,[[3,660]]);
});

test('a first touch can queue marks on press and play them after release', async () => {
  const ui=setup();
  ui.dispatch('pointerdown',{pointerType:'touch'});
  ui.feedback.sound('ink');
  assert.equal(ui.contexts.length,0);
  ui.dispatch('pointerup',{pointerType:'touch'});
  await tick();
  assert.deepEqual(ui.starts,[[3,480]]);
});

test('rapid marks retain distinct start times, with different sounds for ink and erase', async () => {
  const ui=setup();
  ui.dispatch('pointerdown'); await tick();
  ui.feedback.sound('ink',4);
  ui.feedback.sound('erase');
  ui.feedback.sound('ink',2);
  assert.deepEqual(ui.starts.map(([,hz])=>hz),[480,480,480,480,370,480,480]);
  assert.ok(ui.starts.every(([at],i)=>!i || at>ui.starts[i-1][0]));
});

test('disabled and individually handled controls do not receive a second, generic sound', async () => {
  const ui=setup();
  ui.click({disabled:true}); ui.click({handled:true});
  await tick();
  assert.deepEqual(ui.starts,[]);
});

test('failure to unlock audio leaves the preference enabled and allows another gesture to retry', async () => {
  let attempts=0;
  const ui=setup({resume(context){
    if(++attempts===1) return Promise.reject(Error());
    context.state='running';return Promise.resolve();
  }});
  ui.dispatch('keydown'); await tick();
  assert.equal(ui.toggle.attrs['aria-pressed'],'true');
  ui.click(); await tick();
  assert.equal(attempts,2);
  assert.deepEqual(ui.starts,[[3,700]]);
});

test('missing storage or a missing audio API does not prevent interaction', async () => {
  const blocked=setup({storageBlocked:true});
  blocked.click(); await tick();
  assert.equal(blocked.starts.length,1);
  blocked.switchSound();
  assert.equal(blocked.toggle.attrs['aria-pressed'],'false');
  const unavailable=setup({supported:false});
  unavailable.click();
  assert.equal(unavailable.toggle.disabled,true);
  assert.deepEqual(unavailable.starts,[]);
});
