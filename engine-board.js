function makeMinesBoard() {
  'use strict';
  const range = n => Array.from({length:n}, (_, i) => i);
  const adj = (w,h) => range(w*h).map(i => {
    const ns=[], x=i%w, y=Math.floor(i/w);
    for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
      if((dx||dy) && x+dx>=0 && x+dx<w && y+dy>=0 && y+dy<h) ns.push(i+dy*w+dx);
    }
    return ns;
  });

  function random(seed) {
    let s=seed>>>0;
    return n => {
      s=(s+0x9e3779b9)>>>0;
      let x=Math.imul(s^(s>>>16),0x21f0aaad);
      x=Math.imul(x^(x>>>15),0x735a2d97);
      return Math.floor(((x^(x>>>15))>>>0)/4294967296*n);
    };
  }

  function candidate({w,h,mines,start,safe}, seed, ns=adj(w,h)) {
    const r=random(seed), first=start==='random' ? r(w*h) : Math.floor(h/2)*w+Math.floor(w/2);
    const blocked=new Set([first,...(safe==='zero'?ns[first]:[])]);
    const pool=range(w*h).filter(i=>!blocked.has(i));
    if(!Number.isInteger(mines) || mines<0 || mines>pool.length) return null;
    const bombs=Array(w*h).fill(false);
    for(let k=0;k<mines;k++) {
      const j=k+r(pool.length-k);
      [pool[k],pool[j]]=[pool[j],pool[k]];
      bombs[pool[k]]=true;
    }
    return {w,h,mines,first,seed,ns,bombs,clues:ns.map(row=>row.reduce((sum,i)=>sum+Number(bombs[i]),0))};
  }

  function reveal(board, visible, i, flags=new Set()) {
    if(board.bombs[i] || flags.has(i) || visible[i]>=0) return 0;
    const queue=[i];
    visible[i]=board.clues[i];
    for(let j=0;j<queue.length;j++) if(visible[queue[j]]===0) {
      for(const v of board.ns[queue[j]]) if(visible[v]<0) {
        visible[v]=board.clues[v];
        queue.push(v);
      }
    }
    return queue.length;
  }

  function opening(board) {
    const visible=Array(board.bombs.length).fill(-1);
    if(board.opening) {
      // Preprinted clues are individual givens.
      for(const i of board.opening) {
        if(!Number.isInteger(i) || i<0 || i>=visible.length || board.bombs[i]) throw Error('Invalid opening cell');
        reveal(board,visible,i);
      }
    } else reveal(board,visible,board.first);
    return visible;
  }

  function numberAction(ns, visible, flags, i, markOnly=false, confirmed) {
    const clue=visible[i];
    if(clue<0) return null;
    const covered=ns[i].filter(v=>visible[v]<0 && confirmed?.get(v)!=='safe');
    const cells=covered.filter(v=>!flags.has(v) && confirmed?.get(v)!=='mine');
    if(!cells.length) return null;
    if(covered.length===clue) return {kind:'flag',cells};
    if(!markOnly && covered.length-cells.length===clue) return {kind:'open',cells};
    return null;
  }

  return {range,adj,random,candidate,reveal,opening,numberAction};
}

if(typeof module!=='undefined') module.exports=makeMinesBoard;
