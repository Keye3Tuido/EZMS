// 将画笔的指针和按键交互转成标记操作，并同步工具状态。
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

if(typeof module!=='undefined') {
  const marks=require('./model/mark-model');
  module.exports=Object.assign(marks.makeMarkHistory,marks,require('./view/ink-view'));
}
