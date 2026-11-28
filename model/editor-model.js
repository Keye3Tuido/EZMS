// 编辑器的局面变换。返回操作结果，交由应用处理提示和重绘。
function makeEditorModel({engine,seeds,gameModel}) {
  let draft, parkedGame;
  function resize(game,{w,h},blank) {
    const old=game.board, translate=i=>{
      const x=i%old.w, y=Math.floor(i/old.w);
      return x<w && y<h ? y*w+x : -1;
    };
    const bits=Array(w*h).fill(0);
    if(!blank) for(let i=0;i<old.bombs.length;i++) {
      const at=translate(i);
      if(at>=0) bits[at]=Number(old.bombs[i])+2*Number(game.visible[i]>=0)+4*Number(game.flags.has(i));
    }
    let next;
    if(game.numbers) {
      const digits=Array(w*h).fill('.'), flags=[];
      if(!blank) for(const [i,n] of game.visible.entries()) {
        const at=translate(i);
        if(at<0) continue;
        if(n>=0) digits[at]=String(n);
        else if(game.flags.has(i)) flags.push(at);
      }
      next=seeds.numbers(w,h,blank?0:Math.min(old.mines,w*h),digits.join(''),flags);
    } else next=seeds.create(w,h,bits.join(''));
    if(!blank) next.notes=gameModel.noteEntries(game).map(layer=>layer.flatMap(([i,note])=>{
      const at=translate(i);
      return at>=0 ? [[at,note]] : [];
    }));
    return next;
  }

  function edit(g,i,tool,value) {
    const {board:b}=g, n=g.visible[i];
    g.focus=i;
    if(tool==='flag') {
      if(n>=0) return {status:'unchanged'};
      const removed=g.flags.delete(i);
      if(!removed) g.flags.add(i);
      return {status:'flag',sound:removed?'erase':'flag'};
    }
    let sound;
    if(tool==='number') {
      if(n===value) return {status:'unchanged'};
      g.visible[i]=value;
      sound=value<0?'erase':'ink';
    } else if(tool==='mine') {
      b.bombs[i]=!b.bombs[i];
      sound=b.bombs[i]?'ink':'erase';
      const delta=b.bombs[i]?1:-1;
      b.mines+=delta; g.p.mines=b.mines;
      if(b.bombs[i]) g.visible[i]=-1;
      for(const v of b.ns[i]) {
        b.clues[v]+=delta;
        if(g.visible[v]>=0) g.visible[v]=b.clues[v];
      }
    } else if(b.bombs[i]) return {status:'blocked'};
    else {
      if(n>=0) g.visible[i]=-1;
      else engine.reveal(b,g.visible,i,g.flags);
      sound=n>=0?'erase':'open';
    }
    b.opening=g.visible.flatMap((v,at)=>v>=0?[at]:[]);
    b.first=b.opening[0]??0;
    g.opened=b.opening.length;
    g.verification=g.current=g.witness=undefined;
    return {status:'changed',sound,opened:n<0 && g.visible[i]>=0?b.opening:[]};
  }

  function setMineCount(g,value) {
    const valid=Number.isInteger(value) && value>=0 && value<=g.visible.length;
    if(valid) g.board.mines=g.p.mines=value;
    g.witness=g.current=g.verification=undefined;
    return valid;
  }

  return {resize,edit,setMineCount,get draft() {return draft;},set draft(position) {draft=position;},
    get parkedGame() {return parkedGame;},set parkedGame(position) {parkedGame=position;}};
}

if(typeof module!=='undefined') module.exports=makeEditorModel;
