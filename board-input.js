function makeMarkHistory() {
  const layers={red:new Map(),blue:new Map(),archivedBlue:new Map()}, past=[], future=[];
  const same=(a,b)=>a?.symbol===b?.symbol && a?.level===b?.level;
  function record(change) {
    if(Array.isArray(change) && !change.length) return false;
    past.push(change); future.length=0; return true;
  }
  function write(change,undo=false) {
    if(!Array.isArray(change)) {
      change.apply(undo);
      return 'confirmation';
    }
    for(const [color,cell,before,after] of change) {
      const value=undo?before:after;
      if(value) layers[color].set(cell,value); else layers[color].delete(cell);
    }
    return true;
  }
  function edit(color,entries) {
    const change=[];
    for(const [cell,after] of entries) {
      const before=layers[color].get(cell);
      if(!same(before,after)) change.push([color,cell,before,after]);
    }
    write(change); return record(change);
  }
  return {
    layers,edit,
    recordConfirmation(apply) {
      apply(false);
      record({apply});
    },
    discardConfirmations() {
      for(const stack of [past,future]) for(let i=stack.length-1;i>=0;i--) {
        if(!Array.isArray(stack[i])) stack.splice(i,1);
      }
    },
    discardRedo() {future.length=0;},
    stroke(color,start,mark) {
      const after=same(layers[color].get(start),mark)?undefined:mark;
      const seen=new Set(), change=[];
      let finished=false;
      return {
        visit(cell) {
          if(finished || seen.has(cell)) return false;
          seen.add(cell);
          const before=layers[color].get(cell);
          if(same(before,after)) return false;
          const entry=[color,cell,before,after];
          change.push(entry);write([entry]);return true;
        },
        finish() {if(!finished) {finished=true;return record(change);}}
      };
    },
    discardRed(cells) {
      for(const cell of cells) layers.red.delete(cell);
    },
    discardCells(cells) {
      const discarded=new Set(cells);
      for(const layer of Object.values(layers)) for(const cell of discarded) layer.delete(cell);
      // Opening a cell must not bring its marks back through undo or redo.
      for(const stack of [past,future]) for(let i=stack.length-1;i>=0;i--) {
        if(!Array.isArray(stack[i])) continue;
        const change=stack[i].filter(([,cell])=>!discarded.has(cell));
        if(change.length) stack[i]=change; else stack.splice(i,1);
      }
    },
    clear(color) {return edit(color,[...layers[color].keys()].map(i=>[i]));},
    clearBlue() {
      const color=layers.blue.size?'blue':'archivedBlue';
      return edit(color,[...layers[color].keys()].map(i=>[i]));
    },
    archiveBlue(covered=()=>true) {
      const change=[];
      const initialize=![...layers.archivedBlue.keys()].some(covered);
      let archived=false;
      for(const [cell,mark] of layers.blue) {
        change.push(['blue',cell,mark,undefined]);
        if(!covered(cell)) continue;
        const symbol=['x','o','v','ʌ'].includes(mark.symbol)?'o':['s','/','e','//'].includes(mark.symbol)?'/':null;
        if(!symbol) continue;
        const before=layers.archivedBlue.get(cell);
        if(!initialize && !before) continue;
        if(before?.symbol!==symbol) {
          change.push(['archivedBlue',cell,before,before?undefined:{symbol,level:0}]);
          archived=true;
        }
      }
      write(change);
      return record(change)?(archived?'archived':'cleared'):false;
    },
    clearDeductions(level) {
      const advanced=[...layers.blue].filter(([,m])=>m.level>1);
      const rank=level??advanced.reduce((n,[,m])=>Math.max(n,m.level),0);
      return edit('blue',advanced.filter(([,m])=>m.level===rank && ['ʌ','//'].includes(m.symbol)).map(([i])=>[i]));
    },
    get canUndo() {return !!past.length;}, get canRedo() {return !!future.length;},
    undo() {
      if(!past.length) return;
      const change=past.pop();
      future.push(change);
      return write(change,true);
    },
    redo() {
      if(!future.length) return;
      const change=future.pop();
      past.push(change);
      return write(change);
    }
  };
}

