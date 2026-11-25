function makeMarkHistory() {
  const layers={red:new Map(),blue:new Map()}, past=[], future=[];
  const same=(a,b)=>a?.symbol===b?.symbol && a?.level===b?.level;
  function record(change) {
    if(!change.length) return false;
    past.push(change); future.length=0; return true;
  }
  function write(change,undo=false) {
    for(const [color,cell,before,after] of change) {
      const value=undo?before:after;
      if(value) layers[color].set(cell,value); else layers[color].delete(cell);
    }
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
    blueStroke(start,mark) {
      const after=same(layers.blue.get(start),mark)?undefined:mark;
      const seen=new Set(), change=[];
      let finished=false;
      return {
        visit(cell) {
          if(finished || seen.has(cell)) return false;
          seen.add(cell);
          const before=layers.blue.get(cell);
          if(same(before,after)) return false;
          const entry=['blue',cell,before,after];
          change.push(entry);write([entry]);return true;
        },
        finish() {if(!finished) {finished=true;return record(change);}}
      };
    },
    clear(color) {return edit(color,[...layers[color].keys()].map(i=>[i]));},
    clearDeductions(level) {
      const advanced=[...layers.blue].filter(([,m])=>m.level>1);
      const rank=level??advanced.reduce((n,[,m])=>Math.max(n,m.level),0);
      return edit('blue',advanced.filter(([,m])=>m.level===rank && ['ʌ','//'].includes(m.symbol)).map(([i])=>[i]));
    },
    get canUndo() {return !!past.length;}, get canRedo() {return !!future.length;},
    undo() {if(past.length) {const change=past.pop();write(change,true);future.push(change);}},
    redo() {if(future.length) {const change=future.pop();write(change);past.push(change);}}
  };
}

function makeManualBatch(state,flags,selectTargets) {
  const targets=selectTargets(state,flags), marked=new Map();
  return {
    marked,
    get total() {return targets.size;},
    get done() {return targets.size>0 && marked.size===targets.size;},
    record(cells,kind) {
      const wrong=cells.find(i=>state[i]!==kind);
      if(wrong!==undefined) return {wrong,state:state[wrong]};
      for(const i of cells) if(targets.has(i)) marked.set(i,kind);
      return {done:targets.size>0 && marked.size===targets.size,total:targets.size};
    },
    cells(kind) {return [...marked].filter(([,value])=>value===kind).map(([i])=>i).sort((a,b)=>a-b);}
  };
}

