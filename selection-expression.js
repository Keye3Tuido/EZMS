// 用公开线索和带符号的矩形、格子拼出等价选区，页面和后台线程共用。
function makeSelectionExpression() {
  function addWeight(weights,cell,amount) {
    const value=(weights.get(cell)??0)+amount;
    if(value) weights.set(cell,value);
    else weights.delete(cell);
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

  function fitTwoRegions(weights,visible,neighbors,known,width,rectangles,consider) {
    const height=visible.length/width;
    let left=0,top=0,right=width,bottom=height;
    if(visible.length>64) {
      // 矩形只需覆盖有系数的范围，再向外保留完整线索邻域可能占用的两格。
      left=width; top=height; right=bottom=0;
      for(const cell of weights.keys()) {
        const x=cell%width, y=Math.floor(cell/width);
        left=Math.min(left,x); top=Math.min(top,y);
        right=Math.max(right,x+1); bottom=Math.max(bottom,y+1);
      }
      if((right-left)*(bottom-top)>64) return;
      const extended=[Math.max(0,left-2),Math.max(0,top-2),Math.min(width,right+2),Math.min(height,bottom+2)];
      if((extended[2]-extended[0])*(extended[3]-extended[1])<=64) {
        [left,top,right,bottom]=extended;
      }
    }
    const shapes=new Map(), unknownCells=[];
    const key=cells=>cells.join(',');
    const add=shape=>{
      const id=key(shape.cells);
      if(id && !shapes.has(id)) shapes.set(id,shape);
    };
    const inside=cell=>cell%width>=left && cell%width<right &&
      Math.floor(cell/width)>=top && Math.floor(cell/width)<bottom;
    for(const shape of rectangles) if(shape.cells.every(inside)) add(shape);
    for(let y=top;y<bottom;y++) for(let x=left;x<right;x++) {
      const cell=y*width+x;
      if(!known.has(cell)) unknownCells.push(cell);
      if(visible[cell]>=0) {
        const cells=unknown(neighbors[cell],known).sort((a,b)=>a-b);
        if(cells.every(inside)) add({clue:cell,cells});
      }
    }
    for(let y1=top;y1<bottom;y1++) for(let y2=y1+1;y2<=bottom;y2++) {
      for(let x1=left;x1<right;x1++) for(let x2=x1+1;x2<=right;x2++) {
        const cells=[];
        for(let y=y1;y<y2;y++) for(let x=x1;x<x2;x++) {
          const cell=y*width+x;
          if(!known.has(cell)) cells.push(cell);
        }
        add({cells});
      }
    }
    for(const first of shapes.values()) {
      const included=new Set(first.cells);
      const anchor=first.cells.find(cell=>weights.has(cell));
      if(anchor===undefined) continue;
      const outside=unknownCells.find(cell=>weights.has(cell) && !included.has(cell));
      // 第一项外有非零格时，第二项系数由该格确定。否则第二项包含在第一项中。
      const coefficients=outside===undefined?new Set(first.cells.map(cell=>weights.get(cell)))
        :[weights.get(anchor),weights.get(anchor)-weights.get(outside)];
      for(const coefficient of coefficients) {
        if(!coefficient) continue;
        const remaining=[];
        let other=0;
        for(const cell of unknownCells) {
          const value=(weights.get(cell)??0)-(included.has(cell)?coefficient:0);
          if(!value) continue;
          if(other && other!==value) {other=0;break;}
          other=value;
          remaining.push(cell);
        }
        const second=other && shapes.get(key(remaining));
        if(second) consider([{...first,coefficient},{...second,coefficient:other}]);
      }
    }
  }

  function readout(selected,clueWeights,visible,neighbors,known,regionTerms,width,rectangleWeights=[]) {
    const weights=new Map([...selected].filter(([cell])=>!known.has(cell)));
    const adjacent=new Map();
    for(const v of weights.keys()) for(const clue of neighbors[v]) {
      if(visible[clue]>=0 && !adjacent.has(clue)) adjacent.set(clue,unknown(neighbors[clue],known));
    }
    const byPreference=([a,left],[b,right])=>right.length-left.length ||
      Number(clueWeights.has(b))-Number(clueWeights.has(a)) || a-b;
    const clues=[...adjacent].sort(byPreference);
    const rectangles=[];
    for(const [key,coefficient] of rectangleWeights) {
      const rectangle=key.split(',').map(Number);
      const [left,top,right,bottom]=rectangle;
      const cells=[];
      for(let y=top;y<bottom;y++) for(let x=left;x<right;x++) {
        const cell=y*width+x;
        if(!known.has(cell)) cells.push(cell);
      }
      if(cells.some(cell=>weights.has(cell))) rectangles.push({coefficient,cells,rectangle});
    }

    function score(terms) {
      return [terms.length,terms.filter(term=>term.clue===undefined && !term.rectangle && term.cells.length===1).length,
        -terms.filter(term=>term.rectangle).length,-terms.filter(term=>term.clue!==undefined).length];
    }
    let best=regionTerms(weights), bestScore=score(best);
    function consider(terms) {
      const candidate=score(terms);
      for(let i=0;i<candidate.length;i++) {
        if(candidate[i]===bestScore[i]) continue;
        if(candidate[i]<bestScore[i]) {best=terms;bestScore=candidate;}
        break;
      }
    }
    function removeTerm(rest,{cells,coefficient}) {
      for(const cell of cells) addWeight(rest,cell,-coefficient);
    }
    function fitClues(rest,prefix=[]) {
      const terms=[...prefix];
      for(const [clue,cells] of clues) {
        if(terms.length>=best.length && rest.size) return;
        const sign=Math.sign(rest.get(cells[0])??0);
        if(!sign || cells.some(cell=>Math.sign(rest.get(cell)??0)!==sign)) continue;
        const coefficient=sign*Math.min(...cells.map(cell=>Math.abs(rest.get(cell))));
        const term={clue,coefficient,cells};
        terms.push(term);
        removeTerm(rest,term);
      }
      if(terms.length<best.length || !rest.size) consider([...terms,...regionTerms(rest)]);
    }
    function tryPrefix(prefix) {
      if(!prefix.length || prefix.length>best.length) return;
      const rest=new Map(weights);
      for(const term of prefix) removeTerm(rest,term);
      if(prefix.length===best.length && rest.size) return;
      consider([...prefix,...regionTerms(rest)]);
      if(rest.size && prefix.length<best.length) fitClues(rest,prefix);
    }

    for(const [clue,cells] of clues) {
      const coefficient=weights.get(cells[0]);
      if(cells.length===weights.size && cells.every(cell=>weights.get(cell)===coefficient)) {
        consider([{clue,cells,coefficient}]);
      }
    }
    fitClues(new Map(weights));
    const clicked=clues.filter(([clue])=>clueWeights.has(clue)).map(([clue,cells])=>({clue,cells,coefficient:clueWeights.get(clue)}));
    tryPrefix(clicked);
    tryPrefix(rectangles);
    tryPrefix([...rectangles,...clicked]);
    // 先试与当前系数最接近的已选矩形或线索，剩余差值可用矩形、线索和单格补齐。
    const correction=(cells,coefficient)=>cells.reduce((delta,cell)=>{
      const value=weights.get(cell)??0;
      return delta+Math.abs(value)-Math.abs(value-coefficient);
    },0);
    for(const term of rectangles.map(term=>({term,gain:correction(term.cells,term.coefficient)}))
      .sort((a,b)=>b.gain-a.gain).slice(0,8).map(({term})=>term)) tryPrefix([term]);
    if(best.length>1 && weights.size<=128 && visible.length<=1024) {
      const proposals=[];
      for(const [clue,cells] of clues) for(const coefficient of new Set(cells.map(cell=>weights.get(cell)).filter(Boolean))) {
        const gain=correction(cells,coefficient);
        if(gain>0) proposals.push({clue,cells,coefficient,gain});
      }
      for(const {gain,...term} of proposals.sort((a,b)=>b.gain-a.gain).slice(0,12)) tryPrefix([term]);
    }
    if(best.length>2 && width) fitTwoRegions(weights,visible,neighbors,known,width,rectangles,consider);
    const kind=term=>term.clue!==undefined?0:term.rectangle || term.cells.length>1?1:2;
    best.sort((a,b)=>Number(b.coefficient>0)-Number(a.coefficient>0) || kind(a)-kind(b));
    return {weights,terms:best};
  }

  function unknown(cells, known) {
    return cells.filter(cell=>!known.has(cell));
  }

  return {addWeight,unknown,regionTerms,singleClue,readout};
}

if(typeof module!=='undefined') module.exports=makeSelectionExpression;