function makeManualBatch(state,flags,selectTargets,history) {
  const marked=new Map();
  let targets;
  function refreshTargets() {targets=selectTargets(state,flags);}
  function done() {return targets.size>0 && marked.size===targets.size;}
  function record(entries,from) {
    const wrong=entries.find(([i,kind])=>state[i]!==kind);
    if(wrong) return {wrong:wrong[0],state:state[wrong[0]]};
    const additions=new Map(entries.filter(([i])=>targets.has(i) && !marked.has(i)));
    const movesFlag=from!==undefined && flags.has(from);
    if(additions.size || movesFlag) {
      const apply=undo=>{
        if(movesFlag) {
          if(undo) flags.add(from); else flags.delete(from);
          refreshTargets();
        }
        for(const [i,kind] of additions) {
          if(undo) marked.delete(i); else marked.set(i,kind);
        }
      };
      if(history) history.recordConfirmation(apply); else apply(false);
    }
    return {done:done(),total:targets.size};
  }
  refreshTargets();
  return {
    marked,refreshTargets,
    get total() {return targets.size;},
    get done() {return done();},
    record(cells,kind,from) {return record(cells.map(i=>[i,kind]),from);},
    recordStep(safe,mines) {return record([...safe.map(i=>[i,'safe']),...mines.map(i=>[i,'mine'])]);},
    cells(kind) {return [...marked].filter(([,value])=>value===kind).map(([i])=>i).sort((a,b)=>a-b);}
  };
}

// A staged step has exactly two UI phases: collect every red mark, then commit the complete batch.
function manualStepAction(batch) {
  return batch?.done ? 'commit' : 'stage';
}

function checkPositionMarks(state,flags,red) {
  const issues=[];
  const check=(cell,expected,mark)=>{
    const actual=state[cell];
    if(actual===expected || expected==='safe' && actual==='open') return;
    issues.push({cell,mark,conflict:actual==='open' || actual==='safe' || actual==='mine'});
  };
  for(const cell of flags) check(cell,'mine','flag');
  for(const [cell,mark] of red) check(cell,mark.symbol==='x'?'mine':'safe',mark.symbol==='x'?'cross':'slash');
  return issues;
}

function restoreManualMarks(state,flags,selectTargets,notes) {
  const batch=makeManualBatch(state,flags,selectTargets,notes);
  for(const [cell,mark] of notes.layers.red) batch.record([cell],mark.symbol==='x'?'mine':'safe');
  notes.discardRed(notes.layers.red.keys());
  return batch.marked.size?batch:null;
}

