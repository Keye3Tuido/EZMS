const test=require('node:test');
const assert=require('node:assert/strict');
const makeSelection=require('./region-selection');

const selection=makeSelection((w,h)=>Array.from({length:w*h},(_,cell)=>{
  const x=cell%w,y=Math.floor(cell/w),cells=[];
  for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++)
    if((dx||dy)&&x+dx>=0&&x+dx<w&&y+dy>=0&&y+dy<h) cells.push(cell+dy*w+dx);
  return cells;
}));

test('signed regions add together and cancel cell-by-cell',()=>{
  const history=selection.history();
  history.select([1,2,3],undefined,1);
  history.select([2,3,4],undefined,-1);
  assert.deepEqual([...history.weights],[[1,1],[4,-1]]);
});

test('bounds use only public fixed cells and binary bounds for unknown cells',()=>{
  const weights=new Map([[0,2],[1,1],[2,-1]]);
  const result=selection.bounds(weights,new Map([[0,1]]));
  assert.equal(result.min,1);
  assert.equal(result.max,3);
  assert.deepEqual(result.positive,[0,1]);
  assert.deepEqual(result.negative,[2]);
});

test('扣除已知邻格后，完整线索邻域得到唯一的带符号加权雷数',()=>{
  const ns=require('./engine').adj(4,4);
  const visible=Array(16).fill(-1);
  visible[5]=3;
  const known=new Map([[5,0],[0,1],[1,0]]);
  const cells=selection.unknown(ns[5],known);
  const weights=new Map(cells.map(cell=>[cell,-2]));
  const find=()=>selection.singleClue(weights,new Map(),visible,ns,known);
  assert.deepEqual(find(),{clue:5,coefficient:-2,cells,total:-4});
  weights.set(cells[0],-1);
  assert.equal(find(),undefined);
  weights.delete(cells[0]);
  assert.equal(find(),undefined);
  weights.set(cells[0],-2);
  visible[5]=1;
  assert.equal(find().total,0);
  visible[5]=0;
  assert.equal(find(),undefined);
});

test('手动选区和混合选区中的完整线索邻域均归并为一个线索项',()=>{
  const ns=require('./engine').adj(5,5);
  const visible=Array(25).fill(-1);
  for(const [cell,count] of [[5,1],[6,2],[11,3],[15,3],[22,2]]) visible[cell]=count;
  const known=selection.knownCells({visible,flags:[],proven:[],manual:[],red:[]});
  const selected=new Map(ns[22].map(cell=>[cell,1]));
  const {regions}=require('./proof-format');
  for(const clues of [new Map(),new Map([[5,1],[6,-1],[11,1]])]) {
    const result=selection.readout(selected,clues,visible,ns,known,
      region=>selection.regionTerms(region,5,known,cells=>regions(cells,5,5,visible)));
    assert.deepEqual(result.terms,[{clue:22,coefficient:1,cells:selection.unknown(ns[22],known)}]);
    assert.deepEqual([...result.weights],[...selected]);
  }
});

test('项数相同时线索邻域优先于矩形，正系数项统一排在前面',()=>{
  const w=5,h=5,ns=require('./engine').adj(w,h), {regions}=require('./proof-format');
  const visible=Array(w*h).fill(-1);
  visible[0]=1;
  const known=selection.knownCells({visible,flags:[],proven:[],manual:[],red:[]});
  const weights=new Map([[1,-1],[5,-1],[6,-1],[23,1],[24,1],[9,1]]);
  const {terms}=selection.readout(weights,new Map(),visible,ns,known,
    region=>selection.regionTerms(region,w,known,cells=>regions(cells,w,h,visible)));
  assert.deepEqual(terms,[{coefficient:1,cells:[23,24]},{coefficient:1,cells:[9]},
    {clue:0,coefficient:-1,cells:[1,5,6]}]);
});

test('全盘可以用一个矩形表示时，优先合并为一项',()=>{
  const engine=require('./engine'), format=require('./proof-format');
  const {visible,board:{w,h,ns}}=require('./position-seed')(engine.adj).decode("C('JKn6a1FFf31{");
  const known=selection.knownCells({visible,flags:[],proven:[],manual:[],red:[]});
  const weights=new Map(visible.flatMap((value,cell)=>value<0?[[cell,1]]:[]));
  const geometric=region=>selection.regionTerms(region,w,known,cells=>format.regions(cells,w,h,visible));
  const {terms}=selection.readout(weights,new Map(),visible,ns,known,geometric);
  assert.deepEqual(terms,[{coefficient:1,cells:[...weights.keys()]}]);
});

