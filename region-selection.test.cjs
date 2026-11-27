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