function inkTrails(cells,width) {
  const all=new Set([...cells].sort((a,b)=>a-b)), paths=[];
  const neighbors=i=>[...(i%width?[i-1]:[]),...(i%width<width-1?[i+1]:[]),i-width,i+width].filter(v=>all.has(v));
  const closes=trail=>trail.length>2 && neighbors(trail[0]).includes(trail.at(-1));
  for(const start of all) {
    const component=[start], seen=new Set(component);
    for(const i of component) for(const v of neighbors(i)) if(!seen.has(v)) {seen.add(v);component.push(v);}
    const edges=component.flatMap(i=>neighbors(i).filter(v=>i<v).map(v=>[i,v]));
    edges.sort(([a,b],[c,d])=>neighbors(a).length+neighbors(b).length-neighbors(c).length-neighbors(d).length || a-c || b-d);
    const links=new Map(component.map(i=>[i,[]]));
    const wouldCycle=(a,b)=>{
      let previous=-1;
      while(a!==undefined) {
        if(a===b) return true;
        const next=links.get(a).find(i=>i!==previous);
        previous=a; a=next;
      }
      return false;
    };
    const ends=(a,b)=>links.get(a).length<2 && links.get(b).length<2 && !wouldCycle(a,b);
    const append=(a,b)=>{links.get(a).push(b);links.get(b).push(a);};
    const take=()=>{
      const used=new Set(), result=[];
      for(const i of component) if(links.get(i).length<2 && !used.has(i)) {
        const trail=[];
        for(let v=i;v!==undefined;v=links.get(v).find(x=>!used.has(x))) {used.add(v);trail.push(v);}
        result.push(trail);
      }
      return result.sort((a,b)=>b.length-a.length);
    };
    const direction=(a,b)=>[Math.sign(b%width-a%width),Math.sign(Math.floor(b/width)-Math.floor(a/width))];
    const turns=(trail,closed)=>{
      if(trail.length<3) return 0;
      const edges=trail.slice(1).map((v,i)=>direction(trail[i],v));
      if(closed) edges.push(direction(trail.at(-1),trail[0]));
      let count=0;
      for(let i=1;i<edges.length;i++) if(edges[i][0]!==edges[i-1][0] || edges[i][1]!==edges[i-1][1]) count++;
      if(closed && edges.length>1 && (edges[0][0]!==edges.at(-1)[0] || edges[0][1]!==edges.at(-1)[1])) count++;
      return count;
    };
    const better=(a,b)=>{
      if(a.length!==b.length) return a.length<b.length;
      const ac=a.filter(closes), bc=b.filter(closes);
      if(ac.length!==bc.length) return ac.length>bc.length;
      const at=ac.reduce((sum,path)=>sum+turns(path,true),0), bt=bc.reduce((sum,path)=>sum+turns(path,true),0);
      if(at!==bt) return at<bt;
      const first=a.findIndex((path,i)=>path.length!==b[i].length);
      return first>=0 ? a[first].length>b[first].length : a.filter(closes).length>b.filter(closes).length;
    };
    let best=component.map(i=>[i]);
    for(const order of [edges,[...edges].sort(([a,b],[c,d])=>Number(a+1!==b)-Number(c+1!==d)),
      [...edges].sort(([a,b],[c,d])=>Number(a+1===b)-Number(c+1===d)),[...edges].reverse()]) {
      for(const i of component) links.get(i).length=0;
      for(const [a,b] of order) if(ends(a,b)) append(a,b);
      const result=take(); if(better(result,best)) best=result;
    }
    // Large components use bounded search so ink stays responsive during play.
    if(component.length<=18 || best.length>1) {
      for(const i of component) links.get(i).length=0;
      let remaining=component.length<=18?120000:4000;
      const improve=(at,count)=>{
        if(--remaining<0) return;
        if(count>=component.length-best.length) {
          const result=take();
          if(better(result,best)) best=result;
        }
        if(at===edges.length) return;
        if(count+edges.length-at<component.length-best.length) return;
        const [a,b]=edges[at];
        if(ends(a,b)) {append(a,b);improve(at+1,count+1);links.get(a).pop();links.get(b).pop();}
        improve(at+1,count);
      };
      improve(0,0);
    }
    for(const cells of best) paths.push({cells,closed:closes(cells)});
    for(const i of component) all.delete(i);
  }
  return paths;
}

function inkPath(points,tile,offset=0,closed=false) {
  const unit=([x,y],[u,v])=>[Math.sign(u-x),Math.sign(v-y)];
  const move=([x,y],[u,v],distance)=>[x+u*distance,y+v*distance];
  const parallel=(p,[x,y])=>move(p,[-y,x],offset);
  const extent=tile*.33;
  if(points.length===1) {
    const [x,y]=points[0];
    return `M${x-extent},${y+offset}H${x+extent}`;
  }
  const sides=points.slice(1).map((p,i)=>unit(points[i],p));
  if(closed) sides.push(unit(points.at(-1),points[0]));
  const start=sides[0],last=sides.at(-1);
  const radius=tile*.27;
  let d=`M${move(parallel(points[0],start),start,closed?radius:-extent)}`;
  for(let i=1;i<(closed?points.length+1:points.length-1);i++) {
    const at=i%points.length, before=sides[i-1], after=sides[at];
    if(before[0]===after[0] && before[1]===after[1]) continue;
    const p=points[at], corner=parallel(parallel(p,before),after);
    const a=move(parallel(p,before),before,-radius), b=move(parallel(p,after),after,radius);
    d+=`L${a}Q${corner} ${b}`;
  }
  return closed?d+'Z':d+`L${move(parallel(points.at(-1),last),last,extent)}`;
}

if(typeof module!=='undefined') module.exports=Object.assign(makeMarkHistory,{makeManualBatch,manualStepAction,checkPositionMarks,restoreManualMarks,inkTrails,inkPath});

const inkShapes=new Map([
  ['x','<path d="M4 4L20 20M20 4L4 20"/>'],
  ['o','<circle cx="12" cy="12" r="10"/>'],
  ['s','<path d="M20 5C17 1 6 1 5 7C4 12 20 11 20 17C19 23 8 23 4 19"/>'],
  ['e','<path d="M3 12H21C21 6 17 2 12 2C7 2 3 6 3 12C3 18 7 22 13 22C16 22 18 21 20 19"/>'],
  ['v','<path d="M3 3L11 20Q12 22 13 20L21 3"/>'],
  ['ʌ','<path d="M3 21L11 4Q12 2 13 4L21 21"/>'],
]);
function inkGlyph(symbol) {
  const shape=inkShapes.get(symbol);
  return shape?`<svg class="ink-glyph" viewBox="0 0 24 24" aria-hidden="true">${shape}</svg>`:'';
}