test('明确选择的矩形保留已知边界，撤销和重做一起恢复',()=>{
  const w=4,h=3, ns=require('./engine').adj(w,h), format=require('./proof-format');
  const visible=[1,-1,-1,1,1,-1,-1,-1,0,-1,-1,-1];
  const known=selection.knownCells({visible,flags:[],proven:[],manual:[],red:[]});
  const history=selection.history();
  const rectangle=[0,0,4,1];
  history.select([1,2],undefined,1,rectangle);
  const read=()=>selection.readout(history.weights,history.clueWeights,visible,ns,known,
    region=>selection.regionTerms(region,w,known,cells=>format.regions(cells,w,h,visible)),w,history.rectangleWeights);
  assert.deepEqual(read().terms,[{coefficient:1,cells:[1,2],rectangle}]);
  assert.equal(history.undo(),true);
  assert.deepEqual(read().terms,[]);
  assert.equal(history.redo(),true);
  assert.deepEqual(read().terms,[{coefficient:1,cells:[1,2],rectangle}]);
  assert.equal(format.rectangleLabel(rectangle,w),'A1:D1');
});

test('两倍线索邻域减去一个矩形，比逐个拆分正负区域更短',()=>{
  const {regions}=require('./proof-format');
  for(const [w,h,left,top] of [[5,5,0,0],[24,20,0,0],[24,20,10,8]]) {
    const ns=require('./engine').adj(w,h);
    const visible=Array(w*h).fill(-1);
    const clue=(top+2)*w+left+2;
    visible[clue]=2;
    const known=new Map([[clue,0]]);
    const clueCells=selection.unknown(ns[clue],known);
    const rectangleCells=Array.from({length:16},(_,i)=>(top+Math.floor(i/4))*w+left+i%4)
      .filter(cell=>cell!==clue);
    const weights=new Map(rectangleCells.map(cell=>[cell,clueCells.includes(cell)?1:-1]));
    const {terms}=selection.readout(weights,new Map(),visible,ns,known,
      region=>selection.regionTerms(region,w,known,cells=>regions(cells,w,h,visible)),w);
    assert.deepEqual(terms,[{clue,coefficient:2,cells:clueCells},{coefficient:-1,cells:rectangleCells}]);
  }
});

test('外扩超过预算时仍检查实际选区内的两项表达',()=>{
  const w=24,h=20, ns=require('./engine').adj(w,h), {regions}=require('./proof-format');
  const visible=Array(w*h).fill(-1), clue=8*w+9;
  visible[clue]=2;
  const known=new Map([[clue,0]]), clueCells=selection.unknown(ns[clue],known);
  const rectangle=Array.from({length:12},(_,i)=>(4+Math.floor(i/2))*w+8+i%2).filter(cell=>cell!==clue);
  const weights=new Map(clueCells.map(cell=>[cell,1]));
  for(const cell of rectangle) weights.set(cell,(weights.get(cell)??0)-2);
  const {terms}=selection.readout(weights,new Map(),visible,ns,known,
    region=>selection.regionTerms(region,w,known,cells=>regions(cells,w,h,visible)),w);
  assert.deepEqual(terms,[{clue,coefficient:1,cells:clueCells},{coefficient:-2,cells:rectangle}]);
});

test('两个重叠矩形可以更简洁地表示不同系数的选区',()=>{
  const {regions}=require('./proof-format');
  const weights=new Map([[0,2],[1,1],[5,1]]);
  const terms=selection.regionTerms(weights,5,new Map(),cells=>regions(cells,5,5));
  assert.deepEqual(terms,[{coefficient:1,cells:[0,1]},{coefficient:1,cells:[0,5]}]);
});

test('矩形减去未开格的缺口可以简化选区表达式',()=>{
  const {regions}=require('./proof-format');
  const selectionWeights=new Map([[0,1],[1,1],[2,1],[3,1],[5,1],[6,1],[7,1],[8,1]]);
  const terms=selection.regionTerms(selectionWeights,3,new Map(),cells=>regions(cells,3,3));
  assert.deepEqual(terms,[{coefficient:1,cells:[0,1,2,3,4,5,6,7,8]},{coefficient:-1,cells:[4]}]);
});

