function makeMinesGeneration(board,model,inference) {
  'use strict';
  const {range,adj,random,candidate,reveal,opening}=board;
  const {equivalentGroups,constraints,transferRows,classifyRows}=model;
  const {elementary,overlapProof,analyze,minimizeMove,openingProof,batchMove,
    compareDifficulty,summarizeSupports,verify}=inference;

  function compareOpening(a,b) {
    return compareDifficulty(a,b) ||
      b.openingClues-a.openingClues || Number(b.openingMinimum)-Number(a.openingMinimum) ||
      b.openingDepth-a.openingDepth || a.firstOpened-b.firstOpened;
  }

  const openingPlans = [
    {kind:'five-chain', weights:[1,-1,1,-1,1], links:[[0],[1],[2],[3]], ends:[0,4]},
    {kind:'fork', weights:[-1,1,1,1], links:[[0],[0],[0]], ends:[1,2,3]},
    {kind:'long-chain', weights:[1,-1,1,-1], links:[[0],[1],[2]], ends:[0,3]},
  ];

  function sharesCovered(a,b,ns,view) {
    return ns[a].some(v=>view[v]<0 && ns[b].includes(v));
  }

  function composeClues({w,h},count,seed,{balanced=false,preferLoops=false,splitNearHalf=false,exploreSplit=false,placementBudget=Infinity,blocks}={}) {
    if(!Number.isInteger(count) || count<1 || count>w*h) return null;
    const r=random(seed), uniform=n=>{
      const limit=4294967296-4294967296%n;
      let value;
      do {value=r(4294967296);} while(value>=limit);
      return value%n;
    };
    const key=(x,y)=>`${x},${y}`;
    function normalize(points) {
      const left=Math.min(...points.map(([x])=>x)), top=Math.min(...points.map(([,y])=>y));
      const shifted=points.map(([x,y])=>[x-left,y-top]).sort(([a,b],[c,d])=>b-d || a-c);
      return {points:shifted,w:Math.max(...shifted.map(([x])=>x))+1,h:shifted.at(-1)[1]+1};
    }
    function covered(x,y,clipped=false) {
      const cells=[];
      for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) if(dx || dy) {
        const a=x+dx,b=y+dy;
        if(!clipped || a>=0 && a<w && b>=0 && b<h) cells.push(key(a,b));
      }
      return cells;
    }
    function connected(points,clipped=false) {
      const occupied=new Set(points.map(([x,y])=>key(x,y))), owners=new Map();
      const links=points.map(()=>new Map());
      for(const [i,[x,y]] of points.entries()) for(const cell of covered(x,y,clipped)) {
        if(occupied.has(cell)) continue;
        if(!owners.has(cell)) owners.set(cell,[i]);
        else {
          const group=owners.get(cell);
          if(balanced && group.length>1) return false;
          const other=group[0], count=(links[i].get(other)??0)+1;
          links[i].set(other,count);links[other].set(i,count);
          group.push(i);
        }
      }
      const queue=[0], signs=new Map([[0,1]]);
      for(const i of queue) for(const [j,count] of links[i]) {
        const sign=-signs.get(i);
        if(balanced && (count<2 || signs.has(j) && signs.get(j)!==sign)) return false;
        if(!signs.has(j)) {signs.set(j,sign);queue.push(j);}
      }
      return signs.size===points.length;
    }
    function join(left,right,onBoard) {
      const occupied=new Set(left.points.map(([x,y])=>key(x,y)));
      const leftCells=new Map();
      for(const [i,[x,y]] of left.points.entries()) for(const cell of covered(x,y)) {
        if(!occupied.has(cell) && !leftCells.has(cell)) leftCells.set(cell,i);
      }
      const oriented=new Set(), placements=[], multiple=[];
      orientations: for(const swap of [false,true]) for(const sx of [1,-1]) for(const sy of [1,-1]) {
        const block=normalize(right.points.map(([x,y])=>swap?[sx*y,sy*x]:[sx*x,sy*y]));
        const id=block.points.join(';');
        if(oriented.has(id)) continue;
        oriented.add(id);
        if(block.w>w || block.h>h) continue;
        // 每个朝向只计算一次未开邻格。同一邻格可同时形成多条接缝。
        const open=new Set(block.points.map(([x,y])=>key(x,y))), boundary=new Map();
        for(const [i,[x,y]] of block.points.entries()) for(const cell of covered(x,y)) {
          if(open.has(cell)) continue;
          if(boundary.has(cell)) boundary.get(cell).shared=true;
          else {
            const [a,b]=cell.split(',').map(Number);
            boundary.set(cell,{a,b,owner:i,shared:false});
          }
        }
        const cells=[...boundary.values()];
        for(let dy=Math.max(-block.h-1,left.h-h);dy<=Math.min(left.h+1,h-block.h);dy++) {
          for(let dx=Math.max(-block.w-1,left.w-w);dx<=Math.min(left.w+1,w-block.w);dx++) {
            if(placementBudget--<=0) break orientations;
            if(block.points.some(([x,y])=>occupied.has(key(x+dx,y+dy)))) continue;
            let leftOwner, rightOwner, multi=false;
            for(const {a,b,owner,shared} of cells) {
              const other=leftCells.get(key(a+dx,b+dy));
              if(other===undefined) continue;
              if(preferLoops && (shared || leftOwner!==undefined && (leftOwner!==other || rightOwner!==owner))) {
                multi=true;
                break;
              }
              leftOwner=other;
              rightOwner=owner;
              if(!preferLoops) break;
            }
            if(!multi && leftOwner===undefined) continue;
            (multi?multiple:placements).push(block.points.map(([x,y])=>[x+dx,y+dy]));
          }
        }
      }
      // 在所有候选对接位置中随机选，允许多接缝，不能让新线索截断传递图。
      for(const options of [multiple,placements]) while(options.length) {
        const i=uniform(options.length), merged=left.points.concat(options[i]);
        options[i]=options.at(-1);
        options.pop();
        if(!connected(merged)) continue;
        const shape=normalize(merged);
        if(!onBoard) return shape;
        const givens=place(shape);
        if(givens) return {...shape,givens};
      }
      return null;
    }
    function build(size,reuse=true) {
      const cached=reuse && blocks?.get(size);
      if(cached) return {...cached.geometry,cached};
      if(size===1) return {points:[[0,0]],w:1,h:1};
      const half=Math.floor(size/2);
      let a=splitNearHalf?half:1+uniform(half);
      if(blocks && (reuse || !exploreSplit)) {
        const sizes=[...blocks.keys()].sort((a,b)=>b-a);
        // 优先选两边都能复用的拆分。否则用最大的已有子块，递归补齐余下部分。
        const pairs=sizes.filter(n=>n<size && n>=size-n && blocks.has(size-n));
        if(pairs.length) a=size-(splitNearHalf?pairs.at(-1):pairs[uniform(pairs.length)]);
        else a=size-sizes.find(n=>n<size);
      }
      const b=size-a, left=build(a), right=left && build(b);
      if(!right) return null;
      let merged=join(left,right,!reuse);
      // 长方形棋盘上，交换两轴后可用的接缝可能不同。
      if(!merged && placementBudget>0 && w!==h && left.w<=h && left.h<=w) {
        const transposed=normalize(left.points.map(([x,y])=>[y,x]));
        if(transposed.points.join(';')!==left.points.join(';')) merged=join(transposed,right,!reuse);
      }
      if(!merged) return null;
      const split=[a,b];
      if(!blocks) return {...merged,split};
      const parts=[left.cached,right.cached];
      if(reuse) {
        const child={geometry:merged,split,parts};
        blocks.set(size,child);
        return {...merged,cached:child};
      }
      return {...merged,split,parts};
    }
    function place(shape) {
      const spareX=w-shape.w, spareY=h-shape.h;
      const firstX=uniform(spareX+1), firstY=uniform(spareY+1);
      // 每轴只比较贴两侧边缘和留一格边距，其他偏移裁去的邻格相同。
      function offsets(first,spare) {
        const choices=new Set([first,0,spare]);
        if(spare>1 && (first===0 || first===spare)) choices.add(1);
        return choices;
      }
      const xs=offsets(firstX,spareX), ys=offsets(firstY,spareY);
      for(const y of ys) for(const x of xs) {
        const placed=shape.points.map(([dx,dy])=>[x+dx,y+dy]);
        if(connected(placed,true)) return placed.map(([a,b])=>a+b*w);
      }
    }
    const shape=build(count,false);
    if(!shape) return null;
    const {points,w:width,h:height,split=[],parts,givens=place(shape)}=shape;
    return blocks?{givens,split,parts,geometry:{points,w:width,h:height}}:{givens,split};
  }

  function seedComposed(p,ns,seed,mines,shape,balanced) {
    if(!shape || !mines || shape.givens.length>=ns.length-mines) return [];
    const {givens}=shape, opened=new Set(givens), config={...p,mines};
    const neighbors=givens.map(v=>ns[v].filter(u=>!opened.has(u)));
    const frontier=new Set(neighbors.flat()), outside=ns.length-givens.length-frontier.size;
    const memberships=new Map([...frontier].map(v=>[v,[]]));
    for(const [i,row] of neighbors.entries()) for(const v of row) memberships.get(v).push(i);
    const r=random(seed^0xbc1);
    for(let attempt=0;attempt<8;attempt++) {
      const signs=givens.map(()=>r(2)?1:-1), coefficients=new Int8Array(ns.length);
      if(balanced) {
        const queue=[0], seen=new Set(queue);
        for(const i of queue) for(const v of neighbors[i]) for(const j of memberships.get(v)) {
          if(!seen.has(j)) {signs[j]=-signs[i];seen.add(j);queue.push(j);}
        }
      }
      for(const [i,row] of neighbors.entries()) for(const v of row) coefficients[v]+=signs[i];
      // 改善接缝上的相消，同时用不同初值探索环和分支上的不同取向。
      for(let i=r(givens.length),n=0;n<2*givens.length;n++,i=(i+1)%givens.length) {
        const direction=2*signs[i], row=neighbors[i];
        const delta=row.reduce((sum,v)=>sum+Math.abs(coefficients[v]-direction)-Math.abs(coefficients[v]),0);
        if(delta<0) {
          signs[i]*=-1;
          for(const v of row) coefficients[v]-=direction;
        }
      }
      const map=new Int8Array(ns.length).fill(-1), view=Array(ns.length).fill(-1);
      for(const v of givens) map[v]=0;
      const joints=new Map();
      let forced=0, safe=0;
      for(const v of frontier) {
        const coefficient=coefficients[v];
        if(coefficient) {
          map[v]=Number(coefficient<0);
          forced+=map[v];
          safe+=1-map[v];
        } else {
          const key=memberships.get(v).join(',');
          if(!joints.has(key)) joints.set(key,[]);
          joints.get(key).push(v);
        }
      }
      if(!forced || !safe) continue;
      const adjustable=[];
      for(const cells of joints.values()) {
        const first=r(cells.length);
        if(cells.length>1) {
          map[cells[first]]=1;
          map[cells[(first+1)%cells.length]]=0;
          forced++;
        }
        adjustable.push(...cells.filter(v=>map[v]<0));
      }
      // 图外保留雷和空位，减少公开总雷数引入的短解。
      const margin=Number(outside>=2);
      const min=Math.max(0,mines-forced-outside+margin), max=Math.min(adjustable.length,mines-forced-margin);
      if(min>max) continue;
      const extra=min+r(max-min+1);
      for(let i=0;i<extra;i++) {
        const j=i+r(adjustable.length-i);
        [adjustable[i],adjustable[j]]=[adjustable[j],adjustable[i]];
      }
      for(const [i,v] of adjustable.entries()) map[v]=Number(i<extra);
      for(const [i,v] of givens.entries()) view[v]=neighbors[i].filter(u=>map[u]===1).length;
      if(givens.some(v=>view[v]===0)) continue;
      const context=constraints(config,view,new Set(),ns);
      if(context.invalid || elementary(context.rows,()=>true)) continue;
      const judgment=transferRows(view,context,16000);
      if(judgment.status!=='complete') continue;
      const move=analyze(config,view,new Set(),{ns}).move;
      if(!move) continue;
      const proof=openingProof(config,view,move,ns,judgment,{minimumBudget:24000});
      if(proof.positionMinimum && proof.sources.length>=3) return [{map,view,judgment,givens,composed:true}];
    }
    return [];
  }

  function seedCycle(p,ns,near,seed,mines,length,interior) {
    if(length>=ns.length-mines || length>mines) return [];
    const r=random(seed), n=ns.length, config={...p,mines}, marks=new Set();
    const allowed=v=>!interior || ns[v].length===8;
    const shared=(a,b)=>ns[a].filter(v=>ns[b].includes(v));
    const links=ns.map((_,a)=>near[a].filter(b=>allowed(b) && shared(a,b).length>=2));
    const shuffle=values=>{
      for(let i=values.length-1;i>0;i--) {
        const j=r(i+1);
        [values[i],values[j]]=[values[j],values[i]];
      }
      return values;
    };
    let budget=4500;
    const starts=[];
    function plant(givens) {
      const opened=new Set(givens), positive=[], negative=[], joints=[];
      const view=Array(n).fill(-1), map=new Int8Array(n).fill(-1);
      const rows=givens.map(v=>ns[v].filter(u=>!opened.has(u)));
      for(let i=0;i<length;i++) {
        const j=(i+1)%length, prev=(i+length-1)%length;
        const joint=rows[i].filter(v=>rows[j].includes(v));
        if(joint.length<2) return;
        joints.push(joint);
        for(const v of rows[i]) if(!rows[j].includes(v) && !rows[prev].includes(v)) {
          (i%2?negative:positive).push(v);
        }
      }
      if(!positive.length || !negative.length) return;
      const safe=r(2)?positive:negative, forced=safe===positive?negative:positive;
      const free=n-length-safe.length-forced.length-joints.reduce((sum,vs)=>sum+vs.length,0);
      // Leave room at both ends of the public mine count outside the cycle.
      const min=Math.max(length,mines-forced.length-free+1);
      const max=Math.min(joints.reduce((sum,vs)=>sum+vs.length-1,0),mines-forced.length-1);
      if(free<2 || min>max) return;
      for(const v of [...givens,...safe]) map[v]=0;
      for(const v of forced) map[v]=1;
      // Each joint can trade one mine in either direction if a clue is removed.
      const spare=[];
      for(const joint of joints) {
        const [mine,empty,...rest]=shuffle(joint);
        map[mine]=1;map[empty]=0;
        spare.push(...rest);
      }
      const extra=min+r(max-min+1)-length;
      for(const [i,v] of shuffle(spare).entries()) map[v]=Number(i<extra);
      for(const v of givens) view[v]=ns[v].filter(u=>map[u]===1).length;
      const context=constraints(config,view,marks,ns);
      if(context.invalid || elementary(context.rows,()=>true)) return;
      const move=overlapProof(context.local,(vs,value,level,proof)=>({vs,value,level,...proof}));
      if(!move) return;
      const judgment=classifyRows(view,context,120000,true);
      if(judgment.status!=='complete') return;
      const proof=openingProof(config,view,move,ns,judgment);
      if(proof.positionMinimum && proof.sources.length===length) starts.push({map,view,judgment,givens});
    }
    function extend(path) {
      if(--budget<0) return;
      const first=path[0], last=path.at(-1), closes=path.length===length-1;
      if(path.length===length) {plant(path);return;}
      for(const v of shuffle(links[last].filter(v=>!path.includes(v)))) {
        if(closes && !links[v].includes(first) || path.slice(closes?1:0,-1).some(u=>shared(u,v).length)) continue;
        extend([...path,v]);
        if(starts.length || budget<=0) return;
      }
    }
    // 四条直链用斜向接缝闭合。先尝试按长度直接摆放，余下尺寸交给局部搜索。
    if(length>=12) {
      const directions=[[1,0],[0,1],[-1,0],[0,-1]];
      const half=(length-4)/2;
      for(const width of shuffle(range(half-1).map(v=>v+1))) {
        const height=half-width;
        const path=[[0,0]];
        function step(dx,dy) {
          const [x,y]=path.at(-1);
          path.push([x+dx,y+dy]);
        }
        for(const [i,[dx,dy]] of directions.entries()) {
          for(let j=0;j<(i%2?height:width);j++) step(2*dx,2*dy);
          const [nx,ny]=directions[(i+1)%4];
          step(2*dx+nx,2*dy+ny);
        }
        path.pop();
        const minX=Math.min(...path.map(([x])=>x)), minY=Math.min(...path.map(([,y])=>y));
        const spanX=Math.max(...path.map(([x])=>x))-minX, spanY=Math.max(...path.map(([,y])=>y))-minY;
        const margin=Number(interior), roomX=p.w-spanX-2*margin, roomY=p.h-spanY-2*margin;
        if(roomX<=0 || roomY<=0) continue;
        const flipX=r(2),flipY=r(2), ox=margin+r(roomX),oy=margin+r(roomY);
        plant(path.map(([x,y])=>{
          x-=minX;y-=minY;
          return ox+(flipX?spanX-x:x)+p.w*(oy+(flipY?spanY-y:y));
        }));
        if(starts.length) return starts;
      }
    }
    for(const first of shuffle(range(n).filter(allowed))) {
      extend([first]);
      if(starts.length || budget<=0) break;
    }
    return starts;
  }

  function seedOpening(p,ns,near,seed,mines,plan,interior,compact) {
    const r=random(seed), n=ns.length, config={...p,mines}, marks=new Set();
    const allowed=v=>!interior || ns[v].length===8;
    const first=range(n).filter(allowed);
    if(!first.length) return [];
    const visible=Array(n).fill(-1), core=[first[r(first.length)]];
    for(const links of plan.links) {
      const pool=near[core[links[0]]].filter(v=>allowed(v) && !core.includes(v) &&
        core.every((u,i)=>near[u].includes(v)===links.includes(i)));
      if(!pool.length) return [];
      core.push(pool[r(pool.length)]);
    }
    const validCore=view=>core.slice(1).every((v,j)=>core.slice(0,j+1).every((u,i)=>
      sharesCovered(u,v,ns,view)===plan.links[j].includes(i)));
    const used=new Set(core), weights=new Int8Array(n);
    const ring=[...new Set(core.flatMap(v=>ns[v]))].filter(v=>!used.has(v));
    for(const [i,v] of core.entries()) for(const u of ns[v]) weights[u]+=plan.weights[i];
    for(const v of core) visible[v]=0;
    if(!validCore(visible)) return [];

    const clue=(v,map)=>ns[v].reduce((sum,u)=>sum+Number(map[u]===1),0);
    function evaluate(view,map) {
      let fixed=0, free=0;
      for(const x of map) {fixed+=Number(x===1);free+=Number(x<0);}
      if(fixed>mines || fixed+free<mines) return null;
      const rows=constraints(config,view,marks,ns);
      if(rows.invalid || elementary(rows.rows,()=>true)) return null;
      const judgment=classifyRows(view,rows,6000);
      return judgment.status==='complete' ? judgment : null;
    }
    let best;
    for(let i=0;i<8;i++) {
      const map=new Int8Array(n).fill(-1), view=visible.slice(), sign=r(2)?1:-1, density=20+r(61);
      for(const v of core) map[v]=0;
      // Saturate the signed sum at its lower bound. Only cancelled cells
      // can vary without invalidating the intended deduction.
      for(const v of ring) map[v]=Number(sign*weights[v]<0 || !weights[v] && r(100)<density);
      for(const v of core) view[v]=clue(v,map);
      const judgment=evaluate(view,map);
      if(judgment && (!best || judgment.depth>best.judgment.depth)) best={map,view,judgment,givens:core};
      if(best?.judgment.depth>=(compact?1:7)) break;
    }
    if(!best) return [];

    const qualified=[];
    const layers=compact?1:5;
    for(let layer=0;layer<=layers;layer++) {
      qualified.push(best);
      if(layer===layers) break;
      const {map,view,givens}=best;
      // Start from the proof's tips. Each additional clue commits only
      // its previously unassigned cells and leaves the old numbers intact.
      const tips=[...plan.ends.map(i=>core[i]),...givens.slice(core.length)];
      const pool=[...new Set(tips.flatMap(v=>near[v]))].filter(v=>
        view[v]<0 && map[v]!==1 && ns[v].filter(u=>map[u]<0).length>=3 &&
        tips.some(u=>sharesCovered(v,u,ns,view)));
      let next;
      for(let i=0;i<12 && pool.length;i++) {
        const v=pool[r(pool.length)], state=map.slice(), trial=view.slice(), density=24+r(44);
        state[v]=0;
        for(const u of ns[v]) if(state[u]<0) state[u]=Number(r(100)<density);
        trial[v]=clue(v,state);
        if(!validCore(trial)) continue;
        const judgment=evaluate(trial,state);
        if(!judgment || judgment.depth<best.judgment.depth-1) continue;
        if(!next || judgment.depth>next.judgment.depth || judgment.depth===next.judgment.depth &&
          judgment.maxDepth>next.judgment.maxDepth) next={map:state,view:trial,judgment,givens:[...givens,v]};
      }
      if(!next) break;
      best=next;
    }
    qualified.sort((a,b)=>b.judgment.depth-a.judgment.depth || b.judgment.maxDepth-a.judgment.maxDepth);
    return qualified.filter(item=>{
      const move=analyze(config,item.view,marks,{ns}).move;
      if(move?.sources.length!==core.length || !core.every(v=>move.sources.includes(v))) return false;
      const proof=openingProof(config,item.view,move,ns,item.judgment);
      return proof.positionMinimum && core.every(v=>proof.sources.includes(v));
    });
  }

  function seedCompact(p,ns,seed,mines) {
    const n=ns.length, r=random(seed), config={...p,mines}, marks=new Set();
    const map=new Int8Array(n).fill(-1), view=Array(n).fill(-1), givens=[];
    const largest=ns.reduce((max,row)=>Math.max(max,row.length),0);
    const centers=range(n).filter(v=>ns[v].length>=largest-2);
    // Keep old clues fixed and assign only the newly exposed neighborhood.
    while(givens.length<Math.min(7,n-mines-1)) {
      const choices=givens.length?range(n).filter(v=>view[v]<0 && map[v]!==1):centers;
      if(!choices.length) break;
      const pool=choices.filter(v=>ns[v].some(u=>map[u]<0));
      const cells=pool.length?pool:choices;
      const v=cells[r(cells.length)], ring=ns[v].filter(u=>map[u]<0);
      map[v]=0;
      let free=0, remaining=mines;
      for(const x of map) {free+=Number(x<0);remaining-=Number(x===1);}
      if(remaining<0 || remaining>free) break;
      const lo=Math.max(0,remaining-free+ring.length), hi=Math.min(remaining,ring.length);
      const count=lo+r(hi-lo+1);
      for(let i=0;i<count;i++) map[ring.splice(r(ring.length),1)[0]]=1;
      for(const u of ring) map[u]=0;
      view[v]=ns[v].filter(u=>map[u]===1).length;
      givens.push(v);
      const move=analyze(config,view,marks,{ns}).move;
      if(!move) continue;
      const judgment=classifyRows(view,constraints(config,view,marks,ns),120000);
      if(judgment.status!=='complete') break;
      const proof=openingProof(config,view,move,ns,judgment);
      if(proof.positionMinimum) return [{map,view,givens,judgment}];
      break;
    }
    return [];
  }

  function compactOverlap(p,ns,near,seed,mines,hard) {
    const n=ns.length, r=random(seed), config={...p,mines}, marks=new Set();
    const starts=[];
    for(let trial=0;trial<(hard?64:5);trial++) {
      const givens=[r(n)], signs=[1], size=hard?4+r(5):3+r(3);
      if(size>=n-mines) continue;
      while(givens.length<size) {
        const allowed=[...new Set(givens.flatMap(v=>near[v]))].filter(v=>!givens.includes(v));
        if(!allowed.length) break;
        const v=allowed[r(allowed.length)];
        const parent=hard ? givens.map((u,i)=>({i,n:ns[u].filter(x=>ns[v].includes(x)).length}))
          .sort((a,b)=>b.n-a.n)[0].i : 0;
        givens.push(v);
        signs.push(hard && r(4) ? -signs[parent] : r(2)?1:-1);
      }
      if(givens.length!==size || signs.every(s=>s===1)) continue;
      const weights=new Int8Array(n), map=new Int8Array(n).fill(-1), view=Array(n).fill(-1);
      const ring=[...new Set(givens.flatMap(v=>ns[v]))].filter(v=>!givens.includes(v));
      for(const [i,v] of givens.entries()) {
        map[v]=0;
        for(const u of ns[v]) weights[u]+=signs[i];
      }
      const sign=r(2)?1:-1, variable=ring.filter(v=>weights[v]===0);
      let forced=0;
      for(const v of ring) if(weights[v]!==0) forced+=(map[v]=Number(sign*weights[v]<0));
      // Spending one unit of slack keeps coefficients of magnitude two or
      // more forced, without forcing every cell in the uncancelled region.
      if(hard && r(2) && ring.some(v=>Math.abs(weights[v])>=2)) {
        const unit=ring.filter(v=>Math.abs(weights[v])===1);
        if(unit.length) {
          const v=unit[r(unit.length)];
          forced+=1-2*map[v];
          map[v]=1-map[v];
        }
      }
      const free=n-givens.length-ring.length;
      const lo=Math.max(0,mines-forced-free), hi=Math.min(variable.length,mines-forced);
      if(lo>hi) continue;
      const fill=lo+r(hi-lo+1);
      for(let i=0;i<fill;i++) map[variable.splice(r(variable.length),1)[0]]=1;
      for(const v of variable) map[v]=0;
      for(const v of givens) view[v]=ns[v].filter(u=>map[u]===1).length;
      const context=constraints(config,view,marks,ns);
      if(context.invalid || elementary(context.rows,()=>true)) continue;
      const move=analyze(config,view,marks,{ns}).move;
      if(!move) continue;
      const judgment=classifyRows(view,context,120000);
      if(judgment.status!=='complete') continue;
      const proof=openingProof(config,view,move,ns,judgment);
      if(proof.positionMinimum) starts.push({map,view,givens,judgment,clues:proof.sources.length});
    }
    return hard ? starts.sort((a,b)=>b.clues-a.clues || b.judgment.depth-a.judgment.depth).slice(0,3) : starts;
  }

  function construct(p,seed,ns,mines,openingSeed,continuation,hard) {
    const r=random(seed), n=ns.length;
    const config={...p,mines};
    const number=(state,v)=>ns[v].reduce((a,i)=>a+Number(state[i]===1),0);
    const amountOpen=view=>view.reduce((a,v)=>a+Number(v>=0),0);
    const {givens}=openingSeed;
    let {map,view:visible}=continuation??openingSeed, marks=new Set(continuation?.marks);
    const forks=[];
    let retries=hard?16:10;
    const analyses=new Map();
    function nextMove(view,known) {
      // Different tentative layouts can publish the same clues.
      const key=view.join(',')+':'+[...known].sort((a,b)=>a-b).join(',');
      if(!analyses.has(key)) {
        if(analyses.size>=512) analyses.delete(analyses.keys().next().value);
        analyses.set(key,analyze(config,view,known,{ns}).move);
      }
      return analyses.get(key);
    }

    function commitRing(state,ring,scale) {
      let free=0, remaining=mines;
      for(const v of state) {free+=Number(v<0);remaining-=Number(v===1);}
      if(remaining<0||remaining>free) return false;
      const max=Math.min(remaining,ring.length), min=Math.max(0,remaining-free+ring.length);
      const count=Math.max(min,Math.min(max,Math.round(ring.length*remaining/Math.max(1,free)*scale)));
      for(let k=0;k<count;k++) state[ring.splice(r(ring.length),1)[0]]=1;
      for(const v of ring) state[v]=0;
      return true;
    }

    function directedRings(fixed,view,known,targets,edge,swaps) {
      const fresh=new Set(targets), free=new Set(edge);
      const uncovered=v=>view[v]<0 && !fresh.has(v) && !known.has(v);
      const rows=range(n).filter(v=>view[v]>=0 || fresh.has(v)).map(v=>({v,vs:ns[v].filter(uncovered)}))
        .filter(({vs})=>vs.length>=2);
      const byCell=new Map();
      for(const row of rows) for(const v of row.vs) {
        if(!byCell.has(v)) byCell.set(v,[]);
        byCell.get(v).push(row);
      }
      for(const row of rows) row.links=[...new Set(row.vs.flatMap(v=>byCell.get(v)))];
      const options=new Map(), seen=new Set();
      let budget=hard?900:300;
      const maxSize=hard?6:4;
      // Search clue combinations, then force only the free cells required to reach their bound.
      function expand(group,weights) {
        const key=group.map((row,i)=>[row.v,weights[i]]).sort(([a],[b])=>a-b).join(';');
        if(!budget || seen.has(key)) return;
        seen.add(key);
        budget--;
        if(group.length>=3) {
          const terms=new Map();
          for(const [i,row] of group.entries()) for(const v of row.vs) terms.set(v,(terms.get(v)??0)+weights[i]);
          const force=[];
          for(const [v,c] of terms) if(c) {
            const value=Number(c<0);
            if(swaps.has(v) || free.has(v)) force.push([v,value]);
            else if(fixed[v]>=0 && fixed[v]!==value) {force.length=0;break;}
          }
          if(force.some(([v,value])=>fixed[v]!==value) && canPlant(fixed,force,swaps)) {
            const id=force.sort(([a],[b])=>a-b).join(';');
            if((options.get(id)?.rank??0)<group.length) options.set(id,{force,rank:group.length});
          }
        }
        if(group.length>=maxSize) return;
        const next=new Set(group.flatMap(row=>row.links));
        for(const row of next) if(!group.includes(row)) {
          if(!budget) break;
          for(const sign of [1,-1]) expand([...group,row],[...weights,sign]);
        }
      }
      const starts=rows.filter(row=>fresh.has(row.v));
      if(hard) starts.sort((a,b)=>b.vs.filter(v=>free.has(v)).length-a.vs.filter(v=>free.has(v)).length);
      for(const row of starts) for(const sign of [1,-1]) expand([row],[sign]);
      return [...options.values()].sort((a,b)=>b.rank-a.rank).slice(0,hard?16:8).map(o=>o.force);
    }

    function canPlant(state,force,swaps,plant=false) {
      // Within a group every cell belongs to exactly the same public clues.
      // Preserve its mine count while satisfying the new signed bound.
      const required=new Map(), groups=new Map();
      for(const [v,value] of force) {
        const group=swaps.get(v);
        if(group) groups.set(group,(groups.get(group)??0)+value-state[v]);
        required.set(v,value);
      }
      for(const [group,delta] of groups) if(delta) {
        const eligible=group.filter(v=>!required.has(v) && state[v]===Number(delta>0));
        if(eligible.length<Math.abs(delta)) return false;
        if(plant) for(const v of eligible.slice(0,Math.abs(delta))) state[v]=Number(delta<0);
      }
      if(plant) for(const [v,value] of force) state[v]=value;
      return true;
    }

    function propose(base,view,known,targets,limit,directed=false) {
      const fixed=base.slice();
      for(const v of targets) {
        if(fixed[v]===1) return null;
        fixed[v]=0;
      }
      const edge=[...new Set(targets.flatMap(v=>ns[v]))].filter(v=>fixed[v]<0);
      const options=[], seen=new Set();
      const swaps=new Map();
      if(hard && directed) {
        const exposed=new Set(targets.flatMap(v=>ns[v])), fresh=new Set(targets);
        const rows=constraints(config,view,known,ns).local;
        for(const group of equivalentGroups(rows.map(row=>({vs:row.vs.filter(v=>!fresh.has(v))})))) {
          if(!group.some(v=>exposed.has(v)) || !group.some(v=>fixed[v]===1) || !group.some(v=>fixed[v]===0)) continue;
          for(const v of group) swaps.set(v,group);
        }
      }
      const patterns=directed && (edge.length || swaps.size)?directedRings(fixed,view,known,targets,edge,swaps):[];
      const samples=edge.length || swaps.size?limit:1;
      const trials=samples+patterns.length;
      for(let i=0;i<trials;i++) {
        const state=fixed.slice(), next=view.slice();
        const force=patterns[i-samples]??[];
        if(force.length) canPlant(state,force,swaps,true);
        else if(i && swaps.size) {
          const groups=[...new Set(swaps.values())];
          const group=groups[r(groups.length)], a=group[r(group.length)], b=group.find(v=>state[v]!==state[a]);
          [state[a],state[b]]=[state[b],state[a]];
        }
        const scale=i===0 ? 1 : i===limit-1 ? 0 : .4+r(161)/100;
        if(!commitRing(state,edge.filter(v=>state[v]<0),scale)) continue;
        for(const v of targets) next[v]=number(state,v);
        const key=state.join(',');
        if(seen.has(key)) continue;
        seen.add(key);
        const done=amountOpen(next)===n-mines;
        const move=done?null:nextMove(next,known);
        if(!done && !move) continue;
        options.push({state,next,move});
      }
      return options;
    }

    function preview(option,known,depth) {
      const {next,state}=option;
      const {move}=option;
      if(!move) return 0;
      const count=move.sources.length;
      const score=(count-1)*(count-1);
      if(depth===1) return score;
      if(move.value) {
        known=new Set([...known,...move.vs]);
        const after=nextMove(next,known);
        return after ? score+.85*preview({next,state,move:after},known,depth-1) : score-4;
      }
      const candidates=propose(state,next,known,move.vs,3)??[];
      return candidates.length ? score+.85*Math.max(...candidates.map(c=>preview(c,known,depth-1))) : score-4;
    }

    function rateOption(option,known) {
      if(!option.move) return {score:0};
      const {next,state}=option;
      const judgment=option.move.sources.length>=3 ? classifyRows(next,constraints(config,next,known,ns),16000,true) : undefined;
      if(judgment && judgment.status!=='complete') return {score:-12};
      const proof=minimizeMove(config,next,known,option.move,ns,judgment,{minimumBudget:24000});
      const move=proof.positionMinimum && batchMove(config,next,known,proof,ns,24000);
      if(!move) return {score:-12};
      const added=new Set([...known,...move.mines]);
      const count=move.sources.length;
      const score=2*(count-1)+Number(count>=3)*hard.multi+Math.max(0,count-2)*hard.peak;
      const future=move.safe.length ? propose(state,next,added,move.safe,3) :
        [{move:nextMove(next,added)}].filter(c=>c.move);
      const follow=future?.length ? Math.max(...future.map(c=>c.move?.sources.length??2))-1 : -2;
      return {score:score+follow,verifiedMove:move};
    }

    // Backtrack only tentative continuation rings. The public opening and
    // its verified proof are shared by every continuation.
    let planned;
    for(let step=0;step<n*3;step++) {
      if(amountOpen(visible)===n-mines) {
        // Every remaining cell must be a mine by the public total.
        const bombs=Array.from(map,v=>v!==0);
        if(bombs.filter(Boolean).length!==mines) return null;
        return {w:p.w,h:p.h,ns,mines,seed:openingSeed.seed??seed,first:givens[0],opening:givens,bombs,
          clues:ns.map(row=>row.reduce((a,v)=>a+Number(bombs[v]),0))};
      }
      let move=planned??nextMove(visible,marks);
      if(move && !planned) {
        const first=!continuation && step===0;
        const proof=first?openingProof(config,visible,move,ns,openingSeed.judgment):minimizeMove(config,visible,marks,move,ns);
        move=proof.positionMinimum?batchMove(config,visible,marks,proof,ns):null;
      }
      planned=undefined;
      if(move) {
        for(const v of move.mines) marks.add(v);
        if(!move.safe.length) continue;
        const candidates=propose(map,visible,marks,move.safe,hard?10:7,true);
        const ranked=hard ? candidates.sort((a,b)=>(b.move?.sources.length??2)-(a.move?.sources.length??2))
          .slice(0,7).map(c=>({...c,...rateOption(c,marks)})) :
          candidates.map(c=>({...c,score:preview(c,marks,3)}));
        const [next,...alternatives]=ranked.sort((a,b)=>b.score-a.score);
        if(next) {
          if(alternatives.length && retries) forks.push({alternatives,marks:new Set(marks)});
          map=next.state;visible=next.next;planned=next.verifiedMove;
          continue;
        }
      }
      if(!forks.length || !retries) return null;
      retries--;
      const fork=forks.at(-1), next=fork.alternatives.shift();
      if(!fork.alternatives.length) forks.pop();
      map=next.state;visible=next.next;marks=new Set(fork.marks);planned=next.verifiedMove;
    }
    return null;
  }

  // 在线索图外尝试可通过零格连片展开的续局。已有线索的邻域保持原样。
  function* shapedCompletions(p,ns,mines,{map,givens},seed) {
    const {w,h}=p;
    const free=range(ns.length).filter(v=>map[v]<0);
    const remaining=mines-map.reduce((sum,v)=>sum+Number(v===1),0);
    if(remaining<=0 || remaining>=free.length) return;
    const r=random(seed^0x6dc);
    const corners=[0,w-1,(h-1)*w,ns.length-1], first=r(corners.length);
    const seen=new Set();
    for(const rectangular of [false,true]) for(let i=0;i<corners.length;i++) {
      const corner=corners[(i+first)%corners.length];
      function distance(v) {
        const dx=Math.abs(v%w-corner%w),dy=Math.abs(Math.floor(v/w)-Math.floor(corner/w));
        return rectangular ? Math.max(dx,dy)*(w+h)+dx+dy : dx+dy;
      }
      const extra=free.slice().sort((a,b)=>distance(a)-distance(b) || a-b).slice(0,remaining);
      const key=extra.slice().sort((a,b)=>a-b).join(',');
      if(seen.has(key)) continue;
      seen.add(key);
      const bombs=Array.from(map,v=>v===1);
      for(const v of extra) bombs[v]=true;
      const clues=ns.map(row=>row.reduce((sum,v)=>sum+Number(bombs[v]),0));
      yield {w,h,ns,mines,seed,bombs,clues,opening:givens,first:givens[0]};
    }
  }

  function refine(p,board,report,start,compare,fits,hard,evaluate,maxTrials=5) {
    const {ns,mines,seed}=board, r=random(seed^0x579a);
    let best={board,report};
    for(let trial=0;trial<maxTrials && !fits(best.report);trial++) {
      const view=opening(best.board), marks=new Set(), checkpoints=[];
      let run=0;
      for(const move of best.report.trace) {
        run=move.sources.length>=3?0:run+1;
        if(run>=2 && move.commit?.safe.length) {
          const map=new Int8Array(ns.length).fill(-1);
          for(const v of marks) map[v]=1;
          for(let v=0;v<ns.length;v++) if(view[v]>=0) {
            map[v]=0;
            for(const u of ns[v]) map[u]=Number(best.board.bombs[u]);
          }
          const free=map.filter(v=>v<0).length;
          if(free>=4 && move.commit.safe.some(v=>ns[v].some(u=>map[u]<0))) {
            checkpoints.push({view:view.slice(),marks:[...marks],map,weight:run*Math.min(free,24)});
          }
        }
        for(const v of move.commit?.mines??[]) marks.add(v);
        for(const v of move.commit?.safe??[]) reveal(best.board,view,v,marks);
      }
      if(!checkpoints.length) break;
      checkpoints.sort((a,b)=>b.weight-a.weight);
      const point=checkpoints[r(Math.min(5,checkpoints.length))];
      const candidate=construct(p,r(4294967296),ns,mines,{...start,seed},point,hard);
      if(!candidate) continue;
      const next=evaluate(candidate);
      if(next?.status==='passed' && compare(next,best.report)<0) best={board:candidate,report:next};
    }
    return best;
  }

  function standardDifficulty(w,h) {
    const minMultiPercent=Math.min(w,h)<5?0:w*h<=64?10:5;
    return {minAverage:1.2,minMultiPercent,minPeakClues:2};
  }

  // A signed stencil fixes only the cells that survive cancellation.
  // The second shape leaves one extra clue open to constrain later marks.
  const compactStencils=[
    {total:1, weights:[[3,-1],[4,1],[5,-1],[10,1],[14,-1],[16,-1],[20,-1],[22,1],[23,-1]], anchors:[[12,1],[13,0],[18,0]]},
    {total:2, weights:[[1,0],[3,-2],[5,-2],[10,2],[14,-1],[16,-2],[19,-1],[20,-2],[22,2],[23,-2]], anchors:[[12,1],[18,0]]},
  ];

  function* compactCancellation(ns,seed,mines,round,shape) {
    const r=random(seed);
    const rotation=r(4), mirror=r(2);
    const transform=v=>{
      let x=v%5,y=Math.floor(v/5);
      if(mirror) x=4-x;
      for(let i=0;i<rotation;i++) [x,y]=[4-y,x];
      return x+5*y;
    };
    // On a 5x5 board the total can cancel overlapping clues that do not
    // fit the disjoint two-cell joints of the even-ring construction.
    const pattern=compactStencils[shape], stencil=pattern.weights.slice();
    if(round%3===0) {
      const i=r(stencil.length), [v,k]=stencil[i];
      const neighbors=ns[v].filter(u=>!stencil.some(([s])=>s===u));
      if(neighbors.length) stencil[i]=[neighbors[r(neighbors.length)],k];
    }
    const givens=stencil.map(([v])=>transform(v)), revealed=new Set(givens);
    const unknown=range(ns.length).filter(v=>!revealed.has(v));
    const coefficients=new Int8Array(ns.length).fill(pattern.total);
    for(const [i,v] of givens.entries()) for(const u of ns[v]) coefficients[u]+=stencil[i][1];
    const cancelled=unknown.filter(v=>!coefficients[v]);
    const forced=unknown.filter(v=>coefficients[v]);
    if(!forced.length || cancelled.length<5) return;
    const anchors=new Map(pattern.anchors.map(([v,value])=>[transform(v),value])), seen=new Set();
    for(let trial=0;trial<96;trial++) {
      const bombs=Array(ns.length).fill(false), flip=r(2);
      for(const v of forced) bombs[v]=Boolean(Number(coefficients[v]<0)^flip);
      // The overlapping three-clue region gives the batch a first move;
      // the total and surrounding clues are needed for other cells.
      for(const v of cancelled) {
        bombs[v]=Boolean((round%3===0 ? r(2) : anchors.get(v)??r(2))^flip);
      }
      const count=bombs.filter(Boolean).length;
      if(mines!=null && count!==mines || count<2 || count>=unknown.length-1) continue;
      const key=bombs.map(Number).join('');
      if(seen.has(key)) continue;
      seen.add(key);
      const clues=ns.map(row=>row.reduce((sum,v)=>sum+Number(bombs[v]),0));
      const visible=clues.map((clue,v)=>revealed.has(v)?clue:-1);
      const {rows}=constraints({mines:count},visible,new Set(),ns);
      if(rows.length<10 || elementary(rows,()=>true)) continue;
      yield {w:5,h:5,ns,mines:count,seed,first:givens[0],opening:givens,bombs,clues};
    }
  }

  function difficultyDefaults() {
    return {minAverage:1.5,minMultiPercent:8,minPeakClues:5};
  }

  function continuationReplay(p,board,previous,point) {
    const rounds=[], prefix=[];
    let start;
    if(point) {
      const visible=point.visible.slice(), flags=new Set(point.flags);
      for(const v of point.commit.mines) flags.add(v);
      for(const v of point.commit.safe) {
        flags.delete(v);
        reveal(board,visible,v,flags);
      }
      start={visible,marks:flags};
      // 交换保持检查点的公开数字和已确定格，因此到该轮提交为止可以复用原证明。
      prefix.push(...previous.report.trace.slice(0,point.end));
      for(const round of previous.rounds) {
        rounds.push({...round});
        if(round===point) break;
      }
    }
    const replay=verify(board,p,{certify:true,trace:true,measureDifficulty:!point,...start,
      observeRound:(visible,flags,state)=>rounds.push({visible:visible.slice(),flags:new Set(flags),state})});
    if(replay.status!=='passed') return;
    const trace=[...prefix,...replay.trace];
    let roundIndex=0, stepStart=0, depth=0, linkedRounds=0, linked=false, currentLinks=new Map(), priorLinks=new Map();
    let clues=0;
    for(const [step,move] of trace.entries()) {
      const round=rounds[roundIndex], prior=rounds[roundIndex-1], count=move.sources.length;
      clues=Math.max(clues,count);
      if(count>=3) {
        for(const v of move.safe) {
          let length=1;
          // 只有上一轮尚不确定的格，才计入新数字解锁的下一层。
          if(prior?.state[v]==='either') for(const source of move.sources) {
            const previous=priorLinks.get(source);
            if(previous && prior.visible[source]<0 && round.visible[source]>=0) length=Math.max(length,previous+1);
          }
          currentLinks.set(v,Math.max(currentLinks.get(v)??0,length));
          linked||=length>1;
          depth=Math.max(depth,length);
        }
      }
      if(move.commit) {
        Object.assign(round,{start:stepStart,end:step+1,commit:move.commit});
        linkedRounds+=Number(linked);
        priorLinks=currentLinks;
        currentLinks=new Map();
        linked=false;
        stepStart=step+1;
        roundIndex++;
      }
    }
    const report=point?{...previous.report,trace,clues,steps:trace.length,
      ...summarizeSupports(trace.map(move=>move.sources.length))}:replay;
    return {board,report,rounds,depth,linkedRounds};
  }

  function continuationSwaps(board,{visible,flags,state}) {
    const near=new Set(), groups=new Map(), signatures=[], mines=[], safe=[];
    for(const [v,kind] of state.entries()) if(kind==='safe') for(const u of board.ns[v]) near.add(u);
    for(const [v,kind] of state.entries()) {
      if(kind!=='either' || flags.has(v)) continue;
      // 每条线索占两位。两格相加不会进位，可查找互相抵消的两组交换。
      const signature=board.ns[v].reduce((key,u)=>visible[u]>=0?key+(1n<<(2n*BigInt(u))):key,0n);
      if(!groups.has(signature)) groups.set(signature,{mines:[],safe:[]});
      const side=board.bombs[v]?'mines':'safe';
      groups.get(signature)[side].push(v);
      (board.bombs[v]?mines:safe).push(v);
      signatures[v]=signature;
    }
    const singles=[...groups.values()].filter(g=>g.mines.length && g.safe.length);
    const around=singles.filter(g=>g.mines.some(v=>near.has(v)) || g.safe.some(v=>near.has(v)));
    const nearMines=mines.filter(v=>near.has(v)), nearSafe=safe.filter(v=>near.has(v));
    return r=>{
      const pick=list=>list[r(list.length)];
      if(mines.length>=2 && safe.length>=2 && (!singles.length || r(3)===0)) {
        for(let i=0;i<12;i++) {
          const a=pick(nearMines.length && r(3)?nearMines:mines);
          const b=pick(nearSafe.length && r(3)?nearSafe:safe);
          const delta=signatures[a]-signatures[b];
          if(!delta) continue;
          // 小池遍历全部雷格，大池只抽样，限制单次交换成本。
          const offset=r(mines.length);
          for(let j=0;j<Math.min(24,mines.length);j++) {
            const c=mines[(offset+j)%mines.length];
            if(c===a) continue;
            const other=groups.get(signatures[c]+delta)?.safe;
            if(!other?.length || other.length===1 && other[0]===b) continue;
            const index=r(other.length);
            const d=other[index]===b?other[(index+1)%other.length]:other[index];
            return [a,b,c,d];
          }
        }
      }
      if(!singles.length) return;
      const group=pick(around.length && r(5)?around:singles);
      const localMines=group.mines.filter(v=>near.has(v)), localSafe=group.safe.filter(v=>near.has(v));
      if(localMines.length && (!localSafe.length || r(2))) return [pick(localMines),pick(group.safe)];
      return [pick(group.mines),pick(localSafe.length?localSafe:group.safe)];
    };
  }

  function* extendContinuations(p,board,seed,peak,known) {
    const r=random(seed), base=continuationReplay(p,board);
    if(!base) return;
    const score=({report,depth,linkedRounds})=>5*report.advancedDensity+report.averageClues/2+
      .26*Math.max(0,depth-1)+.08*Math.min(linkedRounds,6);
    let current=base, currentScore=score(base);
    const baseScore=currentScore;
    const swaps=new WeakMap(), tried=new Set();
    // 保留若干早期检查点，给开局解出来的第一批数字和后续数字都留出调整机会。
    for(let trial=0;trial<240;trial++) {
      const rounds=current.rounds.filter(round=>round.start<=current.report.steps*.65 && round.commit?.safe.length);
      if(!rounds.length) return;
      const count=trial%5===0?rounds.length:Math.min(rounds.length,6);
      const point=rounds[trial%4===0?0:r(count)];
      if(!swaps.has(point)) swaps.set(point,continuationSwaps(current.board,point));
      const swap=swaps.get(point)(r);
      if(!swap) {yield;continue;}
      const bombs=current.board.bombs.slice(), clues=current.board.clues.slice();
      for(const v of swap) {
        bombs[v]=!bombs[v];
        for(const u of board.ns[v]) clues[u]+=bombs[v]?1:-1;
      }
      const candidate={...current.board,bombs,clues};
      const key=bombs.map(Number).join('');
      if(tried.has(key) || known(candidate)) {yield;continue;}
      tried.add(key);
      const next=continuationReplay(p,candidate,current,point);
      if(!next || next.report.clues<peak) {yield;continue;}
      const nextScore=score(next);
      if(nextScore>currentScore || trial%7===6 && nextScore>=currentScore-.12) {
        current=next;
        currentScore=nextScore;
      }
      if(trial%36===35 && currentScore<baseScore) {current=base;currentScore=baseScore;}
      yield next;
    }
  }

  function generationRanking(p) {
    const defaults=difficultyDefaults();
    const target={average:p.minAverage??defaults.minAverage,multiPercent:p.minMultiPercent??defaults.minMultiPercent,
      peak:p.minPeakClues??defaults.minPeakClues};
    const multi=target.multiPercent/100;
    const fits=report=>report.averageClues>=target.average && report.advancedDensity>=multi && report.clues>=target.peak;
    const deficit=r=>Math.max(0,1-r.averageClues/Math.max(1,target.average))+
      (multi>0?Math.max(0,1-r.advancedDensity/multi):0)+
      Math.max(0,1-r.clues/Math.max(1,target.peak));
    const compare=(a,b)=>Number(fits(b))-Number(fits(a)) || deficit(a)-deficit(b) || compareOpening(a,b);
    const compareClosest=(a,b)=>{
      const priority=a.clues<target.peak || b.clues<target.peak ?
        b.clues-a.clues : b.advancedDensity-a.advancedDensity;
      return priority || compare(a,b);
    };
    return {target,fits,compare,compareClosest};
  }

  function generationSchedule(p,logicalCores=2) {
    const area=p.w*p.h;
    if(area<=2 || p.w===2 && p.h===2) return {initial:1,limit:1,lanesAt:()=>1};
    const {target}=generationRanking(p);
    const effort=target.average-1+target.multiPercent/30+(target.peak-1)/4;
    const base=area<=64 && Math.min(p.w,p.h)>=5 ? 3 : 2;
    const boardLimit=area<=64 ? 12 : area<=256 ? 10 : 8;
    // 设备有多个可用逻辑核心时，为页面留出一个。
    const limit=Math.max(1,Math.min(boardLimit,Math.floor(logicalCores||2)-1));
    const initial=Math.min(limit,base+Math.min(4,Math.floor(effort)));
    // 大棋盘的单轮搜索通常更耗时，因此更早增加搜索路数。
    const roundsPerSeed=area<=64 ? 32 : area<=256 ? 16 : 8;
    const lanesAt=rounds=>Math.min(limit,initial+Math.floor(rounds/roundsPerSeed));
    return {initial,limit,lanesAt};
  }

  function composeClueSearch(p,seed,compose=composeClues,{originalTarget=false}={}) {
    const {peak}=generationRanking(p).target;
    const area=p.w*p.h, maxSize=area-(p.mines??Math.max(1,Math.ceil(area*.16)))-1;
    if(peak<6 || Math.min(p.w,p.h)<5 || maxSize<2 || p.mines===0 || originalTarget && peak>maxSize) return;
    const r=random(seed), blocks=new Map([[1,{geometry:{points:[[0,0]],w:1,h:1}}]]);
    // 在单次命中率至少 20% 的假设下，连续未中的概率降到 10% 以下。
    const failureLimit=Math.ceil(Math.log(.1)/Math.log(.8));
    let largest=1, round=0, best;
    function attempt(count,splitNearHalf,snapshot) {
      const id=r(4294967296), trialBlocks=snapshot?new Map(snapshot):blocks;
      for(const balanced of [true,false]) {
        const shape=compose(p,count,id,{blocks:trialBlocks,balanced,preferLoops:balanced && Boolean(id&8),
          splitNearHalf,exploreSplit:Boolean(snapshot),placementBudget:30000});
        if(snapshot) for(const [size,child] of trialBlocks) if(!blocks.has(size)) blocks.set(size,child);
        if(!shape) continue;
        const entry={shape,balanced};
        blocks.set(count,shape);
        if(count>=largest) {largest=count;best=entry;}
        return entry;
      }
    }
    // 保留一路持续尝试用户要求的峰值，历次成功的子块仍可复用。
    if(originalTarget) return ()=>{
      const found=attempt(peak,false,blocks);
      return {target:peak,...(found??best)};
    };
    // 候选先在单线索基础块和原峰值之间取中点。上界不参与二分试探。
    let lower=1, upper=Math.min(peak,maxSize+1), probe, revisit=0;
    return ()=>{
      const splitNearHalf=round++%3===2;
      if(upper-lower<=1) {
        // 抽样失败只用于收缩区间。收敛后优先复用最高档，间隔复查更高档。
        const floor=Math.max(2,Math.min(peak,largest));
        const ceiling=Math.max(floor,largest);
        let target=floor;
        if(++revisit%16===8) target=Math.min(peak,maxSize);
        else if(revisit%16===0 && largest<maxSize) {
          const limit=Math.min(maxSize,Math.max(peak+1,largest+1));
          target=largest+1+r(limit-largest);
        } else if(ceiling>floor) target+=r(ceiling-floor+1);
        const found=attempt(target,splitNearHalf,blocks);
        return {target,...(found??best)};
      }
      const target=Math.floor((lower+upper)/2);
      let budget=3;
      if(!probe) {
        const found=attempt(target,splitNearHalf);
        if(found) {lower=target;return {target,...found};}
        // 固定本档的子块和预算，再用不同种子抽样。
        probe={blocks:new Map(blocks),misses:0};
        budget--;
      }
      while(budget-->0) {
        const found=attempt(target,false,probe.blocks);
        if(found) {lower=target;probe=undefined;return {target,...found};}
        if(++probe.misses===failureLimit) {upper=target;probe=undefined;break;}
      }
      return {target,...best};
    };
  }

  function* generate(p,seed,onCandidate,options={}) {
    const {originalTarget=false}=options;
    const {target,fits,compare,compareClosest}=generationRanking(p);
    const area=p.w*p.h, tiny=area===2 || p.w===2 && p.h===2;
    const required=Math.max(target.peak,Math.ceil(target.average),target.multiPercent>0?3:1);
    // 还有安全格未开时，可用的线索至多是已开数字加公开总雷数。
    const maxClues=p.mines===0?1:area-(p.mines??1);
    if(area===1 || required>maxClues || tiny && (required>1 || p.mines>0))
      throw Error('该尺寸和难度下限无法构造需要推理的棋局。请调低难度或增大棋盘。');
    const ns=adj(p.w,p.h), r=random(seed), seen=new Set();
    if(tiny) {
      const board=candidate({...p,mines:0},seed,ns);
      board.opening=[board.first];
      const report=verify(board,{...p,mines:0},{certify:true});
      if(report.status!=='passed') throw Error('未能验证最小棋盘的开局。');
      yield {board,report,target,tried:1,passed:1,constructed:1,route:'compact'};
      return;
    }
    const near=ns.map((row,i)=>[...new Set(row.flatMap(v=>ns[v]))].filter(v=>v!==i));
    const plan=openingPlans[(seed>>>0)%openingPlans.length];
    const compact=ns.length<=64 || Math.min(p.w,p.h)<5;
    const multi=target.multiPercent/100;
    const standard=standardDifficulty(p.w,p.h);
    const hard=target.average>standard.minAverage || target.multiPercent>standard.minMultiPercent || target.peak>standard.minPeakClues ?
      {multi:4*multi,peak:target.peak>standard.minPeakClues?.75:0} : null;
    const min=Math.max(1,Math.ceil(ns.length*.16)), max=Math.max(min,Math.floor(ns.length*.28));
    const composeSeed=seed^0x2795;
    const composeNext=composeClueSearch(p,composeSeed,composeClues,{originalTarget});
    const composeFallback=originalTarget ? composeClueSearch(p,composeSeed) : undefined;
    const linkRounds=target.peak>=10 && (target.multiPercent>=20 || target.average>=1.8);
    let passed=0, constructed=0, closest, closestMetrics;
    let continuation, continuationAnchor;
    const layoutKey=board=>board.opening.slice().sort((a,b)=>a-b)+':'+board.bombs.map(Number).join('');
    function duplicate(board) {
      const key=layoutKey(board);
      if(seen.has(key)) return true;
      if(seen.size>=4096) seen.delete(seen.values().next().value);
      seen.add(key);
      return false;
    }
    const progress=tried=>({target,tried,passed,constructed,closest:closestMetrics,candidate:closest});
    function certify(board,tried,trace=false) {
      const report=verify(board,p,{certify:true,trace});
      if(report.status==='passed' && report.steps) {
        passed++;
        if(report.openingMinimum && !fits(report) && (!closest || compareClosest(report,closest.report)<0)) {
          closest={board,report:{...report,trace:[]}};
          closestMetrics={average:report.averageClues,multiPercent:report.advancedDensity*100,peak:report.clues};
          onCandidate?.(progress(tried));
        }
      }
      return report;
    }
    function improveLaterRounds(tried) {
      if(!linkRounds || !closest || closest.report.clues<target.peak) return;
      if(!continuation && continuationAnchor!==closest.board) {
        continuationAnchor=closest.board;
        continuation=extendContinuations(p,continuationAnchor,seed^tried,target.peak,board=>seen.has(layoutKey(board)));
      }
      if(!continuation) return;
      // 高峰值构造与续接交替推进，让停止搜索仍可采用已经通过完整验证的候选。
      for(let i=0;i<12;i++) {
        const {value,done}=continuation.next();
        if(done) {continuation=undefined;break;}
        if(!value || !fits(value.report) && compareClosest(value.report,closest.report)>=0) continue;
        const {board}=value;
        if(duplicate(board)) continue;
        constructed++;
        const report=certify(board,tried);
        if(report.status==='passed' && report.steps && fits(report)) {
          return {board,report,target,tried,passed,constructed,route:'linked-rounds'};
        }
      }
    }
    for(let k=1;;k++) {
      const id=r(4294967296), natural=min+r(max-min+1);
      // 单路定期推进候选拼接。原峰值超出拼接容量时，每轮仍可拼接候选。
      const fallbackRound=options.candidateFallback && composeFallback && (!composeNext || k%5===0);
      const composeRound=fallbackRound ? composeFallback : composeNext;
      const composition=composeRound?.();
      const clueSize=composition?.shape?.givens.length??0;
      const useStencil=target.peak<=11 || clueSize>=10 && k%4===1;
      if(p.w===5 && p.h===5 && target.peak>=10 && useStencil && k%4!==0) {
        const shape=((seed>>>0)+k-1)%compactStencils.length;
        for(const board of compactCancellation(ns,id,p.mines,k,shape)) {
          constructed++;
          if(duplicate(board)) continue;
          const report=certify(board,k);
          if(report.status==='passed' && report.steps && fits(report)) {
            yield {board,report,target,tried:k,passed,constructed,route:'compact-cancellation'};
            return;
          }
        }
      }
      const dense=random(id^0xd3ab);
      const denseRound=hard && k%4!==0 && k%3!==0;
      const cycleRound=denseRound && !!composeRound;
      const aimAtPeak=originalTarget && !fallbackRound || target.peak<10;
      const cycleSize=aimAtPeak ? target.peak : Math.max(6,clueSize);
      const density=cycleRound ? .34+dense(41)/100 : .23+dense(26)/100;
      const sampledMines=denseRound?Math.round(ns.length*density):natural;
      const mines=p.mines??(clueSize?Math.min(sampledMines,area-clueSize-1):sampledMines);
      // Give interior geometry most of the budget without forbidding edge patterns.
      const interior=!compact && k%4!==0;
      const route=compact || k>96 && k%8===0 ? openingPlans[((seed>>>0)+k-1)%openingPlans.length]:plan;
      const directed=hard && k%4!==0 ? hard : null;
      let starts=[];
      if(cycleRound) {
        const length=2*Math.ceil(cycleSize/2);
        if(k%4===1 || target.peak>=10) starts=seedCycle(p,ns,near,id,mines,length,false);
        if(!starts.length && target.peak<10) starts=seedCycle(p,ns,near,id,mines,length+2*(k%5),k%4===1);
      }
      const ringStarts=starts;
      const composed=clueSize>=3 ? seedComposed(p,ns,id,mines,composition.shape,composition.balanced) : [];
      // 先尝试几种低成本续局，再交给通用构造器补足更高的多步难度。
      const refineShaped=!linkRounds && directed && (target.average>1 || target.multiPercent>0);
      function evaluateRefinement(refined) {
        constructed++;
        if(!duplicate(refined)) return certify(refined,k,true);
      }
      let shapedCandidate;
      for(const start of [...composed,...(clueSize>=12?ringStarts:[])]) for(const board of shapedCompletions(p,ns,mines,start,id)) {
        if(duplicate(board)) continue;
        constructed++;
        const report=certify(board,k,!!refineShaped);
        if(report.status!=='passed' || !report.steps) continue;
        if(fits(report)) {
          yield {board,report:{...report,trace:[]},target,tried:k,passed,constructed,route:start.composed?'composed-transfer':'cycle-transfer'};
          return;
        }
        if(refineShaped && report.clues>=target.peak &&
          (!shapedCandidate || compareClosest(report,shapedCandidate.report)<0)) shapedCandidate={board,report,start};
      }
      const linked=improveLaterRounds(k);
      if(linked) {yield linked;return;}
      if(shapedCandidate) {
        const {board,report,start}=shapedCandidate;
        const candidate=refine(p,board,report,start,(a,b)=>Number(fits(b))-Number(fits(a)) || compareClosest(a,b),
          fits,directed,evaluateRefinement,1);
        if(fits(candidate.report)) {
          yield {board:candidate.board,report:{...candidate.report,trace:[]},target,tried:k,passed,constructed,
            route:start.composed?'composed-transfer':'cycle-transfer'};
          return;
        }
      }
      // 大棋盘已有峰值达标的候选时，部分拼接轮只做快验和续接，通用轮仍深入构造。
      const deferConstruction=continuation && area>256 && k%4!==1;
      const hasShapedStart=composed.length>0 || ringStarts.length>0;
      if(!compact && clueSize>0 && hasShapedStart && k%4!==0 && closest && (clueSize<target.peak || deferConstruction)) {
        yield progress(k);
        continue;
      }
      if(!starts.length && (compact || directed && k%2===0)) starts=compactOverlap(p,ns,near,id,mines,!!directed);
      if(!starts.length && (!compact || k%3===0 || directed)) starts=seedOpening(p,ns,near,id,mines,route,interior,compact);
      if(compact && !starts.length) starts=seedCompact(p,ns,id,mines);
      for(const start of [...composed,...starts]) {
        const board=construct(p,id,ns,mines,start,undefined,directed);
        if(!board) continue;
        constructed++;
        if(duplicate(board) || start.givens.some(v=>start.view[v]!==board.clues[v])) continue;
        const report=certify(board,k,true);
        if(report.status==='passed' && report.steps) {
          const candidate=fits(report)?{board,report}:refine(p,board,report,start,compare,fits,directed,evaluateRefinement);
          if(fits(candidate.report)) {
            yield {board:candidate.board,report:{...candidate.report,trace:[]},target,tried:k,passed,constructed,route:start.composed?'composed-transfer':compact?'compact':route.kind};
            return;
          }
        }
      }
      yield progress(k);
    }
  }

  // 从全开状态逆向构造。只撤回一个能用余下线索重新证明安全的格。
  return {composeClues,difficultyDefaults,generationRanking,generationSchedule,composeClueSearch,generate};
}

if(typeof module!=='undefined') module.exports=makeMinesGeneration;