function makeBoardInput({$,icon,say,canAct,getGame,changed,confirmationChanged,sound,menu,closeReason}) {
  const flower=$('markFlower'), launcher=$('markMenu');
  const rows=[[['x','拟定为雷'],['o','拟推为雷'],['v','拟定为雷'],['ʌ','拟推为雷'],['+','提高层级']],
    [['s','拟定安全'],['/','拟推安全'],['e','拟定安全'],['//','拟推安全'],['−','降低层级']]];
  const advanced=s=>['v','ʌ','e','//'].includes(s), buttons=new Map();
  let selected='',level=2,hold,suppress,stroke,red=false;
  const color=()=>red?'red':'blue';
  const redLabels={x:'标记为雷（笔记）','/':'标记为安全（笔记）'};
  function history() {
    const notes=getGame()?.notes;
    const visible=!flower.inert || !!selected || !!notes?.canUndo || !!notes?.canRedo;
    const active=canAct();
    $('markHistory').classList.toggle('is-inactive',!visible);
    $('markHistory').setAttribute('aria-hidden',String(!visible));
    $('markHistory').inert=!visible;
    $('undoMark').disabled=!active || !notes?.canUndo;
    $('redoMark').disabled=!active || !notes?.canRedo;
  }
  function refresh() {
    for(const [symbol,{button,label}] of buttons) {
      const rank=advanced(symbol)?level:0;
      button.innerHTML=`${inkGlyph(symbol)||symbol}${rank>2?`<sub>${rank}</sub>`:''}`;
      button.title=rank?`第 ${rank} 层：${label}`:(red && redLabels[symbol] || label);
      if(symbol==='+') button.title=`${label}（长按取交集）`;
      if(symbol==='−') button.title+=level===2?'（长按清除第二层拟推）':'（长按清除最高层拟推）';
      button.ariaLabel=button.title;
      button.hidden=red && !redLabels[symbol];
      if(!['+','−','cursor'].includes(symbol)) button.setAttribute('aria-pressed',String(selected===symbol));
    }
    $('board').classList.toggle('writing-ink',!!selected);
    history();
  }
  function endStroke() {if(stroke) {stroke.edit?.finish();stroke=undefined;history();}}
  function close() {
    if(hold) {clearTimeout(hold.timer);hold.button.classList.remove('holding');hold=undefined;}
    endStroke();selected='';menu('mark',false);refresh();
  }
  function bindHold(button,action,click) {
    button.dataset.soundHandled='';
    function cancel() {
      if(hold?.button!==button) return;
      clearTimeout(hold.timer); hold=undefined; button.classList.remove('holding');
    }
    button.onpointerdown=e=>{
      if(e.button!==0 || !e.isPrimary || !canAct()) return;
      suppress=undefined;
      const timer=setTimeout(()=>{
        suppress=button; button.classList.remove('holding'); if(canAct()) action();
      },650);
      hold={button,timer,id:e.pointerId,x:e.clientX,y:e.clientY};
      button.classList.add('holding');button.setPointerCapture(e.pointerId);
    };
    button.onpointermove=e=>{
      if(hold?.button===button && hold.id===e.pointerId && Math.hypot(e.clientX-hold.x,e.clientY-hold.y)>9) {suppress=button;cancel();}
    };
    button.onpointerup=button.onpointercancel=button.onlostpointercapture=cancel;
    button.oncontextmenu=e=>e.preventDefault();
    button.onclick=e=>{
      const blocked=e.detail!==0 && suppress===button;
      suppress=undefined;
      if(!blocked && canAct()) {sound('click');click();}
    };
  }
  function add(symbol,label,root,arc) {
    const button=document.createElement('button');
    button.type='button'; button.className=arc?'orb mark-option':'orb black center'; button.dataset.ink=symbol;
    if(arc) for(const [name,value] of Object.entries(arc)) button.style.setProperty(`--blue-${name}`,value);
    buttons.set(symbol,{button,label}); root.append(button);
    const activate=()=>{
      if(!canAct()) return;
      endStroke();
      if(symbol==='+' || symbol==='−') {level=Math.min(99,Math.max(2,level+(symbol==='+'?1:-1)));say(`拟定层级 ${level}`);}
      else {
        selected=selected===symbol?'':symbol;
        say(selected?button.title:'已取消记号工具。');
      }
      refresh();
    };
    if(symbol==='+') bindHold(button,()=>{
      endStroke();
      const game=getGame();
      const result=game.notes.archiveBlue(i=>game.visible[i]<0);
      if(result) {changed([],result==='archived'?'ink':'erase');say(result==='archived'?'已取交集，普通蓝标已清空。':'交集未变，普通蓝标已清空。');}
      else sound('click');
      history();
    },activate);
    else if(symbol==='−') bindHold(button,()=>{
      endStroke();
      const cleared=getGame().notes.clearDeductions(level===2?level:undefined);
      if(cleared) changed([],'erase'); else sound('click');
      const rank=level===2?'第二层':'最高层';
      say(cleared?`已清除${rank}拟推标记。`:`没有可清除的${rank}拟推标记。`);
      history();
    },activate);
    else button.onclick=activate;
  }
  for(const row of rows) for(const [symbol,label] of row) add(symbol,label,flower,{});
  bindHold(launcher,()=>{
    endStroke();
    const notes=getGame().notes, ordinary=notes.layers.blue.size>0;
    const cleared=red?notes.clear('red'):notes.clearBlue();
    if(cleared) {changed([],'erase');say(red?'已清空红色标记。':ordinary?'已清空蓝标。':'已清空绿色持久标。');}
    else {sound('click');if(red) say('没有可清空的红色标记。');}
    history();
  },()=>{
    if(!canAct()) return;
    if(!flower.inert) {close();return;}
    closeReason();
    menu('mark',true);refresh();launcher.focus({preventScroll:true});
  });
  function stamp(i,erase=false) {
    if(!selected && (flower.inert || !erase)) return false;
    if(canAct()) {
      endStroke();
      const g=getGame(), notes=g.notes;
      if(g.visible[i]>=0) {sound('click');return true;}
      g.focus=i;
      const existing=notes.layers[color()].get(i), levelForMark=advanced(selected)?level:0;
      const mark=erase || existing?.symbol===selected && existing?.level===levelForMark?undefined:{symbol:selected,level:levelForMark};
      if(notes.edit(color(),[[i,mark]])) changed([i],mark?'ink':'erase');
      else sound('click');
      history();
    }
    return true;
  }
  function startStroke(i) {
    if(!selected || !canAct()) return false;
    endStroke();
    const game=getGame();
    game.focus=i;
    stroke={game,color:color(),mark:{symbol:selected,level:advanced(selected)?level:0}};
    return true;
  }
  function drawStroke(cells) {
    if(!stroke || stroke.game!==getGame() || !canAct()) {endStroke();return;}
    const marked=[];
    for(const i of cells) {
      if(stroke.game.visible[i]>=0) continue;
      stroke.edit??=stroke.game.notes.stroke(stroke.color,i,stroke.mark);
      if(stroke.edit.visit(i)) marked.push(i);
    }
    if(marked.length) changed(marked,stroke.game.notes.layers[stroke.color].has(marked[0])?'ink':'erase');
  }
  function historyButton(id,kind) {
    const button=$(id);
    button.dataset.soundHandled='';
    button.onclick=()=>{
      if(!canAct()) return;
      endStroke();
      const result=getGame().notes[kind](), effect=kind==='undo'?'erase':'ink';
      if(result==='confirmation') confirmationChanged(effect);
      else if(result) changed([],effect);
      history();
    };
  }
  historyButton('undoMark','undo');
  historyButton('redoMark','redo');
  refresh();
  function reset(editing) {
    red=editing;level=2;
    flower.toggleAttribute('data-red-pen',red);
    launcher.toggleAttribute('data-red-pen',red);
    const label=red?'红色记号':'蓝色记号';
    launcher.title=launcher.ariaLabel=`${label}（长按清空）`;
    flower.ariaLabel=`${label}工具`;
    close();
  }
  return {close,reset,stamp,startStroke,drawStroke,endStroke,history,erase:i=>stamp(i,true),get writing(){return !!selected;}};
}
