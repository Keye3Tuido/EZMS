function makeRegionSelection(adj) {
  function boundaryLoops(cells,width,height,canJoin=()=>false) {
    const set=new Set(cells),edges=[];
    const key=(x,y)=>`${x},${y}`;
    for(const i of set) {
      const x=i%width,y=Math.floor(i/width);
      if(y===0||!set.has(i-width)) edges.push({x,y,d:0});
      if(x===width-1||!set.has(i+1)) edges.push({x:x+1,y,d:1});
      if(y===height-1||!set.has(i+width)) edges.push({x:x+1,y:y+1,d:2});
      if(x===0||!set.has(i-1)) edges.push({x,y:y+1,d:3});
    }
    const outgoing=new Map();
    edges.forEach((edge,index)=>{
      const list=outgoing.get(key(edge.x,edge.y))??[];
      list.push(index);outgoing.set(key(edge.x,edge.y),list);
    });
    const used=new Set(),loops=[];
    for(let start=0;start<edges.length;start++) {
      if(used.has(start)) continue;
      const first=edges[start],ring=[[first.x,first.y]];
      let edgeIndex=start,closed=false;
      while(!used.has(edgeIndex)) {
        used.add(edgeIndex);
        const edge=edges[edgeIndex];
        const x=edge.x+(edge.d===0?1:edge.d===2?-1:0);
        const y=edge.y+(edge.d===1?1:edge.d===3?-1:0);
        ring.push([x,y]);
        const candidates=outgoing.get(key(x,y))??[];
        if(!candidates.length) break;
        const turn=candidates.length===2 && canJoin(x,y) ? 3 : 1;
        edgeIndex=candidates.find(i=>(edges[i].d-edge.d+4)%4===turn)??candidates[0];
        if(edgeIndex===start) {closed=true;break;}
      }
      if(closed&&ring.length>=5) loops.push(ring);
    }
    return loops;
  }

  function contour(cells,width,height,{x,y,dx,dy,radius,inset},opposing=new Set()) {
    // Keep both colors separate where two diagonal pairs share one junction.
    const canJoin=(column,row)=>{
      const cell=row*width+column;
      return !(opposing.has(cell-1)&&opposing.has(cell-width) ||
        opposing.has(cell)&&opposing.has(cell-width-1));
    };
    const toward=(point,next,distance)=>{
      const length=Math.hypot(next[0]-point[0],next[1]-point[1]);
      return point.map((value,axis)=>value+(next[axis]-value)*distance/length);
    };
    return boundaryLoops(cells,width,height,canJoin).map(loop=>{
      const walk=loop.slice(0,-1), count=walk.length;
      const points=walk.flatMap(([column,row],index)=>{
        const [px,py]=walk[(index+count-1)%count], [nx,ny]=walk[(index+1)%count];
        if(nx-px===0 || ny-py===0) return [];
        // The selected area is on the right of each edge, including around holes.
        return [[x+column*dx-(ny-py)*inset,y+row*dy+(nx-px)*inset]];
      });
      const corners=points.map((point,index)=>{
        const previous=points[(index+points.length-1)%points.length];
        const next=points[(index+1)%points.length];
        return {point,entry:toward(point,previous,radius),exit:toward(point,next,radius)};
      });
      const curves=corners.map(({point,entry,exit},index)=>
        `${index?`L${entry}`:`M${entry}`}Q${point} ${exit}`);
      return curves.join('')+'Z';
    }).join('');
  }

  function addWeight(weights,cell,amount) {
    const value=(weights.get(cell)??0)+amount;
    if(value) weights.set(cell,value);
    else weights.delete(cell);
  }

  function history() {
    const weights=new Map(), clueWeights=new Map();
    const past=[], future=[];

    function write(change,direction) {
      for(const [layer,cell,amount] of change) addWeight(layer,cell,amount*direction);
    }

    function record(change) {
      if(!change.length) return false;
      write(change,1);
      past.push(change);
      future.length=0;
      return true;
    }

    return {
      weights,clueWeights,
      select(cells,clue,amount) {
        const change=cells.map(cell=>[weights,cell,amount]);
        if(clue!==undefined) change.push([clueWeights,clue,amount]);
        return record(change);
      },
      clear() {
        const change=[weights,clueWeights].flatMap(layer=>
          [...layer].map(([cell,amount])=>[layer,cell,-amount]));
        return record(change);
      },
      reset() {
        weights.clear();
        clueWeights.clear();
        past.length=0;
        future.length=0;
      },
      get canUndo() {return past.length>0;},
      get canRedo() {return future.length>0;},
      undo() {
        if(!past.length) return false;
        const change=past.pop();
        write(change,-1);
        future.push(change);
        return true;
      },
      redo() {
        if(!future.length) return false;
        const change=future.pop();
        write(change,1);
        past.push(change);
        return true;
      }
    };
  }

  function bounds(weights, known) {
    let min=0,max=0;
    for(const [cell,coefficient] of weights) {
      if(known.has(cell)) {
        min+=coefficient*known.get(cell);
        max+=coefficient*known.get(cell);
      } else {
        min+=Math.min(0,coefficient);
        max+=Math.max(0,coefficient);
      }
    }
    return {min,max,positive:[...weights].filter(([,n])=>n>0).map(([i])=>i),
      negative:[...weights].filter(([,n])=>n<0).map(([i])=>i)};
  }

  function regionTerms(weights,width,known,partition) {
    function byCoefficient(region) {
      const groups=new Map();
      for(const [cell,weight] of region) {
        if(!groups.has(weight)) groups.set(weight,[]);
        groups.get(weight).push(cell);
      }
      return groups;
    }
    const terms=groups=>[...groups].flatMap(([coefficient,cells])=>partition(cells).map(cells=>({coefficient,cells})));
    const groups=byCoefficient(weights);
    let best=terms(groups);
    for(const [coefficient,cells] of groups) {
      if(best.length<=2) break;
      if(cells.length<3) continue;
      let left=width,right=0,top=Infinity,bottom=0;
      for(const v of cells) {
        left=Math.min(left,v%width); right=Math.max(right,v%width);
        const y=Math.floor(v/width);
        top=Math.min(top,y); bottom=Math.max(bottom,y);
      }
      const rectangle=[];
      for(let y=top;y<=bottom;y++) for(let x=left;x<=right;x++) {
        const cell=y*width+x;
        if(!known.has(cell)) rectangle.push(cell);
      }
      if(rectangle.length===cells.length || rectangle.length>cells.length*2) continue;
      const rest=new Map(weights);
      for(const cell of rectangle) addWeight(rest,cell,-coefficient);
      const proposal=[{coefficient,cells:rectangle},...terms(byCoefficient(rest))];
      if(proposal.length<best.length) best=proposal;
    }
    // 用相互重叠的矩形表示选区，有时比按系数分组更简洁。
    if(best.length>2 && groups.size>1) for(const sign of [1,-1]) {
      const cells=[...weights].filter(([,weight])=>Math.sign(weight)===sign).map(([cell])=>cell);
      if(cells.length<2) continue;
      const rectangle=partition(cells).find(group=>group.length>1 &&
        group.some(cell=>weights.get(cell)!==weights.get(group[0])));
      if(!rectangle) continue;
      const coefficient=sign*rectangle.reduce((minimum,cell)=>Math.min(minimum,Math.abs(weights.get(cell))),Infinity);
      const rest=new Map(weights);
      for(const cell of rectangle) addWeight(rest,cell,-coefficient);
      const proposal=[{coefficient,cells:rectangle},...terms(byCoefficient(rest))];
      if(proposal.length<best.length) best=proposal;
      if(best.length<=2) break;
    }
    return best;
  }

  function singleClue(weights,clueWeights,visible,neighbors,known) {
    if(!weights.size || weights.size>8) return;
    const [first,coefficient]=weights.entries().next().value;
    const candidates=neighbors[first].filter(clue=>visible[clue]>=0).sort((a,b)=>
      Number(clueWeights.has(b))-Number(clueWeights.has(a)) || a-b);
    for(const clue of candidates) {
      const cells=unknown(neighbors[clue],known);
      if(cells.length!==weights.size || cells.some(cell=>weights.get(cell)!==coefficient)) continue;
      const mines=neighbors[clue].reduce((sum,cell)=>sum+(known.get(cell)??0),0);
      const remaining=visible[clue]-mines;
      if(remaining>=0 && remaining<=cells.length) {
        return {clue,coefficient,cells,total:remaining===0?0:coefficient*remaining};
      }
    }
  }

  function readout(selected,clueWeights,visible,neighbors,known,regionTerms) {
    const weights=new Map([...selected].filter(([cell])=>!known.has(cell)));
    const adjacent=new Map();
    for(const v of weights.keys()) for(const clue of neighbors[v]) {
      if(visible[clue]>=0 && !adjacent.has(clue)) adjacent.set(clue,unknown(neighbors[clue],known));
    }
    const byPreference=([a,left],[b,right])=>right.length-left.length ||
      Number(clueWeights.has(b))-Number(clueWeights.has(a)) || a-b;
    const remainder=new Map(weights), clues=[];
    for(const [clue,cells] of [...adjacent].sort(byPreference)) {
      const sign=Math.sign(remainder.get(cells[0])??0);
      if(!sign || cells.some(cell=>Math.sign(remainder.get(cell)??0)!==sign)) continue;
      const coefficient=sign*Math.min(...cells.map(cell=>Math.abs(remainder.get(cell))));
      clues.push({clue,coefficient,cells});
      for(const cell of cells) addWeight(remainder,cell,-coefficient);
    }
    let terms=[...clues,...regionTerms(remainder)];
    // 相消后，沿用玩家点过的线索有时能得到更短的表达式。
    // 项数相同时，优先保留完整线索邻域更多的表达式。
    if(clueWeights.size && clueWeights.size<=terms.length) {
      const clicked=[], rest=new Map(weights);
      for(const [clue,coefficient] of clueWeights) {
        if(visible[clue]<0) continue;
        const cells=unknown(neighbors[clue],known);
        if(!cells.length) continue;
        clicked.push({clue,coefficient,cells});
        for(const cell of cells) addWeight(rest,cell,-coefficient);
      }
      const identical=clicked.length===clues.length && clicked.every(({clue,coefficient})=>
        clues.some(term=>term.clue===clue && term.coefficient===coefficient));
      if(clicked.length && !identical) {
        const proposal=[...clicked,...regionTerms(rest)];
        if(proposal.length<terms.length || proposal.length===terms.length && clicked.length>clues.length) terms=proposal;
      }
    }
    const kind=term=>term.clue!==undefined?0:term.cells.length>1?1:2;
    terms.sort((a,b)=>Number(b.coefficient>0)-Number(a.coefficient>0) || kind(a)-kind(b));
    return {weights,terms};
  }

  function unknown(cells, known) {
    return cells.filter(cell=>!known.has(cell));
  }

  function knownCells({visible,flags,proven,manual,red}) {
    const known=new Map();
    for(let cell=0;cell<visible.length;cell++) if(visible[cell]>=0) known.set(cell,0);
    for(const cell of flags) known.set(cell,1);
    for(const cell of proven) known.set(cell,1);
    for(const [cell,kind] of manual) known.set(cell,kind==='mine'?1:0);
    for(const [cell,mark] of red) known.set(cell,mark.symbol==='x'?1:0);
    return known;
  }

  return {history,bounds,singleClue,readout,regionTerms,unknown,knownCells,boundaryLoops,contour,area:(cell,opened,width)=>opened[cell]>=0?adj(width,opened.length/width)[cell]:[cell]};
}

if(typeof module!=='undefined') module.exports=makeRegionSelection;