// A staged step has exactly two UI phases: collect every red mark, then commit the complete batch.
function manualStepAction(batch) {
  return batch?.done ? 'commit' : 'stage';
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

if(typeof module!=='undefined') module.exports=Object.assign(makeMarkHistory,{makeManualBatch,manualStepAction,inkTrails,inkPath});

function makeBoardInput({$,icon,say,canAct,getGame,changed,menu,closeReason}) {
  const flower=$('markFlower'), launcher=$('markMenu');
  const rows=[[['x','拟定为雷'],['o','拟推为雷'],['v','拟定为雷'],['ʌ','拟推为雷'],['+','提高层级']],
    [['s','拟定安全'],['/','拟推安全'],['e','拟定安全'],['//','拟推安全'],['−','降低层级']]];
  const advanced=s=>['v','ʌ','e','//'].includes(s), buttons=new Map();
  let selected='',level=2,hold,suppress,stroke;
  function history() {
    const notes=getGame()?.notes;
    const visible=!(flower.inert && !selected);
    $('markHistory').classList.toggle('is-inactive',!visible);
    $('markHistory').setAttribute('aria-hidden',String(!visible));
    $('markHistory').inert=!visible;
    $('undoMark').disabled=!notes?.canUndo;
    $('redoMark').disabled=!notes?.canRedo;
  }
  function refresh() {
    for(const [symbol,{button,label}] of buttons) {
      const rank=advanced(symbol)?level:0;
      button.innerHTML=symbol==='cursor'?icon('cursorIcon'):`${symbol}${rank>2?`<sub>${rank}</sub>`:''}`;
      button.title=button.ariaLabel=rank?`第 ${rank} 层：${label}`:label;
      if(symbol==='−') button.title+=level===2?'（长按清除第二层拟推）':'（长按清除最高层拟推）';
      if(!['+','−','cursor'].includes(symbol)) button.setAttribute('aria-pressed',String(selected===symbol));
    }
    $('board').classList.toggle('writing-ink',!!selected);
    history();
  }
  function endStroke() {if(stroke) {stroke.edit.finish();stroke=undefined;history();}}
  function close() {endStroke();selected='';menu('mark',false);refresh();}
  function bindHold(button,action,click) {
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
      if(!blocked) click();
    };
  }
  function add(symbol,label,root,arc) {
    const button=document.createElement('button');
    button.type='button'; button.className=arc?'orb mark-option':'orb black center'; button.dataset.ink=symbol;
    if(arc) for(const [name,value] of Object.entries(arc)) button.style.setProperty(`--${name}`,value);
    buttons.set(symbol,{button,label}); root.append(button);
    const activate=()=>{
      if(symbol==='cursor') {close();say('');launcher.focus({preventScroll:true}); return;}
      if(!canAct()) return;
      endStroke();
      if(symbol==='+' || symbol==='−') {level=Math.min(99,Math.max(2,level+(symbol==='+'?1:-1)));say(`拟定层级 ${level}`);}
      else {
        selected=symbol;say(button.title);
      }
      refresh();
    };
    if(symbol==='−') bindHold(button,()=>{endStroke();if(getGame().notes.clearDeductions(level===2?level:undefined)) changed();history();},activate);
    else button.onclick=activate;
  }
  add('cursor','返回游玩',flower);
  const radius=96;
  const points=[-75,-47.5,-20,7.5,35].map(deg=>{
    const angle=deg*Math.PI/180;
    return [Math.round(radius*Math.cos(angle)),Math.round(radius*Math.sin(angle))];
  });
  for(const [side,id] of [[-1,'inkTrackLeft'],[1,'inkTrackRight']]) {
    $(id).setAttribute('d',`M ${side*points[0][0]} ${points[0][1]} ${points.slice(1).map(([x,y])=>`A ${radius} ${radius} 0 0 ${side>0?1:0} ${side*x} ${y}`).join(' ')}`);
  }
  for(const [side,row] of rows.entries()) for(const [i,[symbol,label]] of row.entries()) {
    const [x,y]=points[i];
    add(symbol,label,flower,{x:`${side?x:-x}px`,y:`${y}px`});
  }
  bindHold(launcher,()=>{
    endStroke();
    if(getGame().notes.clear('blue')) {changed();say('已清空蓝色记号。');}
    history();
  },()=>{
    if(!canAct()) return;
    if(!flower.inert) {close();return;}
    closeReason();
    menu('mark',true);refresh();buttons.get('x').button.focus({preventScroll:true});
  });
  function stamp(i,erase=false) {
    if(!selected && (flower.inert || !erase)) return false;
    if(canAct()) {
      endStroke();
      const g=getGame(), notes=g.notes;
      g.focus=i;
      const existing=notes.layers.blue.get(i), levelForMark=advanced(selected)?level:0;
      const mark=erase || existing?.symbol===selected && existing?.level===levelForMark?undefined:{symbol:selected,level:levelForMark};
      if(notes.edit('blue',[[i,mark]])) changed(i);
      history();
    }
    return true;
  }
  function startStroke(i) {
    if(!selected || !canAct()) return false;
    endStroke();
    const game=getGame();
    game.focus=i;
    stroke={game,edit:game.notes.blueStroke(i,{symbol:selected,level:advanced(selected)?level:0})};
    return true;
  }
  function drawStroke(cells) {
    if(!stroke || stroke.game!==getGame() || !canAct()) {endStroke();return;}
    let last;
    for(const i of cells) if(stroke.edit.visit(i)) last=i;
    if(last!==undefined) changed(last);
  }
  $('undoMark').onclick=()=>{if(canAct()) {endStroke();getGame().notes.undo();changed();history();}};
  $('redoMark').onclick=()=>{if(canAct()) {endStroke();getGame().notes.redo();changed();history();}};
  refresh();
  return {close,reset:()=>{level=2;close();},stamp,startStroke,drawStroke,endStroke,erase:i=>stamp(i,true),get writing(){return !!selected;}};
}
