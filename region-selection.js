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

  function constrainedBounds(weights, clues) {
    const positive=new Map(), negative=new Map();
    for(const [cell,weight] of weights) (weight>0?positive:negative).set(cell,Math.abs(weight));

    function maximum(region, useSafeCells=false) {
      const uncounted=new Map(region);
      let max=[...uncounted.values()].reduce((sum,weight)=>sum+weight,0);
      const capacities=clues.map(({cells,mines})=>({cells,limit:useSafeCells?cells.length-mines:mines}));
      capacities.sort((a,b)=>a.limit-b.limit);
      for(const {cells,limit} of capacities) {
        const selected=cells.filter(cell=>uncounted.has(cell));
        while(selected.length>limit) {
          // Assign one or more equal-weight layers to this clue. The unused layers can use other clues.
          const layer=Math.min(...selected.map(cell=>uncounted.get(cell)));
          max-=layer*(selected.length-limit);
          for(let i=selected.length-1;i>=0;i--) {
            const cell=selected[i];
            addWeight(uncounted,cell,-layer);
            if(!uncounted.has(cell)) selected.splice(i,1);
          }
        }
      }
      return max;
    }

    const total=region=>[...region.values()].reduce((sum,weight)=>sum+weight,0);
    const positiveMin=total(positive)-maximum(positive,true);
    const negativeMin=total(negative)-maximum(negative,true);
    return {min:positiveMin-maximum(negative),max:maximum(positive)-negativeMin};
  }

  function readout(selected, clueWeights, visible, neighbors, known) {
    const weights=new Map([...selected].filter(([cell])=>!known.has(cell)));
    const clues=[...clueWeights].filter(([cell])=>visible[cell]>=0).sort(([a],[b])=>a-b);
    const remainder=new Map(weights);
    let clueTotal=0;
    function clueAt(cell) {
      const cells=[];
      let mines=visible[cell];
      for(const neighbor of neighbors[cell]) {
        if(known.has(neighbor)) mines-=known.get(neighbor);
        else cells.push(neighbor);
      }
      return {cells,mines};
    }
    for(const [cell,weight] of clues) {
      const {cells,mines}=clueAt(cell);
      clueTotal+=weight*mines;
      for(const neighbor of cells) addWeight(remainder,neighbor,-weight);
    }
    const nearby=new Set();
    for(const region of [weights,remainder]) for(const cell of region.keys()) {
      for(const neighbor of neighbors[cell]) if(visible[neighbor]>=0) nearby.add(neighbor);
    }
    const constraints=[...nearby].sort((a,b)=>a-b).map(clueAt).filter(({cells,mines})=>mines>=0&&mines<=cells.length);
    const {min,max}=constrainedBounds(weights,constraints);
    const rest=constrainedBounds(remainder,constraints);
    return {weights,clues,min,max,remainder,remainderMin:clueTotal+rest.min,remainderMax:clueTotal+rest.max};
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

  return {history,bounds,readout,unknown,knownCells,boundaryLoops,contour,area:(cell,opened,width)=>opened[cell]>=0?adj(width,opened.length/width)[cell]:[cell]};
}

if(typeof module!=='undefined') module.exports=makeRegionSelection;