test('known clues, flags and red marks are excluded from selected variable regions',()=>{
  const known=selection.knownCells({visible:[-1,2,-1,-1,-1,-1],flags:[3],proven:[4],
    manual:new Map([[5,'safe']]),red:new Map([[1,{symbol:'x'}],[2,{symbol:'/'}]])});
  assert.deepEqual(selection.unknown([0,1,2,3,4,5],known),[0]);
});

test('interior opened numbers remain excluded from the visible selection preview',()=>{
  const visible=Array(25).fill(-1);
  visible[12]=1; visible[13]=1; visible[17]=1; visible[18]=1;
  const known=selection.knownCells({visible,flags:[],proven:[],manual:new Map(),red:new Map()});
  const ring=[6,7,8,11,14,16,19,21,22,23];
  const weights=new Map(ring.map(cell=>[cell,1]));
  const preview=selection.bounds(new Map([...weights].filter(([cell])=>!known.has(cell))),new Map());
  assert.deepEqual(preview.positive,ring);
  assert.ok([12,13,17,18].every(cell=>!preview.positive.includes(cell)));
});

test('selection boundaries keep an enclosed number block as a hole',()=>{
  const cells=[0,1,2,5,7,10,12,14];
  const loops=selection.boundaryLoops(cells,5,5);
  assert.equal(loops.length,2);
  assert.ok(loops.some(loop=>loop.length>10));
  assert.ok(loops.some(loop=>loop.length===5));
});

test('adjacent and diagonal cells produce one rounded contour with no interior seams',()=>{
  const grid={x:10,y:20,dx:16,dy:16,radius:3,inset:1};
  const path=selection.contour([0,1,5],3,3,grid);
  assert.equal((path.match(/M/g)??[]).length,1);
  assert.equal((path.match(/Z/g)??[]).length,1);
  assert.match(path,/Q/);
});

test('contours preserve holes and do not bridge across an opposing region',()=>{
  const grid={x:0,y:0,dx:20,dy:20,radius:3,inset:1};
  const ring=selection.contour([0,1,2,3,5,6,7,8],3,3,grid);
  assert.equal((ring.match(/Z/g)??[]).length,2);
  const checkerboard=selection.contour([0,3],2,2,grid,new Set([1,2]));
  assert.equal((checkerboard.match(/Z/g)??[]).length,2);
});

test('selection undo and redo restore both the weighted area and its clue coefficients',()=>{
  const history=selection.history();
  assert.equal(history.canUndo,false);
  assert.equal(history.canRedo,false);
  history.select([1,2],7,1);
  history.select([2,3],8,-1);
  assert.deepEqual(history.weights,new Map([[1,1],[3,-1]]));
  assert.deepEqual(history.clueWeights,new Map([[7,1],[8,-1]]));
  assert.equal(history.undo(),true);
  assert.deepEqual(history.weights,new Map([[1,1],[2,1]]));
  assert.deepEqual(history.clueWeights,new Map([[7,1]]));
  assert.equal(history.redo(),true);
  assert.deepEqual(history.weights,new Map([[1,1],[3,-1]]));
  assert.deepEqual(history.clueWeights,new Map([[7,1],[8,-1]]));
});

test('clearing the selection is reversible and a new edit discards the redo branch',()=>{
  const history=selection.history();
  history.select([2,3],7,1);
  history.select([2,3],7,1);
  assert.equal(history.clear(),true);
  assert.equal(history.weights.size+history.clueWeights.size,0);
  assert.equal(history.undo(),true);
  assert.deepEqual(history.weights,new Map([[2,2],[3,2]]));
  assert.deepEqual(history.clueWeights,new Map([[7,2]]));
  assert.equal(history.redo(),true);
  assert.equal(history.weights.size+history.clueWeights.size,0);
  assert.equal(history.undo(),true);
  assert.equal(history.select([],undefined,1),false);
  assert.equal(history.canRedo,true);
  history.select([],8,-1);
  assert.equal(history.canRedo,false);
  assert.deepEqual(history.clueWeights,new Map([[7,2],[8,-1]]));
  history.undo();
  history.reset();
  assert.equal(history.weights.size+history.clueWeights.size,0);
  assert.equal(history.canUndo,false);
  assert.equal(history.canRedo,false);
});
