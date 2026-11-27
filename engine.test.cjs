const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('./engine');
const format = require('./proof-format');
const positionSeeds = require('./position-seed')(engine.adj);
const {manualStepAction,checkPositionMarks,restoreManualMarks,inkTrails} = require('./board-input');
const sampleBits='1000000102211220022002201000000110122101102222011020020110011001';
const sampleSeed='Z#&!#ktdfIF_HvWqUJ';

test('position seed preserves mine positions, open clues, flags and red marks, but omits both blue layers', () => {
  const position=positionSeeds.create(3,2,'124500');
  const red=new Map([[1,{symbol:'s',level:0}],[4,{symbol:'x',level:0}]]);
  const notes={layers:{red,blue:new Map([[2,{symbol:'\u028c',level:3}],[0,{symbol:'o',level:0}]]),archivedBlue:new Map([[4,{symbol:'x',level:0}]])}};
  const manual={marked:new Map([[4,'safe'],[0,'mine']])};
  const seed=positionSeeds.encode({...position,flags:new Set(position.flags),notes,manual});
  assert.equal(seed,positionSeeds.encode({...position,notes:{layers:{red}},manual}));
  const weighted={...manual,weights:new Map([[4,-2],[0,3]])};
  assert.equal(positionSeeds.encode({...position,notes,manual:weighted}),seed);
  const restored=positionSeeds.decode(`  ${seed}\n`);
  assert.match(seed,/^[\x21\x23-\x5b\x5d-\x7e]+$/);
  assert.deepEqual(restored.board,position.board);
  assert.deepEqual(restored.visible,[-1,2,-1,-1,-1,-1]);
  assert.deepEqual(restored.flags,[2,3]);
  assert.deepEqual(restored.notes,[[[0,{symbol:'x',level:0}],[4,{symbol:'s',level:0}]],[]]);
  assert.equal(red.get(4).symbol,'x');
  assert.equal(positionSeeds.encode(restored),seed);
});

test('position marks distinguish contradictions from guesses, regardless of the hidden layout', () => {
  const red=[[0,{symbol:'x',level:0}],[1,{symbol:'s',level:0}],[4,{symbol:'s',level:0}]];
  const pos=positionSeeds.create(5,1,'21050');
  const draft=positionSeeds.decode(positionSeeds.encode({...pos,notes:[red]}));
  const numbers=positionSeeds.decode(positionSeeds.encode({
    ...positionSeeds.numbers(5,1,2,'1....',draft.flags),notes:[red],
  }));
  for(const {board,visible,flags,notes} of [draft,numbers]) {
    const {state}=engine.classify(board,visible);
    assert.deepEqual(state,['open','mine','either','either','either']);
    assert.deepEqual(checkPositionMarks(state,flags,notes[0]),[
      {cell:3,mark:'flag',conflict:false},
      {cell:1,mark:'slash',conflict:true},
      {cell:4,mark:'slash',conflict:false},
    ]);
  }
  const wrong=positionSeeds.create(3,1,'240');
  assert.deepEqual(checkPositionMarks(engine.classify(wrong.board,wrong.visible).state,wrong.flags,[]),[
    {cell:1,mark:'flag',conflict:true},
  ]);
});

test('restored confirmations retain their batch but do not duplicate open cells or flags', () => {
  const {board,visible}=positionSeeds.create(3,1,'210');
  const {state}=engine.classify(board,visible);
  const cross={symbol:'x',level:0}, slash={symbol:'/',level:0};
  const red=[[0,slash],[1,cross],[2,slash]];
  for(const flags of [new Set(),new Set([1])]) {
    const history=require('./board-input')();
    history.layers.red=new Map(red);
    assert.deepEqual(checkPositionMarks(state,flags,history.layers.red),[]);
    const restored=restoreManualMarks(state,flags,engine.confirmationTargets,history);
    assert.equal(manualStepAction(restored),'commit');
    assert.deepEqual([...restored.marked],flags.size?[[2,'safe']]:[[1,'mine'],[2,'safe']]);
    assert.equal(history.layers.red.size,0);
  }
  const finished=positionSeeds.create(3,1,'252');
  const finishedState=engine.classify(finished.board,finished.visible).state;
  assert.deepEqual(checkPositionMarks(finishedState,finished.flags,red),[]);
  assert.deepEqual(checkPositionMarks(finishedState,finished.flags,[[1,slash]]),[
    {cell:1,mark:'slash',conflict:true},
  ]);
});

test('red strokes overwrite or erase in one undoable operation without touching blue marks', () => {
  const h=require('./board-input')(), cross={symbol:'x',level:0}, slash={symbol:'/',level:0};
  h.edit('blue',[[1,cross]]);
  h.edit('red',[[1,slash]]);
  const draw=h.stroke('red',0,cross);
  [0,1,1,2].forEach(draw.visit); draw.finish();
  assert.deepEqual([...h.layers.red.values()],[cross,cross,cross]);
  const erase=h.stroke('red',0,cross);
  [0,1].forEach(erase.visit); erase.finish();
  assert.deepEqual([...h.layers.red],[[2,cross]]);
  h.undo(); assert.equal(h.layers.red.size,3);
  h.undo(); assert.deepEqual([...h.layers.red],[[1,slash]]);
  h.redo(); h.clear('red');
  assert.equal(h.layers.red.size,0);
  h.undo(); assert.equal(h.layers.red.size,3);
  assert.deepEqual([...h.layers.blue],[[1,cross]]);
});

test('opening cells prunes all mark layers and both history stacks without losing other cells in a stroke', () => {
  const h=require('./board-input')(), cross={symbol:'x',level:0}, slash={symbol:'/',level:0};
  const draw=h.stroke('red',1,cross);
  [1,2].forEach(draw.visit); draw.finish();
  h.edit('archivedBlue',[[1,slash]]);
  h.edit('blue',[[1,slash],[2,slash]]);
  h.undo();
  h.discardCells([1]);
  for(const layer of Object.values(h.layers)) assert.equal(layer.has(1),false);
  assert.equal(h.canUndo,true);
  h.redo();
  assert.deepEqual([...h.layers.blue],[[2,slash]]);
  h.undo(); h.undo();
  assert.equal(h.layers.red.size,0);
  assert.equal(h.canUndo,false);
  h.redo();
  assert.deepEqual([...h.layers.red],[[2,cross]]);
  h.redo();
  assert.deepEqual([...h.layers.blue],[[2,slash]]);
});

test('Base92 folds the dimensions and position type into a short header', () => {
  const mine=positionSeeds.create(8,8,sampleBits);
  assert.equal(positionSeeds.encode(mine),sampleSeed);
  assert.equal(sampleSeed.length,18);
  assert.deepEqual(positionSeeds.decode(sampleSeed),mine);
  const numeric=positionSeeds.numbers(3,2,1,'...1..',[0]);
  const text=positionSeeds.encode(numeric);
  assert.equal(text.length,6);
  assert.deepEqual(positionSeeds.decode(text),numeric);
  assert.equal(positionSeeds.encode(positionSeeds.create(1,1)).length,1);
});

test('position seeds only accept the new Base92 format', () => {
  for(const old of ['MS1.WzgsOCwiMTAwMDAwMDEwMjIxMTIyMDAyMjAwMjIwMTAwMDAwMDExMDEyMjEwMTEwMjIyMjAxMTAyMDAyMDExMDAxMTAwMSIsW10sW11d',
    'MS2.WzMsMiwxLCIuLi4xLi4iLFswXSxbXSxbXV0','MS3.m)""&!#ktdfIF_HvWqUJ','MS3.m)',
    '8#Ve~!%~!!$*f','8#Ve~!~!!$*f']) {
    assert.throws(()=>positionSeeds.decode(old),/无效/);
  }
  const current='8#Ve';
  assert.equal(positionSeeds.encode(positionSeeds.decode(current)),current);
});

test('Base92 note records preserve every mark across radix boundaries', () => {
  const p=positionSeeds.create(92,1);
  const red=new Map(Array.from({length:92},(_,i)=>[i,{symbol:i%2?'s':'x',level:0}]));
  const position={...p,flags:new Set(),notes:{layers:{red,blue:new Map()}}};
  const text=positionSeeds.encode(position);
  const restored=positionSeeds.decode(text);
  assert.deepEqual(restored.notes[0],[...red]);
});

test('numeric Base92 seeds preserve public digits, flags and covered red notes, and omit blue notes', () => {
  const draft=positionSeeds.numbers(4,3,5,'.0123.45678.',[0,5]);
  const position={...draft,flags:new Set(draft.flags),notes:{layers:{red:new Map([[2,{symbol:'x',level:0}],[9,{symbol:'s',level:0}],[11,{symbol:'s',level:0}]]),blue:new Map([[3,{symbol:'v',level:2}],[10,{symbol:'//',level:99}]])}}};
  const seed=positionSeeds.encode(position);
  assert.equal(seed,positionSeeds.encode(positionSeeds.numbers(4,3,5,'.0123.45678.',[0,5],[[11,1,0]])));
  assert.match(seed,/~~/);
  assert.match(seed,/~!/);
  const restored=positionSeeds.decode(seed);
  assert.deepEqual(restored.visible,draft.visible);
  assert.deepEqual(restored.flags,draft.flags);
  assert.deepEqual(restored.notes,[[[11,{symbol:'s',level:0}]],[]]);
  assert.equal(positionSeeds.encode(restored),seed);
});

test('Base92 import drops hidden red marks from open cells without losing covered marks or flags', () => {
  const reported=positionSeeds.decode('F!#~~~!!');
  assert.deepEqual(reported.visible,[0,-1,1,-1,-1]);
  assert.deepEqual(reported.notes,[[],[]]);
  assert.equal(positionSeeds.encode(reported),positionSeeds.encode(positionSeeds.create(5,1,'20210')));

  for(const seed of ["@!%o~!!')","A!#Ng~!!')"]) {
    const p=positionSeeds.decode(seed);
    assert.deepEqual(p.visible,[1,-1,-1,0]);
    assert.deepEqual(p.flags,[1]);
    assert.deepEqual(p.notes,[[[2,{symbol:'s',level:0}]],[]]);
    assert.deepEqual(positionSeeds.decode(positionSeeds.encode(p)),p);
  }
});

test('compact Base92 seeds reject malformed headers, cells and field separators', () => {
  for(const bad of ['',null,'~','#','&','P!','&!','!%','!!','! $','!"','!\\','!~!','!~#','!~']) {
    assert.throws(()=>positionSeeds.decode(bad),/无效/);
  }
  let adjCalls=0;
  const guarded=require('./position-seed')(()=>{adjCalls++;return [];});
  const large=positionSeeds.encode(positionSeeds.create(257,256));
  assert.throws(()=>guarded.decode(large.slice(0,-1)),/无效/);
  assert.equal(adjCalls,0);
});

test('position seed rejects invalid dimensions, incompatible cell states and unsafe notes', () => {
  for(const args of [[0,2,''],[65536,65536,'0'],[2,2,'000'],[2,2,'3000'],[2,2,'6000']]) {
    assert.throws(()=>positionSeeds.create(...args),/无效/);
  }
  for(const red of [[[4,0,0]],[[1,0,0],[1,0,0]],[[1,'<b>',0]],[[1,7,1]],[[1,0,2]]]) {
    assert.throws(()=>positionSeeds.numbers(2,2,0,'....',[],red),/无效/);
  }
  for(const seed of ['*~!*','*~!$$','*~!~!!']) assert.throws(()=>positionSeeds.decode(seed),/无效/,seed);
});

test('large and single-cell positions round trip both seed formats without an encoded length limit', () => {
  for (const [w,h] of [[1,1],[28,25],[200,200],[257,256]]) {
    for (const draft of [positionSeeds.create(w,h),positionSeeds.numbers(w,h)]) {
      const text=positionSeeds.encode({...draft,flags:new Set(draft.flags),notes:undefined});
      if(w<=200) assert.ok(text.length<=10,`Blank seed too long: ${text.length}`);
      assert.deepEqual(positionSeeds.decode(text),draft);
    }
  }
  assert.equal(format.coordinate(25,28),'Z1');
  assert.equal(format.coordinate(26,28),'AA1');
  assert.equal(format.label([27,55],28,2),'AB列');
});

test('Base92 uses sparse records when only a few distant cells differ', () => {
  const bits='0'.repeat(39999)+'5', draft=positionSeeds.create(200,200,bits);
  const seed=positionSeeds.encode(draft);
  assert.ok(seed.length<20);
  assert.deepEqual(positionSeeds.decode(seed),draft);
});

test('number drafts round trip without a hidden layout and validate all public clues', () => {
  const draft=positionSeeds.numbers(3,2,1,'...1..',[0]);
  const text=positionSeeds.encode({...draft,flags:new Set(draft.flags),notes:undefined});
  assert.deepEqual(positionSeeds.decode(text),draft);
  assert.equal(draft.board.bombs.some(Boolean),false);
  const {board}=engine.publicBoard(draft.board,draft.visible);
  assert.equal(board.bombs.filter(Boolean).length,1);
  assert.deepEqual(engine.opening(board),draft.visible);
  const invalid=positionSeeds.numbers(3,2,1,'8.....');
  const noFlags=positionSeeds.encode(invalid);
  assert.deepEqual(positionSeeds.decode(noFlags),invalid);
  assert.equal(engine.publicBoard(invalid.board,invalid.visible).status,'invalid');
  assert.equal(engine.inspect(invalid.board,invalid.visible).status,'invalid');
});

test('global total yields a minimum technique proof and full replay for the imported board', () => {
  const {board,visible}=positionSeeds.decode(sampleSeed);
  assert.equal(board.mines,18);
  const hint=engine.hint(board,visible,[],[],{opening:true});
  assert.ok(hint.move.positionMinimum && hint.move.sources.includes(-1));
  assert.equal(hint.move.sources.length,11);
  const checked=engine.inspect(board,visible);
  assert.deepEqual([checked.status,checked.safe,checked.mines,checked.clues],['deducible',14,10,11]);
  const first=hint.move, confirmed=[...first.safe,...first.mines];
  assert.ok(first.safe.includes(26) && !first.safe.includes(29)); // C4, not F4
  const second=engine.hint(board,visible,[],[],{opening:true,excluded:confirmed}).move;
  const mirror=v=>v<0?v:v-v%8+7-v%8;
  assert.deepEqual(second.sources.slice().sort((a,b)=>a-b),first.sources.map(mirror).sort((a,b)=>a-b));
  assert.deepEqual(second.safe.filter(v=>!confirmed.includes(v)),[29]);
  assert.deepEqual(second.mines.filter(v=>!confirmed.includes(v)),[]);
  const fixed=engine.classify(board,visible).state.flatMap((s,i)=>['safe','mine'].includes(s)?[[i,s]]:[]);
  assert.equal(engine.hint(board,visible,[],[],{opening:true,confirmed:fixed}).status,'confirmed');
  const report=engine.verify(board,board,{certify:true,useTotal:true});
  assert.equal(report.status,'passed');
  assert.equal(report.steps,24);
});

test('staged hints substitute a confirmed safe square before counting clues', () => {
  const p={w:6,h:1,mines:2}, visible=[0,-1,-1,1,1,-1];
  const first=engine.hint(p,visible,[],[]).move;
  assert.deepEqual(first.safe,[1]);
  const next=engine.hint(p,visible,[],[],{confirmed:[[1,'safe']]}).move;
  assert.deepEqual(next.mines,[2]);
  assert.deepEqual(next.sources,[3]);
  assert.equal(visible[1],-1);
});

test('a selected target has its own minimum, recalculated after a red confirmation', () => {
  const {board,visible}=positionSeeds.create(5,1,'20210');
  const before=[...visible], target=3;
  assert.equal(engine.inspect(board,visible).clues,1);
  const selected=engine.hint(board,visible,[],[],{target});
  assert.equal(selected.clues,2);
  assert.deepEqual(selected.move.sources,[0,2]);
  assert.deepEqual(selected.move.safe,[1]);
  assert.deepEqual(selected.move.mines,[3]);
  const changed=engine.hint(board,visible,[],[],{target,confirmed:[[1,'safe']]});
  assert.equal(changed.clues,1);
  assert.deepEqual(changed.move.sources,[2]);
  assert.deepEqual(changed.move.safe,[]);
  assert.deepEqual(changed.move.mines,[3]);
  assert.equal(engine.hint(board,visible,[],[],{target,confirmed:[[3,'mine']]}).status,'confirmed');
  assert.deepEqual(visible,before);
});

test('target hints do not substitute an easier move for an unfixed square', () => {
  const {board,visible}=positionSeeds.create(7,1,'2021001');
  assert.equal(engine.inspect(board,visible).clues,1);
  const selected=engine.hint(board,visible,[],[],{target:5});
  assert.equal(selected.status,'target-unfixed');
  assert.equal(selected.clues,undefined);
  assert.equal(selected.move,null);
});

const reviewPosition=(w,h,bits)=>positionSeeds.create(w,h,bits);

test('the screenshot needs only A4 to prove A5 is a mine after the other red marks', () => {
  const {board,visible,flags}=reviewPosition(5,5,'1221221020000122011210220');
  assert.equal(visible[15],1);
  const redMines=[0,3,6,13,17,18].map(v=>[v,'mine']);
  const redSafe=[7,9,10,11,12,16,21,24].map(v=>[v,'safe']);
  const confirmed=[...redMines,...redSafe];
  const {move}=engine.hint(board,visible,[],flags,{opening:true,confirmed});
  assert.deepEqual(move.sources,[15]);
  assert.deepEqual(move.row,{source:15,vs:[20],rhs:1});
  assert.deepEqual(move.mines,[20]);
  assert.deepEqual(move.safe,[]);
  const next=engine.inspect(board,visible,[],flags,{confirmed});
  assert.deepEqual([next.status,next.clues,next.safe,next.mines],['deducible',1,0,1]);

  const replay=engine.verify(board,board,{certify:true,confirmed,trace:true});
  assert.deepEqual([replay.status,replay.steps,replay.averageClues],['passed',1,1]);
  assert.deepEqual(replay.trace[0].commit,{safe:redSafe.map(([v])=>v),mines:[...redMines.map(([v])=>v),20]});

  confirmed.push([20,'mine']);
  const all=engine.verify(board,board,{certify:true,confirmed});
  assert.deepEqual([all.status,all.steps],['passed',0]);
  assert.deepEqual(engine.inspect(board,visible,[],flags,{confirmed}),{status:'confirmed',safe:0,mines:0});
  assert.deepEqual(visible,engine.opening(board));
  assert.equal(flags.length,0);
});

test('a known red cross subtracts a mine, but a flag or unchecked marking is not evidence', () => {
  const {board,visible}=reviewPosition(5,1,'12010');
  const known=[[0,'mine']];
  const {move}=engine.hint(board,visible,[],[],{confirmed:known});
  assert.deepEqual(move.row,{source:1,vs:[2],rhs:0});
  assert.deepEqual(move.safe,[2]);
  const baseline=engine.inspect(board,visible);
  assert.equal(baseline.status,'blocked');
  assert.deepEqual(engine.inspect(board,visible,[],[0]),baseline);
  assert.deepEqual(engine.inspect(board,visible,[],[],{confirmed:known}),baseline);
});

test('certification does not open a partial round or count it as a solved board', () => {
  const {board,visible}=reviewPosition(6,5,'220122021201112012010010022001');
  const report=engine.verify(board,board,{certify:true,trace:true});
  assert.equal(report.status,'stuck');
  assert.equal(report.opened,engine.opening(board).filter(v=>v>=0).length);
  const confirmed=new Set(report.trace.flatMap(move=>[...move.safe,...move.mines]));
  const targets=engine.confirmationTargets(engine.classify(board,visible).state,new Set());
  assert.deepEqual([...targets].filter(([i])=>!confirmed.has(i)),[[6,'safe'],[27,'safe']]);
  assert.ok(report.trace.every(move=>!move.commit));
});

test('withdrawn proven flags return to the pending round and receive a new red mark', () => {
  const {board}=reviewPosition(4,4,'2010210020002100');
  const initial=engine.verify(board,board,{certify:true,trace:true});
  const round=initial.trace.find(move=>move.commit).commit;
  const visible=engine.opening(board), flags=new Set(round.mines.filter(v=>v!==5));
  for(const v of round.safe) visible[v]=board.clues[v];
  const next=engine.verify(board,board,{visible,marks:round.mines,flags,certify:true,trace:true});
  assert.equal(next.status,'passed');
  assert.ok(next.trace.some(move=>move.mines.includes(5)));
  assert.ok(next.trace.some(move=>move.commit?.mines.includes(5)));
});

test('an imported mine flag does not prevent the next staged hint or serve as evidence', () => {
  const {board,visible,flags}=reviewPosition(4,4,'2520100102022100');
  const first=engine.hint(board,visible,[],flags,{opening:true});
  assert.deepEqual(first.move.safe,[6,10,14]);
  const confirmed=[...first.move.safe.map(v=>[v,'safe']),...first.move.mines.map(v=>[v,'mine'])];
  const second=engine.hint(board,visible,[],flags,{opening:true,confirmed});
  assert.ok(second.move.safe.length || second.move.mines.some(v=>!flags.includes(v)));
  assert.equal(engine.verify(board,board,{flags,certify:true}).status,'passed');
});

test('a pure mine first step can be inspected and certified with array flags', () => {
  const {board,visible,flags}=reviewPosition(4,4,'2120120000021100');
  const first=engine.hint(board,visible,[],flags,{opening:true}).move;
  assert.deepEqual(first.safe,[]);
  assert.deepEqual(first.mines,[1,4]);
  assert.equal(engine.inspect(board,visible,[],flags).status,'deducible');
  assert.equal(engine.verify(board,board,{flags,certify:true}).status,'passed');
});

test('expansion only discloses the fewest new clues on a blocked, feasible position', () => {
  const {board,visible}=positionSeeds.create(3,2,'100000');
  assert.equal(engine.inspect(board,visible).status,'blocked');
  const result=engine.expand(board,visible);
  assert.equal(result.status,'expanded');
  assert.equal(result.cells.length,1);
  assert.equal(result.visible.filter(n=>n>=0).length,1);
  assert.ok(result.cells.every(i=>!board.bombs[i]&&result.visible[i]===board.clues[i]));
  assert.equal(engine.inspect(board,result.visible).status,'deducible');
  assert.equal(engine.expand(board,result.visible).status,'not-blocked');
  assert.equal(engine.expand(board,visible,[],0).status,'budget');
});

test('expansion minimizes actual disclosures when opening a zero can reveal many cells', () => {
  const {board,visible}=positionSeeds.create(4,3,'112000000000');
  assert.equal(engine.inspect(board,visible).status,'blocked');
  assert.equal(engine.reveal(board,visible.slice(),3),9);
  const result=engine.expand(board,visible);
  assert.equal(result.status,'expanded');
  assert.equal(result.cells.length,1);
  assert.equal(result.visible.filter((n,i)=>n>=0&&visible[i]<0).length,1);
  assert.equal(engine.inspect(board,result.visible).status,'deducible');
});

test('position verification accepts all-covered drafts and rejects a stuck route', () => {
  const verify=bits=>{
    const {board}=positionSeeds.create(3,2,bits);
    return engine.verify(board,board,{certify:true,allowEmpty:true,measureDifficulty:false});
  };
  assert.equal(verify('000000').status,'passed');
  assert.equal(verify('500000').status,'stuck');
  const report=verify('500200');
  assert.equal(report.status,'passed');
  assert.ok(report.steps>0);
});

const fixtures = [
  [8, 8, 10, 2940958500, 'passed', 1],
  [16, 16, 40, 1002253454, 'passed', 3],
  [9, 9, 17, 3779232550, 'stuck', 1],
  [12, 12, 31, 419868400, 'stuck', 2],
];
const settings = (w, h, mines) => ({w,h,mines,start:'center',safe:'zero'});
const easy = {minAverage:1,minMultiPercent:0,minPeakClues:1};
const compactFloors={minAverage:1.2,minMultiPercent:10,minPeakClues:2};
const largeFloors={...compactFloors,minMultiPercent:5};
function search(p,seed,limit=96) {
  for(const result of engine.generate(p,seed)) {
    if(result.board || result.tried===limit) return result;
  }
}

test('opening givens are safe and zero clues automatically reveal adjacent cells', () => {
  const p = settings(7,5,6);
  const board = engine.candidate(p,0);
  const safe = board.bombs.flatMap((mine,i) => mine ? [] : [i]);
  const far = safe.find(i => i !== board.first && !board.ns[board.first].includes(i));
  board.opening = [board.first,far];
  const visible = engine.opening(board);
  assert.equal(board.clues[board.first],0);
  assert.ok(board.ns[board.first].every(i=>visible[i]>=0));
  assert.ok(visible[far]>=0);
  assert.equal(visible[far],board.clues[far]);
  assert.throws(() => engine.opening({...board,opening:[board.bombs.indexOf(true)]}),/Invalid opening/);
});

test('number click flags only logically forced mines and preserves the reveal chord', () => {
  const ns=engine.adj(3,2);
  const flags=new Set();
  assert.deepEqual(engine.numberAction(ns,[2,-1,0,-1,1,0],flags,0),{kind:'flag',cells:[1,3]});
  flags.add(1);
  assert.deepEqual(engine.numberAction(ns,[2,-1,0,-1,1,0],flags,0,true),{kind:'flag',cells:[3]});
  assert.deepEqual(engine.numberAction(ns,[1,-1,0,-1,0,0],flags,0),{kind:'open',cells:[3]});
  assert.equal(engine.numberAction(ns,[1,-1,0,-1,0,0],flags,0,true),null);
  assert.equal(engine.numberAction(ns,[1,-1,0,-1,0,0],new Set(),0),null);
  flags.add(3);
  assert.equal(engine.numberAction(ns,[2,-1,0,-1,1,0],flags,0),null);
  assert.equal(engine.numberAction(ns,[0,-1,0,-1,1,0],flags,0),null);
  assert.equal(engine.numberAction(ns,[-1,-1,0,-1,1,0],flags,0),null);
});

test('number click excludes confirmed safe cells and counts confirmed mines', () => {
  const ns=engine.adj(3,3), visible=[-1,-1,-1,-1,1,-1,-1,-1,-1], flags=new Set();
  const confirmed=new Map(Array.from({length:7},(_,i)=>[i<4?i:i+1,'safe']));
  assert.equal(engine.numberAction(ns,visible,flags,4),null);
  assert.deepEqual(engine.numberAction(ns,visible,flags,4,false,confirmed),{kind:'flag',cells:[8]});
  confirmed.set(8,'mine'); confirmed.delete(0);
  assert.deepEqual(engine.numberAction(ns,visible,flags,4,false,confirmed),{kind:'open',cells:[0]});
  assert.equal(engine.numberAction(ns,visible,flags,4,true,confirmed),null);
});

test('classification uses current clues and rejects any cell with a mine-capable layout', () => {
  const p={w:4,h:2,mines:2,start:'random',safe:'safe'};
  const b=engine.candidate(p,14), visible=Array(8).fill(-1);
  engine.reveal(b,visible,b.first);
  const c=engine.classify(p,visible);
  assert.equal(c.status,'complete');
  for(let i=0;i<8;i++) if(visible[i]<0) {
    if(c.state[i]==='safe') assert.equal(engine.gate(c,[i]).status,'safe');
    else assert.notEqual(engine.gate(c,[i]).status,'safe');
  }
  const ambiguous=engine.classify({...p,w:3,h:1,mines:1},[-1,1,-1]);
  assert.equal(engine.gate(ambiguous,[0]).status,'blocked');
  assert.equal(engine.gate(ambiguous,[2]).status,'blocked');
});

test('classification refuses to open cells when the search budget is exhausted', () => {
  const p={w:4,h:2,mines:2,start:'random',safe:'safe'};
  const b=engine.candidate(p,14), visible=Array(8).fill(-1);
  engine.reveal(b,visible,b.first);
  const c=engine.classify(p,visible,{nodeBudget:0});
  assert.equal(c.status,'budget');
  assert.equal(engine.gate(c,[visible.findIndex(v=>v<0)]).status,'unknown');
});

test('number chord refuses the whole batch when a manual flag covers the wrong cell', () => {
  const p={w:3,h:2,mines:1}, visible=[-1,1,-1,-1,-1,-1];
  const flags=new Set([0]), ns=engine.adj(p.w,p.h);
  const chord=engine.numberAction(ns,visible,flags,1);
  assert.equal(chord.kind,'open');
  assert.equal(engine.gate(engine.classify(p,visible),chord.cells).status,'blocked');
  const mixed=engine.classify({w:4,h:1,mines:1},[-1,1,-1,-1]);
  assert.equal(engine.gate(mixed,[3]).status,'safe');
  assert.equal(engine.gate(mixed,[3,0]).status,'blocked');
});

test('safe opening can change the new number while keeping every previous clue and a technique-only solution', () => {
  const p=settings(8,8,16);
  const board=engine.candidate(p,1684164658);
  const current={...p,mines:board.mines}, visible=Array(64).fill(-1), target=6;
  engine.reveal(board,visible,board.first);
  assert.equal(engine.gate(engine.classify(current,visible),[target]).status,'safe');
  const next=engine.advance(board,current,visible,[target]);
  assert.notEqual(next.visible[target],board.clues[target]);
  assert.equal(next.board.bombs.filter(Boolean).length,board.mines);
  for(let i=0;i<64;i++) if(visible[i]>=0) {
    assert.equal(next.visible[i],visible[i]);
    assert.equal(next.board.clues[i],visible[i]);
    assert.equal(next.board.bombs[i],false);
  }
  assert.equal(engine.verify(next.board,current,{visible:next.visible,certify:true}).status,'passed');
});

test('rejects a genuine two-way guess; public total resolves a non-frontier cell', () => {
  const p = {...settings(3,1,1),safe:'safe'};
  const b = engine.candidate(p,1);
  assert.equal(engine.verify(b,p).status,'stuck');
  assert.equal(engine.analyze(p,[-1,1,-1],new Set()).move,null);
  const a = engine.analyze({...p,w:4},[-1,1,-1,-1],new Set());
  assert.deepEqual(a.move.vs,[3]);
  assert.equal(a.move.value,0);
  assert.ok(a.move.sources.includes(-1));
});

test('a digit-only draft can rearrange its witness when a batch of forced safe cells opens', () => {
  const p={w:4,h:3,mines:2};
  const visible=[0,...Array(11).fill(-1)];
  const {board}=engine.publicBoard(p,visible);
  const judge=engine.classify(p,visible);
  assert.equal(judge.state[2],'either');
  const safe=judge.state.flatMap((v,i)=>v==='safe'?[i]:[]);
  assert.deepEqual(safe,[1,4,5]);
  const next=engine.advance(board,p,visible,safe,new Set(),{allowUnsolved:true,exact:true});
  assert.equal(next.opened,3);
  assert.notDeepEqual(next.board.bombs,board.bombs);
  assert.equal(next.board.bombs.filter(Boolean).length,p.mines);
  assert.equal(next.board.clues[0],visible[0]);
  assert.equal(next.visible[0],visible[0]);
  assert.equal(next.visible[2],-1);
});

test('technique-only verification records stalls and never emits recursive moves', () => {
  for (const [w,h,mines,seed,status,level] of fixtures) {
    const p = settings(w,h,mines);
    const r = engine.verify(engine.candidate(p,seed),p,{trace:true,points:true});
    assert.equal(r.status,status);
    assert.equal(Math.max(...r.trace.map(move=>move.level)),level);
    assert.equal(r.trace.length,r.steps);
    assert.ok(r.trace.every(m=>['count','difference','linear','cut','resolution'].includes(m.kind)));
    if(status==='stuck') {
      assert.equal(engine.hint(p,r.point.visible,new Set(r.point.marks),new Set(),{useTotal:false}).status,'stuck');
      assert.ok(engine.classify(p,r.point.visible).state.includes('safe'));
    }
  }
});

test('generates a qualified opening that remains solvable by techniques alone', () => {
  const p = {w:12,h:12,...largeFloors};
  const rounds = engine.generate(p,7), progress=[];
  for(let i=0;i<96;i++) {
    progress.push(rounds.next().value);
    if(progress.at(-1).board) break;
  }
  const result=progress.at(-1);
  assert.ok(result.board);
  assert.equal(rounds.next().done,true);
  const {board,report} = result;
  assert.equal(report.status,'passed');
  assert.ok(result.constructed>=result.passed && result.passed>0);
  assert.equal(board.bombs.length,p.w*p.h);
  assert.equal(board.bombs.filter(Boolean).length,board.mines);
  assert.ok(board.opening.every(v=>!board.bombs[v]));
  assert.ok(progress.length>1 && progress.slice(0,-1).every(r=>!r.board));
  assert.deepEqual(progress.map(r=>r.tried),Array.from({length:result.tried},(_,i)=>i+1));
  const replay = engine.verify(board,p,{trace:true,certify:true});
  assert.deepEqual({...replay,trace:[]},report);
  assert.ok(replay.trace.every(m=>m.positionMinimum));
  const counts=replay.trace.map(m=>m.sources.length);
  assert.equal(report.averageClues,counts.reduce((a,b)=>a+b,0)/counts.length);
  assert.equal(report.clues,Math.max(...counts));
  assert.equal(report.multiSteps,counts.filter(n=>n>=3).length);
  assert.equal(report.advancedDensity,report.multiSteps/counts.length);
  assert.ok(report.multiSteps>0);
  const visible = engine.opening(board), config = {...p,mines:board.mines};
  const hint = engine.hint(config,visible,new Set(),new Set(),{opening:true}).move;
  const {commit,...first}=replay.trace[0];
  assert.deepEqual(hint,first);
  const judgment = engine.classify(config,visible,{nodeBudget:120000});
  assert.equal(judgment.status,'complete');
  assert.ok(hint.vs.every(v=>judgment.state[v]===(hint.value?'mine':'safe')));
});

test('seed routes produce different first-proof overlap graphs without history', () => {
  const p={w:12,h:12,...largeFloors}, totals=new Set(), fiveShapes=new Set(), edge=new Set();
  for(const [seed,route,expected] of [
    [0,'five-chain',[1,1,2,2,2]], [1,'fork',[1,1,1,3]], [2,'long-chain',[1,1,2,2]],
    [42,'five-chain',[1,1,2,2,2]],
  ]) {
    const {board,report,route:actual}=search(p,seed);
    assert.ok(board,`seed ${seed}`);
    assert.equal(actual,route);
    assert.equal(report.status,'passed');
    assert.ok(report.openingMinimum);
    const visible=engine.opening(board), move=engine.hint({...p,mines:board.mines},visible,new Set(),new Set(),{opening:true}).move;
    assert.ok(move.sources.every(v=>visible[v]>=0));
    if(seed===1) {
      const roots=move.proofs.map(x=>x.inequality);
      assert.ok(roots.every(r=>r.kind==='sum'));
      const [r]=roots;
      const input=format.summands(r);
      assert.equal(input.length,4);
      assert.ok(input.every(n=>n.row));
      assert.equal(input.reduce((sum,n)=>sum+n.rhs,0),r.rhs);
      const geometry=format.cancellation(input.map(n=>n.terms));
      assert.ok(geometry.cancelled.length>0);
      for(const [name,sign] of [['positive',1],['negative',-1]]) {
        assert.deepEqual(geometry[name].sort((a,b)=>a-b),r.terms.filter(([,k])=>Math.sign(k)===sign).map(([v])=>v));
      }
      assert.deepEqual(roots[1].terms,roots[0].terms,'both conclusions share the same combined equation');
      assert.ok(move.safe.length && move.mines.length);
      assert.ok(roots.every(r=>format.fixedCells(r.terms,'=',r.rhs).length===r.terms.length),
        'one combined equation is the conclusion for both safe and mined cells');
    }
    edge.add(move.sources.some(v=>board.ns[v].length<8));
    const groups=engine.equivalentGroups(move.sources.map(v=>({vs:board.ns[v].filter(u=>visible[u]<0)})));
    const links=new Map(move.sources.map(v=>[v,new Set()]));
    for(const [cell] of groups) {
      const members=move.sources.filter(v=>board.ns[v].includes(cell));
      for(const v of members) for(const u of members) if(u!==v) links.get(v).add(u);
    }
    assert.deepEqual([...links.values()].map(xs=>xs.size).sort(),expected);
    if(route==='five-chain') fiveShapes.add(groups.map(g=>g.length).sort().join(','));
    totals.add(board.mines);
  }
  assert.equal(fiveShapes.size,2,'two seeds on the same route can have different shared regions');
  assert.deepEqual(edge,new Set([false,true]));
  assert.ok(totals.size>1);
});

test('fixed seeds replay the same certified board', () => {
  const p={w:12,h:12,...largeFloors}, seed=2;
  const first=search(p,seed);
  assert.ok(first.board);
  assert.deepEqual(search(p,seed),first);
});

test('minimum proof replaces an overlong opening certificate and reports exhausted budgets', () => {
  const p=settings(12,12,29);
  const ns=engine.adj(p.w,p.h), visible=Array(144).fill(-1), marks=new Set();
  for(let i=75;i<=81;i++) {
    for(const v of ns[i]) if(visible[v]<0) visible[v]=1;
    visible[i]=0;
  }
  const m=engine.analyze(p,visible,marks).move;
  assert.equal(m.kind,'resolution');
  assert.equal(engine.minimumProof(p,visible,marks,m,{budget:0}).minimum,false);
  const limited=engine.hint(p,visible,marks,new Set(),{opening:true,minimumBudget:0});
  assert.equal(limited.status,'minimum-unavailable');
  assert.equal(limited.move,null);
  const shorter=engine.hint(p,visible,marks,new Set(),{opening:true}).move;
  assert.equal(shorter.minimum,true);
  assert.equal(shorter.openingMinimum,true);
  assert.ok(shorter.sources.length<=m.sources.length);
  assert.equal(shorter.nodes.at(-1).positive.length+shorter.nodes.at(-1).negative.length,1);
  for(const [i,node] of shorter.nodes.entries()) if(node.from) {
    assert.ok(node.from.every(j=>j<i));
    const [a,b]=node.from.map(j=>shorter.nodes[j]);
    assert.ok(a.positive.includes(node.pivot));
    assert.ok(b.negative.includes(node.pivot));
    for(const key of ['positive','negative']) {
      assert.deepEqual(node[key].slice().sort(),[...new Set([...a[key],...b[key]])].filter(v=>v!==node.pivot).sort());
    }
  }
});

test('a player flag alone is not evidence for a hint', () => {
  const p = settings(4,1,1), visible=[-1,1,-1,-1];
  const a = engine.hint(p,visible,new Set(),new Set([3]));
  assert.deepEqual(a.move.vs,[3]);
  assert.equal(a.move.value,0);
  assert.deepEqual(a.marks,[]);
});

test('fewest clues and every conclusion from those clues match an independent oracle', () => {
  let mixed=0, advanced=0;
  for(let seed=0;seed<180;seed++) {
    const p={w:4,h:3,mines:1+seed%5,start:'random',safe:'safe'};
    const board=engine.candidate(p,seed);
    const given=board.bombs.flatMap((m,i)=>m?[]:[i]).slice(seed%3,seed%3+3);
    const visible=board.bombs.map((_,i)=>given.includes(i)?board.clues[i]:-1);
    const proven=new Set(board.bombs.flatMap((m,i)=>m&&seed%2===0?[i]:[]).slice(0,1));
    const m=engine.hint(p,visible,proven,new Set()).move;
    if(!m) continue;
    const hidden=visible.flatMap((n,i)=>n<0&&!proven.has(i)?[i]:[]);
    const clues=[-1,...given];
    const clueSets=clues.map(s=>s<0?hidden:hidden.filter(v=>board.ns[s].includes(v)));
    const rhs=clues.map(s=>s<0?p.mines-proven.size:visible[s]-board.ns[s].filter(v=>proven.has(v)).length);
    const layouts=[];
    for(let bit=0;bit<1<<hidden.length;bit++) {
      const mines=hidden.filter((_,j)=>bit>>j&1);
      const pass=clueSets.reduce((mask,vs,j)=>mask|(vs.filter(v=>mines.includes(v)).length===rhs[j]?1<<j:0),0);
      layouts.push({pass,mines});
    }
    function conclusions(subset) {
      const valid=layouts.filter(l=>(l.pass&subset)===subset);
      assert.ok(valid.length);
      return [hidden.filter(v=>valid.every(l=>!l.mines.includes(v))),hidden.filter(v=>valid.every(l=>l.mines.includes(v)))];
    }
    for(let subset=0;subset<1<<clues.length;subset++) {
      const size=clues.filter((_,i)=>subset>>i&1).length;
      if(size<m.sources.length) assert.deepEqual(conclusions(subset),[[],[]],`seed ${seed}, subset ${subset}`);
    }
    const support=m.sources.reduce((mask,s)=>mask|1<<clues.indexOf(s),0);
    assert.deepEqual([m.safe,m.mines],conclusions(support),`seed ${seed}`);
    assert.ok(m.proofs.every(proof=>proof.sources.every(s=>m.sources.includes(s))));
    if(m.safe.length && m.mines.length) mixed++;
    if(m.sources.length>=3) advanced++;
  }
  assert.ok(mixed>0 && advanced>0,`mixed ${mixed}, advanced ${advanced}`);
});

test('mark history keeps colors separate and treats clears as one action', () => {
  const h=require('./board-input.js')();
  const mark=(symbol,level=0)=>({symbol,level});
  h.edit('red',[[0,mark('x')]]);
  h.edit('blue',[[0,mark('v',3)],[1,mark('//',3)],[2,mark('ʌ',2)],[3,mark('ʌ',3)]]);
  h.clearDeductions();
  assert.deepEqual([...h.layers.blue.keys()],[0,2]);
  h.undo(); assert.equal(h.layers.blue.size,4);
  h.redo(); assert.equal(h.layers.blue.size,2);
  h.clear('blue'); assert.equal(h.layers.red.size,1);
  h.undo(); assert.equal(h.layers.blue.size,2);
  h.edit('red',[[0,mark('s')]]); assert.equal(h.canRedo,false);
  h.undo(); assert.equal(h.layers.red.get(0).symbol,'x');
  h.edit('red',[[0]]); assert.equal(h.layers.red.size,0);
  h.undo(); assert.equal(h.layers.red.size,1);
  assert.equal(h.layers.blue.get(0).symbol,'v');
});

test('blue archiving takes marks from all levels and makes one undoable change', () => {
  const h=require('./board-input')();
  const source=['x','o','s','/','v','ʌ','e','//'].map((symbol,i)=>[i,{symbol,level:i<4?0:i%2+2}]);
  h.edit('blue',source);
  assert.equal(h.archiveBlue(),'archived');
  assert.equal(h.layers.blue.size,0);
  const expected=['o','o','/','/','o','o','/','/'].map((symbol,i)=>[i,{symbol,level:0}]);
  assert.deepEqual([...h.layers.archivedBlue],expected);
  assert.equal(h.archiveBlue(),false);
  h.undo();
  assert.deepEqual([...h.layers.blue],source);
  assert.equal(h.layers.archivedBlue.size,0);
  h.redo();
  assert.equal(h.layers.blue.size,0);
  assert.deepEqual([...h.layers.archivedBlue],expected);
});

test('blue archiving can start with only an advanced mark', () => {
  const h=require('./board-input')();
  h.edit('blue',[[1,{symbol:'v',level:2}]]);
  assert.equal(h.archiveBlue(),'archived');
  assert.equal(h.layers.blue.size,0);
  assert.deepEqual([...h.layers.archivedBlue],[[1,{symbol:'o',level:0}]]);
  h.undo();
  assert.equal(h.layers.blue.get(1).level,2);
});

test('blue archiving keeps matching marks, removes conflicts, and preserves other cells', () => {
  const h=require('./board-input')();
  const mark=(symbol,level=0)=>({symbol,level});
  h.edit('blue',[[0,mark('o')],[1,mark('x')],[2,mark('/')],[3,mark('/')]]);
  h.archiveBlue();
  const original=new Map(h.layers.archivedBlue);
  h.edit('blue',[[0,mark('v',2)],[1,mark('//',3)],[2,mark('ʌ',4)],[4,mark('e',3)]]);
  assert.deepEqual(h.layers.archivedBlue,original);
  h.archiveBlue();
  assert.deepEqual(h.layers.archivedBlue,new Map([[0,mark('o')],[3,mark('/')]]));
  h.undo();
  assert.deepEqual(h.layers.archivedBlue,original);
  assert.equal(h.layers.blue.size,4);
});

test('archiving does not add marks in the same action that clears the last green mark', () => {
  const h=require('./board-input')();
  const x={symbol:'x',level:0}, ring={symbol:'o',level:0}, slash={symbol:'/',level:0};
  h.edit('blue',[[0,x]]);
  h.archiveBlue();
  h.edit('blue',[[0,slash],[1,x]]);
  h.archiveBlue();
  assert.equal(h.layers.archivedBlue.size,0);
  assert.equal(h.layers.blue.size,0);
  h.undo();
  assert.deepEqual(h.layers.archivedBlue,new Map([[0,ring]]));
  assert.deepEqual(h.layers.blue,new Map([[0,slash],[1,x]]));
  h.redo();
  assert.equal(h.layers.archivedBlue.size,0);
  assert.equal(h.layers.blue.size,0);
  h.edit('blue',[[1,x],[2,x]]);
  h.archiveBlue(i=>i!==2);
  assert.deepEqual(h.layers.archivedBlue,new Map([[1,ring]]));
});

test('clear blue removes the ordinary layer first and the archive on a separate action', () => {
  const h=require('./board-input')();
  const x={symbol:'x',level:0}, v={symbol:'v',level:2};
  h.edit('red',[[0,x]]);
  h.edit('blue',[[0,x]]);
  h.archiveBlue();
  h.edit('blue',[[0,v]]);
  assert.equal(h.clearBlue(),true);
  assert.equal(h.layers.blue.size,0);
  assert.equal(h.layers.archivedBlue.size,1);
  assert.equal(h.clearBlue(),true);
  assert.equal(h.layers.archivedBlue.size,0);
  assert.equal(h.clearBlue(),false);
  assert.equal(h.layers.red.size,1);
  h.undo(); assert.equal(h.layers.archivedBlue.size,1);
  h.undo(); assert.equal(h.layers.blue.get(0),v);
  h.redo(); assert.equal(h.layers.blue.size,0);
  h.redo(); assert.equal(h.layers.archivedBlue.size,0);
});

test('clearing second-level deductions preserves assumptions and other layers', () => {
  const h=require('./board-input.js')();
  const original=[['v',2],['e',2],['ʌ',2],['//',2],['ʌ',3],['//',4],['/',0]]
    .map(([symbol,level],i)=>[i,{symbol,level}]);
  h.edit('blue',original);
  assert.equal(h.clearDeductions(2),true);
  assert.deepEqual([...h.layers.blue.keys()],[0,1,4,5,6]);
  assert.equal(h.clearDeductions(2),false);
  h.undo(); assert.deepEqual([...h.layers.blue].sort(([a],[b])=>a-b),original);
  h.redo(); assert.deepEqual([...h.layers.blue.keys()],[0,1,4,5,6]);
});

test('a blue stroke writes, overwrites or erases each visited cell in one history entry', () => {
  const h=require('./board-input')();
  const x={symbol:'x',level:0}, v={symbol:'v',level:3};
  h.edit('red',[[1,x]]);
  h.edit('blue',[[1,x]]);
  const paint=h.stroke('blue',0,v);
  assert.equal(paint.visit(0),true);
  assert.equal(paint.visit(1),true);
  assert.equal(paint.visit(0),false);
  assert.equal(h.layers.blue.get(1),v);
  assert.equal(paint.finish(),true);
  assert.equal(paint.visit(2),false);
  h.undo(); assert.deepEqual([...h.layers.blue],[[1,x]]);
  h.redo(); assert.equal(h.layers.blue.size,2);

  h.edit('blue',[[2,x]]);
  const erase=h.stroke('blue',1,{...v});
  for(const cell of [1,2,0,2]) erase.visit(cell);
  erase.finish();
  assert.equal(h.layers.blue.size,0);
  assert.equal(h.layers.red.get(1),x);
  h.undo(); assert.equal(h.layers.blue.size,3);
  assert.equal(h.layers.blue.get(2),x);
  h.redo(); assert.equal(h.layers.blue.size,0);
});

test('manual confirmations wait for all forced cells and reject incorrect batches atomically', () => {
  const manual=require('./board-input').makeManualBatch;
  const makeManualBatch=(state,flags)=>manual(state,flags,engine.confirmationTargets);
  const batch=makeManualBatch(['mine','mine','safe','safe','both','open'],new Set([0,3,4]));
  assert.deepEqual(batch.record([1,4],'mine'),{wrong:4,state:'both'});
  assert.deepEqual(batch.record([2,1],'safe'),{wrong:1,state:'mine'});
  assert.equal(batch.marked.size,0);
  assert.deepEqual(batch.record([0,1],'mine'),{done:false,total:3});
  assert.deepEqual(batch.record([2,2],'safe'),{done:false,total:3});
  assert.deepEqual(batch.record([3],'safe'),{done:true,total:3});
  assert.deepEqual(batch.cells('safe'),[2,3]);
  assert.deepEqual(batch.cells('mine'),[1]);
  assert.deepEqual(makeManualBatch(['mine','both'],new Set()).record([0],'mine'),{done:true,total:1});
});

test('manual reveal automatically opens every connected zero neighbor without extra steps', () => {
  const {board,visible}=positionSeeds.create(3,2,'000000');
  const exact=engine.advance(board,board,visible,[0],new Set(),{exact:true,allowUnsolved:true});
  assert.deepEqual(exact.visible,Array(6).fill(0));
  assert.equal(exact.opened,6);
  assert.deepEqual(exact.cells,[0,1,2,3,4,5]);
  const report=engine.verify(board,{w:3,h:2,mines:0},{visible:exact.visible,certify:true});
  assert.equal(report.steps,0);
});

test('opening a zero ignores erroneous flags in its automatic reveal area', () => {
  const {board,visible}=positionSeeds.create(3,2,'000000');
  const flags=new Set([1,4]);
  const opened=engine.reveal(board,visible,0,flags);
  assert.equal(opened,6);
  assert.deepEqual(visible,Array(6).fill(0));
});

test('solve-one uses the same staged-then-commit decision as auto solve', () => {
  assert.equal(manualStepAction(undefined),'stage');
  assert.equal(manualStepAction({done:false}),'stage');
  assert.equal(manualStepAction({done:true}),'commit');
});

test('ink covers each marked cell once, connects only neighbors and rounds bends', () => {
  const {inkTrails,inkPath}=require('./board-input');
  assert.deepEqual(inkTrails([3,4],4),[{cells:[3],closed:false},{cells:[4],closed:false}]);
  assert.deepEqual(inkTrails([0,1],4),[{cells:[0,1],closed:false}]);
  const [square]=inkTrails([0,1,4,5],4);
  assert.equal(square.closed,true);
  const [rectangle]=inkTrails([0,1,2,4,5,6],4);
  assert.equal(rectangle.closed,true);
  assert.equal(rectangle.cells.length,6);
  assert.equal(inkTrails([1,4,5,6,9],4).length,3);
  const cells=[0,1,2,4,6,8,9,10,14,16];
  const trails=inkTrails(cells,4);
  assert.deepEqual(trails.flatMap(t=>t.cells).sort((a,b)=>a-b),cells);
  for(const {cells,closed} of [...trails,square,rectangle]) {
    const path=closed?[...cells,cells[0]]:cells;
    for(let i=1;i<path.length;i++) {
      const [a,b]=path.slice(i-1,i+1);
      assert.equal(Math.abs(a%4-b%4)+Math.abs((a>>2)-(b>>2)),1);
    }
  }
  assert.equal(inkPath([[10,10]],20),'M3.3999999999999995,10H16.6');
  const points=[[10,10],[30,10],[30,30]];
  assert.match(inkPath(points,20),/Q30,10 /);
  assert.match(inkPath(points,20,2),/Q28,12 /);
  assert.match(inkPath(points,20,-2),/Q32,8 /);
  const loop=[...points,[10,30]];
  for(const [offset,seam] of [[0,'10,10'],[2,'12,12'],[-2,'8,8']]) {
    const d=inkPath(loop,20,offset,true);
    assert.equal(d.match(/Q/g).length,4);
    assert.match(d,new RegExp(`Q${seam} ${d.match(/^M([^L]+)/)[1]}Z$`));
  }
});

test('small boards can pass with low generation thresholds', () => {
  for (const [w,h] of [[1,2],[2,1],[1,3],[3,1],[2,2],[2,3],[3,2],[3,3],[4,4],[5,5]]) {
    const p={w,h,...easy};
    const {board,report}=search(p,0,24);
    assert.ok(board,`${w} × ${h}`);
    assert.equal(report.status,'passed');
    assert.ok(report.steps>=0);
  }
});

test('difficulty floors are independent of board size and each can be overridden', () => {
  const defaults={minAverage:2,minMultiPercent:30,minPeakClues:5};
  for(const [w,h] of [[1,1],[3,2],[5,5],[8,8],[12,12],[28,25]])
    assert.deepEqual(engine.difficultyDefaults(w,h),defaults);
  const p={w:4,h:4}, first=opts=>engine.generate({...p,...opts},0).next().value;
  assert.deepEqual(first({}),first(defaults));
  assert.deepEqual(first({minAverage:1}).target,{average:1,multiPercent:30,peak:5});
  assert.deepEqual(first({minMultiPercent:0}).target,{average:2,multiPercent:0,peak:5});
  assert.deepEqual(first({minPeakClues:2}).target,{average:2,multiPercent:30,peak:2});
  assert.throws(()=>engine.generate({w:2,h:2},0).next(),/难度下限/);
  assert.throws(()=>engine.generate({w:1,h:1,...easy},0).next(),/需要推理/);
});

test('all three difficulty floors filter the certified path', () => {
  const p={w:5,h:5,...compactFloors};
  const r=search(p,0);
  assert.ok(r.board);
  assert.ok(r.report.averageClues>=1.2 && r.report.advancedDensity>=.10 && r.report.clues>=2);
  assert.deepEqual(search({...p,minAverageDepth:1000},0),r);
  for(const [key,value] of [
    ['minAverage',20],
    ['minMultiPercent',100],
    ['minPeakClues',24],
  ]) {
    const miss=search({...p,[key]:value},0,12);
    assert.equal(miss.board,undefined);
    assert.ok(miss.passed>0);
    assert.deepEqual(Object.keys(miss.closest).sort(),['average','multiPercent','peak']);
  }
});

test('progress keeps the full certified candidate and publishes each improvement', () => {
  const p={w:5,h:5,minAverage:20,minMultiPercent:30,minPeakClues:10};
  const updates=[];
  const rounds=engine.generate(p,0,progress=>updates.push(progress));
  for(let i=0;i<5;i++) {
    const progress=rounds.next().value;
    const {board,candidate,closest,passed}=progress;
    assert.equal(board,undefined);
    assert.ok(passed>0 && candidate);
    assert.equal(candidate,updates.at(-1).candidate);
    const report=engine.verify(candidate.board,p,{certify:true});
    assert.equal(report.status,'passed');
    assert.deepEqual(candidate.report,report);
    assert.deepEqual(closest,{average:report.averageClues,multiPercent:report.advancedDensity*100,peak:report.clues});
  }
  assert.equal(new Set(updates.map(({candidate})=>candidate)).size,updates.length);
});

test('a candidate meeting the peak target outranks one meeting only the multi-clue target', () => {
  const p={w:8,h:8,minAverage:18,minMultiPercent:20,minPeakClues:6};
  const {closest}=search(p,2,6);
  assert.ok(closest.peak>=p.minPeakClues);
  assert.ok(closest.multiPercent<p.minMultiPercent);
});

test('below the peak target, a higher peak wins even if only the other candidate meets the multi-clue target', () => {
  const p={w:5,h:5,minAverage:24,minMultiPercent:18,minPeakClues:10};
  const {board,closest}=search(p,0,7);
  assert.equal(board,undefined);
  assert.equal(closest.peak,5);
  assert.ok(closest.multiPercent<p.minMultiPercent);
});

test('once the peak target is met, higher multi-clue density wins even with a lower qualifying peak', () => {
  const p={w:6,h:6,minAverage:35,minMultiPercent:0,minPeakClues:3};
  const {board,candidate}=search(p,0,2);
  assert.equal(board,undefined);
  assert.equal(candidate.report.clues,3);
  assert.equal(candidate.report.advancedDensity,2/13);
});

test('default generation uses staged clues and does not accept an inflated ten-clue replay', () => {
  const {board}=positionSeeds.decode('Bw#/*+l');
  const replay=engine.verify(board,board,{certify:true,trace:true});
  assert.equal(replay.status,'passed');
  assert.deepEqual(replay.trace.map(m=>m.sources.length),[3,4,1,1,1,1,1,1,1,1,1]);
  assert.equal(replay.averageClues,16/11);
  assert.equal(replay.advancedDensity,2/11);
  assert.equal(replay.clues,4);

  const p={w:5,h:5};
  const result=search(p,0,4);
  assert.deepEqual(result.target,{average:2,multiPercent:30,peak:5});
  if(result.board) {
    const measured=engine.verify(result.board,p,{certify:true});
    assert.deepEqual(result.report,measured);
    assert.ok(measured.averageClues>=2 && measured.advancedDensity>=.3 && measured.clues>=5);
  } else {
    const {average,multiPercent,peak}=result.closest;
    assert.ok(result.passed>0);
    assert.ok(average<2 || multiPercent<30 || peak<5);
  }
});

test('status-only verification follows the same certified route without difficulty statistics', () => {
  const p={w:5,h:5,...compactFloors}, {board}=search(p,3);
  for(const options of [{},{visible:engine.opening(board)}]) {
    const measured=engine.verify(board,p,{...options,certify:true,trace:true});
    const check=engine.verify(board,p,{...options,certify:true,trace:true,measureDifficulty:false});
    const {status,opened,steps,openingMinimum,trace}=measured;
    assert.equal(status,'passed');
    assert.deepEqual(check,{status,opened,steps,openingMinimum,trace});
    assert.ok(trace.every(move=>move.positionMinimum && move.proofs.length));
  }
});

test('live verification replays the actual staged hints and exact manual commits', () => {
  const p={w:5,h:5,...compactFloors}, {board}=search(p,3);
  const replay=engine.verify(board,p,{trace:true,certify:true});
  const visible=engine.opening(board), proven=new Set();
  const {makeManualBatch}=require('./board-input');
  const config={...p,mines:board.mines};
  let manual, opened=board.opening.length, grouped=false;
  for(const move of replay.trace) {
    manual??=makeManualBatch(engine.classify(config,visible,{nodeBudget:Infinity}).state,proven,engine.confirmationTargets);
    const {move:next}=engine.hint(config,visible,proven,proven,{
      opening:opened===board.opening.length,confirmed:manual.marked});
    const {commit,...proof}=move;
    assert.deepEqual(proof,next);
    assert.equal(manual.record(move.safe,'safe').wrong,undefined);
    assert.equal(manual.record(move.mines,'mine').wrong,undefined);
    assert.equal(manual.done,!!commit);
    if(commit) {
      assert.deepEqual(commit,{safe:manual.cells('safe'),mines:manual.cells('mine')});
      for(const v of commit.mines) proven.add(v);
      const advanced=engine.advance(board,config,visible,commit.safe,proven,
        {allowUnsolved:true,exact:true,flags:proven});
      assert.ok(advanced);
      visible.splice(0,visible.length,...advanced.visible);
      opened=visible.filter(value=>value>=0).length;
      manual=undefined;
    } else grouped=true;
  }
  assert.ok(grouped);
  assert.equal(opened,visible.length-board.mines);
});

test('higher floors guide compact and medium boards to certified multi-clue paths', () => {
  for(const [w,limit,minAverage,minMultiPercent,minPeakClues] of [[5,32,2,30,3],[8,12,1.6,14,4]]) {
    const p={w,h:w,minAverage,minMultiPercent,minPeakClues};
    const {board,report}=search(p,2,limit);
    assert.ok(board,`${w} x ${w}`);
    assert.ok(report.averageClues>=minAverage);
    assert.ok(report.advancedDensity>=minMultiPercent/100);
    assert.ok(report.clues>=minPeakClues);
    assert.ok(report.multiSteps>=2);
    const replay=engine.verify(board,p,{certify:true,trace:true});
    assert.deepEqual({...replay,trace:[]},report);
    assert.ok(replay.trace.every(move=>move.positionMinimum && move.proofs.length));
    assert.equal(report.advancedDensity,replay.trace.filter(move=>move.sources.length>=3).length/replay.steps);
    if(w===8) assert.deepEqual(search(p,2,limit).board,board);
  }
});

test('high difficulty generation rechecks options without a verified batch', () => {
  const p={w:8,h:8,minAverage:2,minMultiPercent:10,minPeakClues:6};
  const result=search(p,3,12);
  assert.ok(result.passed>0);
  if(result.board) {
    const report=engine.verify(result.board,p,{certify:true});
    assert.equal(report.status,'passed');
    assert.ok(report.averageClues>=2 && report.advancedDensity>=.1 && report.clues>=6);
  } else assert.equal(result.tried,12);
});

test('峰值或平均线索门槛超出可用线索上界时立即拒绝搜索', () => {
  const p={w:5,h:5,minAverage:1,minMultiPercent:0,minPeakClues:1};
  for(const options of [{minPeakClues:25},{mines:20,minPeakClues:6},{mines:20,minAverage:5.1}]) {
    assert.throws(()=>engine.generate({...p,...options},2).next(),/请调低难度或增大棋盘/);
  }
});

test('未触及线索上界的搜索可超过旧轮次限制，也可手动停止', () => {
  const rounds=engine.generate({w:2,h:3,mines:4,minPeakClues:2,minAverage:2,minMultiPercent:0},12345);
  for(let i=1;i<=3001;i++) {
    const {value,done}=rounds.next();
    assert.equal(done,false);
    assert.equal(value.tried,i);
    assert.equal(value.board,undefined);
  }
  assert.equal(rounds.return().done,true);
  assert.equal(rounds.next().done,true);
});

test('closed-ring generation meets a six-clue floor with a minimum cancellation proof', () => {
  const p={w:8,h:8,minAverage:1.2,minMultiPercent:5,minPeakClues:6};
  const {board,report,target}=search(p,0,4);
  assert.ok(board);
  assert.deepEqual(target,{average:1.2,multiPercent:5,peak:6});
  assert.deepEqual(engine.generate({...p,minMultiPercent:0},3).next().value.target,{...target,multiPercent:0});
  assert.ok(report.averageClues>=1.2 && report.advancedDensity>=.05 && report.clues>=6);
  const replay=engine.verify(board,p,{certify:true,trace:true});
  assert.deepEqual({...replay,trace:[]},report);
  const [move]=replay.trace;
  assert.ok(move.positionMinimum && move.sources.length===6);
  assert.ok(move.safe.length && move.mines.length);
  const inputs=format.summands(move.inequality);
  assert.equal(inputs.length,move.sources.length);
  assert.deepEqual(new Set(move.sources),new Set(board.opening));
  assert.ok(inputs.every((input,i)=>input.kind==='equation' && input.k===-inputs[(i+1)%inputs.length].k));
  for(const [i,input] of inputs.entries()) {
    const adjacent=inputs.flatMap((other,j)=>i!==j && input.row.vs.some(v=>other.row.vs.includes(v))?[j]:[]);
    assert.deepEqual(adjacent.sort((a,b)=>a-b),[(i+1)%inputs.length,(i+inputs.length-1)%inputs.length].sort((a,b)=>a-b));
  }
  const cancelled=format.cancellation(inputs.map(input=>input.terms)).cancelled;
  assert.ok(cancelled.length>=2*inputs.length);
});

test('interchangeable variables require identical clue memberships and coefficients', () => {
  const groups = engine.equivalentGroups([{vs:[0,1,5]},{vs:[0,1,6]},{vs:[2,3]}]);
  assert.deepEqual(groups,[[0,1],[5],[6],[2,3]]);
  assert.deepEqual(format.terms([[0,2],[1,2],[2,1],[3,-1],[5,-1]],groups),[
    {coefficient:2,cells:[0,1]},{coefficient:1,cells:[2]},
    {coefficient:-1,cells:[3]},{coefficient:-1,cells:[5]},
  ]);
  assert.equal(format.label([0,4,5],4,3),'A1A2B2');
  assert.equal(format.label([0,1,4,5],4,3),'A1:B2');
  assert.equal(format.label([4,5,6,7],4,3),'第2行');
  assert.equal(format.label([1,5,9],4,3),'B列');
});

test('rectangles span only targets and already-open gaps', () => {
  const visible=Array(12).fill(-1);
  visible[5]=6;
  const safe=[0,1,4,8,9];
  assert.equal(format.label(safe,4,3,visible),'A1:B3');
  assert.deepEqual(format.regions([...safe,2],4,3,visible),[safe,[2]]);
  visible[5]=-1;
  assert.equal(format.label(safe,4,3,visible),'A1B1A2A3B3');
  assert.deepEqual(format.regions(safe,4,3,visible),[[0,4,8],[1],[9]]);
});

test('opening conclusions cover two safe rectangles and one mine rectangle without overlap', () => {
  const p=settings(12,12,31), visible=Array(144).fill(-1);
  for(const [v,c] of [[63,2],[87,2],[65,4],[89,6],[67,4],[91,2],[69,2]]) visible[v]=c;
  const {move}=engine.hint(p,visible,new Set(),new Set(),{opening:true});
  for (const [targets,expected] of [[move.safe,['C7:D9','H7:I9']],[move.mines,['F7:F9']]]) {
    const groups=format.regions(targets,p.w,p.h,visible);
    assert.deepEqual(groups.map(g=>format.label(g,p.w,p.h,visible)),expected);
    assert.deepEqual(groups.flat().sort((a,b)=>a-b),targets);
  }
});

test('conclusion rectangles preserve coefficients and count each real cell once', () => {
  const visible=Array(12).fill(-1);
  visible[1]=2;
  const groups=[[0],[2],[3,7]];
  const uniform=[[0,2],[2,2],[3,2],[7,2]];
  const mixed=[[0,2],[2,2],[3,-2],[7,-2]];
  const show=raw=>format.comparison(raw,'≤',-2,format.conclusionGroups(raw,groups,4,3,visible));
  const u=show(uniform), m=show(mixed);
  assert.deepEqual(u.terms,[{coefficient:-2,cells:[0,2,3]},{coefficient:-2,cells:[7]}]);
  assert.deepEqual(m.terms,[{coefficient:2,cells:[3,7]},{coefficient:-2,cells:[0]},{coefficient:-2,cells:[2]}]);
  assert.deepEqual(u.terms.flatMap(t=>t.cells.map(v=>[v,-t.coefficient])),uniform);
});

test('proof references separate subtraction signs from unsigned coefficients', () => {
  assert.deepEqual(format.referenceTerms([{id:1,k:1},{id:2,k:-1},{id:3,k:-2},{id:51,k:3}]),[
    {id:1,operator:'',factor:''},{id:51,operator:'+',factor:'3'},
    {id:2,operator:'−',factor:''},{id:3,operator:'−',factor:'2'},
  ]);
  assert.deepEqual(format.referenceTerms([{id:4,k:-3}]),[
    {id:4,operator:'−',factor:'3'},
  ]);
});

test('closed ink prefers a loop with the fewest bends', () => {
  const [ring] = inkTrails([0,1,2,3,4,5,6,7],4);
  assert.equal(ring.closed,true);
  const points=ring.cells.map(i=>[i%4,Math.floor(i/4)]);
  const edges=points.slice(1).map((p,i)=>[p[0]-points[i][0],p[1]-points[i][1]]);
  edges.push([points[0][0]-points.at(-1)[0],points[0][1]-points.at(-1)[1]]);
  let turns=0;
  for(let i=0;i<edges.length;i++) { const a=edges[i], b=edges[(i+1)%edges.length]; if(a[0]!==b[0] || a[1]!==b[1]) turns++; }
  assert.equal(turns,4);
});

test('proof references follow displayed subtraction and reflected rounding', () => {
  const r=(id,k,reflected=false)=>({id,k,reflected});
  const shown=(refs,reflected)=>format.referenceTerms(refs,reflected)
    .map(({operator,factor,id})=>`${operator}${factor}${id}`).join('');
  assert.equal(shown([r(1,1),r(2,-1)],true),'2−1');
  assert.equal(shown([r(4,1,true),r(3,1)],true),'4−3');
  assert.equal(shown([r(4,1,true),r(3,1)],false),'3−4');
  assert.equal(shown([r(4,1,true)],true),'4');
  assert.equal(format.rounding(true),'向上取整');
  assert.equal(format.rounding(false),'向下取整');
  for(let n=-7;n<=7;n++) assert.ok(Math.ceil(-n/2)===-Math.floor(n/2));
});

test('coincident references combine and cancelled terms disappear', () => {
  assert.deepEqual(format.referenceTerms([{id:1,k:1},{id:2,k:-1},{id:1,k:-1},{id:2,k:-1},{id:3,k:1}],true),[
    {id:2,operator:'',factor:'2'},{id:3,operator:'−',factor:''},
  ]);
});

test('only completely cancelled cells get the cancellation pattern', () => {
  const inputs=[[[0,1],[1,1],[2,3]],[[0,-1],[1,-4],[2,-1],[3,1]]];
  assert.deepEqual(format.cancellation(inputs),{
    cancelled:[0],positive:[2,3],negative:[1],weights:new Map([[1,-3],[2,2],[3,1]])
  });
  assert.deepEqual(format.cancellation(inputs,true),{
    cancelled:[0],positive:[1],negative:[2,3],weights:new Map([[1,3],[2,-2],[3,-1]])
  });
});

test('a weighted bound can fix cells while other terms can still vary', () => {
  const terms=[[0,2],[1,-3],[2,1]];
  assert.deepEqual(format.fixedCells(terms,'≤',-2),[[0,0],[1,1]]);
  assert.deepEqual(format.fixedCells(terms,'≥',2),[[0,1],[1,0]]);
  assert.deepEqual(format.fixedCells(terms,'≤',0),[]);
  assert.deepEqual(format.fixedCells(terms,'≥',0),[]);
});

test('isolating a weighted cell chooses the correct bound after moving the other terms', () => {
  assert.deepEqual(format.isolateConclusion([[1,1],[5,-2],[7,-1]],'=',1,5,0),{
    divisor:2,constant:-1,terms:[[1,1],[7,-1]],relation:'=',bound:'≤',limit:0
  });
  assert.deepEqual(format.isolateConclusion([[2,-3],[3,1],[4,-1]],'≤',-3,2,1),{
    divisor:3,constant:3,terms:[[3,1],[4,-1]],relation:'≥',bound:'≥',limit:2
  });
});

test('an equality from direct cancellation is already the conclusion', () => {
  const p=settings(5,5,4), visible=Array(25).fill(-1);
  visible[6]=2; visible[7]=3; visible[9]=1;
  const {move}=engine.hint(p,visible,new Set(),new Set(),{opening:true});
  assert.deepEqual(move.safe,[0,4,5,10,14]);
  const [safe]=move.proofs;
  assert.deepEqual(format.summands(safe.inequality).map(part=>[part.row.source,part.k]),[[6,1],[7,-1],[9,1]]);
  assert.equal(safe.inequality.rhs,0);
  assert.deepEqual(format.fixedCells(safe.inequality.terms,'=',0),move.safe.map(v=>[v,0]));
});

test('bounds that fix every cell need no reverse bound or restated equality', () => {
  const positive=[[0,1],[1,1]], mixed=[[0,1],[1,-1]], weighted=[[0,2],[1,2]];
  assert.deepEqual(format.fixedCells(positive,'≤',0),[[0,0],[1,0]]);
  assert.deepEqual(format.fixedCells(positive,'≥',2),[[0,1],[1,1]]);
  assert.deepEqual(format.fixedCells(mixed,'=',-1),[[0,0],[1,1]]);
  assert.deepEqual(format.fixedCells(weighted,'<',2),[[0,0],[1,0]]);
});

test('comparison formatting preserves the original sign, boundary and meaning', () => {
  const raw=Object.freeze([[0,-2],[1,-2],[2,1]].map(Object.freeze));
  const groups=[[0,1],[2]];
  const relations={'<':(a,b)=>a<b,'≤':(a,b)=>a<=b,'>':(a,b)=>a>b,'≥':(a,b)=>a>=b,'=':(a,b)=>a===b};
  for(const [sign,relation] of Object.entries(relations)) for(let rhs=-6;rhs<=4;rhs++) {
    const display=format.comparison(raw,sign,rhs,groups);
    assert.ok(display.constant>=0);
    assert.equal(display.sign,sign);
    assert.equal(display.constant,Math.abs(rhs));
    assert.deepEqual(display.terms.map(t=>t.cells),rhs<0?groups:groups.slice().reverse());
    for(let bits=0;bits<8;bits++) {
      const bit=v=>(bits>>v)&1;
      const lhs=raw.reduce((sum,[v,c])=>sum+c*bit(v),0);
      const shown=display.terms.reduce((sum,t)=>sum+t.coefficient*t.cells.reduce((n,v)=>n+bit(v),0),0);
      const comparable=relations[display.sign];
      assert.equal(display.constantFirst?comparable(display.constant,shown):comparable(shown,display.constant),relation(lhs,rhs));
    }
  }
  assert.deepEqual(raw,[[0,-2],[1,-2],[2,1]]);
});

test('a conclusive bound keeps its comparison symbol', () => {
  assert.deepEqual(format.relation('≤',0),{sign:'≤',constant:0,constantFirst:false});
  assert.deepEqual(format.relation('≥',3),{sign:'≥',constant:3,constantFirst:false});
  assert.deepEqual(format.relation('≤',-2),{sign:'≤',constant:2,constantFirst:true});
  assert.deepEqual(format.relation('=',0),{sign:'=',constant:0,constantFirst:false});
});

// Independent test oracle: enumerate assignments only in small residual positions.
function oracle(p, board, visible, marks, move, classified) {
  const unknown = visible.flatMap((v,i)=>v<0&&!marks.has(i)?[i]:[]);
  if (unknown.length>16) return false;
  const bits = new Map(unknown.map((v,i)=>[v,1<<i]));
  const coords = i => [i%p.w,Math.floor(i/p.w)];
  const close = (i,j) => {
    const [x,y]=coords(i), [X,Y]=coords(j);
    return i!==j && Math.abs(X-x)<=1 && Math.abs(Y-y)<=1;
  };
  const rows=visible.flatMap((v,i)=>v<0?[]:[[
    unknown.filter(j=>close(i,j)).map(j=>bits.get(j)),v-[...marks].filter(j=>close(i,j)).length,
  ]]);
  let legal=0;
  const possible=new Uint8Array(unknown.length);
  for(let mask=0;mask<1<<unknown.length;mask++) {
    let count=0;
    for(let n=mask;n;n&=n-1) count++;
    if(count+marks.size!==p.mines || rows.some(([vs,rhs])=>vs.filter(bit=>mask&bit).length!==rhs)) continue;
    legal++;
    if(move) for(const v of move.vs) assert.equal(Number(!!(mask&bits.get(v))),move.value,`board ${board.seed}, ${move.kind}, cell ${v}`);
    if(classified) for(let i=0;i<unknown.length;i++) possible[i]|=1<<(mask>>i&1);
  }
  assert.ok(legal>0);
  if(classified) {
    assert.equal(classified.status,'complete');
    for(let i=0;i<unknown.length;i++) assert.equal(classified.state[unknown[i]],['invalid','safe','mine','either'][possible[i]]);
  }
  return true;
}

test('recursive classification matches all valid layouts on small positions', () => {
  for(let seed=0;seed<200;seed++) {
    const p={w:4,h:3,mines:1+seed%6,start:'random',safe:'safe'};
    const board=engine.candidate(p,seed), visible=Array(12).fill(-1);
    engine.reveal(board,visible,board.first);
    const safe=visible.flatMap((v,i)=>v<0&&!board.bombs[i]?[i]:[]);
    if(safe.length) engine.reveal(board,visible,safe[seed%safe.length]);
    oracle(p,board,visible,new Set(),null,engine.classify(p,visible));
  }
});

test('small residual positions agree with every valid layout', () => {
  const p = {...settings(5,5,5),start:'random',safe:'safe'};
  const checked=new Map();
  for (let seed=0;seed<250;seed++) {
    const b=engine.candidate(p,seed), visible=Array(p.w*p.h).fill(-1), marks=new Set();
    engine.reveal(b,visible,b.first);
    for (const m of engine.verify(b,p,{trace:true}).trace) {
      if(oracle(p,b,visible,marks,m)) checked.set(m.kind,(checked.get(m.kind)??0)+1);
      for(const v of m.vs) if(m.value) marks.add(v); else engine.reveal(b,visible,v);
    }
  }
  for(const kind of ['count','difference','linear']) assert.ok(checked.get(kind)>0,kind);
});

test('proof display replaces unchanged and weaker cuts while preserving useful cuts', () => {
  const row=(terms,rhs)=>({row:{},terms,rhs});
  const floor=a=>({kind:'floor',a,terms:a.terms.map(([v,c])=>[v,Math.floor(c/2)]).filter(([,c])=>c),rhs:Math.floor(a.rhs/2)});
  const same=row([[4,-1],[9,-1]],-1);
  assert.equal(format.simplifyInequality(floor(same)),same);
  const stronger=row([[4,-1],[9,-1],[10,-1]],-3);
  const weak=floor(stronger), b=row([[4,1]],1);
  const sum={kind:'sum',a:weak,b,terms:[[9,-1],[10,-1]],rhs:-1};
  const compact=format.simplifyInequality(sum);
  assert.equal(compact.a,stronger);
  assert.equal(compact.rhs,-2);
  assert.equal(sum.rhs,-1);
  const useful=floor(row([[4,-2],[9,1]],1));
  assert.equal(format.simplifyInequality(useful),useful);
});

test('proof display shares equivalent written bounds without conflating opposite bounds', () => {
  const raw=[[4,-1],[9,2]], reverse=[[9,-2],[4,1]];
  const upper=format.lineIdentity(raw,'≤',-1);
  const lower=format.lineIdentity(reverse,'≥',1);
  assert.equal(upper.key,lower.key);
  assert.notEqual(upper.flipped,lower.flipped);
  assert.notEqual(upper.key,format.lineIdentity(raw,'≥',-1).key);
  assert.notEqual(upper.key,format.lineIdentity(raw,'=',-1).key);
  assert.equal(format.lineIdentity(raw,'=',-1).key,format.lineIdentity(reverse,'=',1).key);
});

test('proof display retains only conclusions and their transitive dependencies', () => {
  const lines=[{refs:[]},{refs:[1]},{refs:[1]},{refs:[3],keep:true},{refs:[2]},{refs:[],keep:true}];
  assert.deepEqual(format.usedLines(lines),[1,3,4,6]);
});

test('integer cut rounds negative coefficients down and preserves the bound', () => {
  const p = settings(16,16,40);
  const b = engine.candidate(p,1002253454);
  const m = engine.verify(b,p,{trace:true}).trace.find(m=>m.kind==='cut');
  assert.ok(m);
  const input=format.summands(m.inequality);
  const cut=input.find(r=>r.kind==='floor');
  assert.ok(cut && input.every(r=>r.row || r.kind==='floor'));
  assert.ok(format.summands(cut.a).every(r=>r.row));
  assert.equal(input.reduce((sum,r)=>sum+r.rhs,0),m.inequality.rhs);
  const vars=m.inequality.terms.map(([v])=>v);
  const proofs=[];
  const collect = r => {
    if(r.row) proofs.push(r.row);
    else { collect(r.a); if(r.b) collect(r.b); }
    for(const [v] of r.terms) if(!vars.includes(v)) vars.push(v);
  };
  collect(m.inequality);
  assert.ok(vars.length<=16);
  let legal=0;
  for(let mask=0;mask<(1<<vars.length);mask++) {
    const at = v => (mask>>vars.indexOf(v))&1;
    if(proofs.some(r=>r.vs.reduce((s,v)=>s+at(v),0)!==r.rhs)) continue;
    legal++;
    assert.ok(m.inequality.terms.reduce((s,[v,c])=>s+c*at(v),0)<=m.inequality.rhs);
    for(const v of m.vs) assert.equal(at(v),m.value);
  }
  assert.ok(legal>0);
});

test('manual red confirmations and blue ink share undo and redo in action order',()=>{
  const makeMarkHistory=require('./board-input');
  const notes=makeMarkHistory();
  const batch=makeMarkHistory.makeManualBatch(['mine','safe','both'],new Set(),engine.confirmationTargets,notes);
  const ink={symbol:'o',level:0};
  batch.record([0],'mine');
  notes.edit('blue',[[2,ink]]);
  batch.record([1],'safe');
  assert.equal(batch.done,true);
  notes.undo();
  assert.deepEqual(batch.cells('safe'),[]);
  assert.equal(batch.done,false);
  notes.undo();
  assert.equal(notes.layers.blue.has(2),false);
  notes.undo();
  assert.equal(batch.marked.size,0);
  notes.redo();
  notes.redo();
  assert.deepEqual(batch.cells('mine'),[0]);
  assert.deepEqual(notes.layers.blue.get(2),ink);
  batch.record([0],'mine');
  batch.record([2],'safe');
  assert.equal(notes.canRedo,true);
  notes.redo();
  assert.equal(batch.done,true);
  notes.undo();
  notes.edit('blue',[[2,undefined]]);
  assert.equal(notes.canRedo,false);
});

test('红标批次和移旗可整批撤销，提交后清除对应历史',()=>{
  const makeMarkHistory=require('./board-input');
  const notes=makeMarkHistory();
  const flags=new Set([0]);
  const batch=makeMarkHistory.makeManualBatch(['mine','mine','safe'],flags,engine.confirmationTargets,notes);
  notes.edit('blue',[[0,{symbol:'o',level:0}]]);
  batch.record([1],'mine',0);
  assert.equal(flags.has(0),false);
  assert.equal(batch.total,3);
  notes.undo();
  assert.equal(flags.has(0),true);
  assert.equal(batch.total,2);
  assert.equal(batch.marked.size,0);
  notes.redo();
  assert.equal(flags.has(0),false);
  assert.deepEqual(batch.cells('mine'),[1]);
  batch.recordStep([2],[0,1]);
  assert.equal(batch.done,true);
  assert.deepEqual(batch.cells('safe'),[2]);
  assert.deepEqual(batch.cells('mine'),[0,1]);
  notes.undo();
  assert.deepEqual([...batch.marked],[[1,'mine']]);
  notes.redo();
  assert.deepEqual(batch.cells('safe'),[2]);
  assert.deepEqual(batch.cells('mine'),[0,1]);
  notes.undo();
  notes.discardCells([2]);
  notes.discardConfirmations();
  assert.equal(notes.canRedo,false);
  notes.undo();
  assert.equal(notes.layers.blue.has(0),false);
  assert.equal(flags.has(0),false);
  assert.equal(notes.canUndo,false);
});


test('选区雷数保留离散取值和负系数，并遵守全局总雷数',()=>{
  const p={w:5,h:1,mines:2};
  const visible=[-1,1,-1,1,-1];
  const weights=new Map([[0,2],[2,-2],[4,2]]);
  assert.deepEqual(engine.selectionTotals(p,visible,new Map(),weights),{status:'complete',values:[4]});
  assert.deepEqual(engine.selectionTotals({...p,mines:1},visible,new Map(),weights),{status:'complete',values:[-2]});
  assert.deepEqual(engine.selectionTotals({w:4,h:1,mines:1},Array(4).fill(-1),new Map(),new Map([[0,2]])),
    {status:'complete',values:[0,2]});
  assert.deepEqual(engine.selectionTotals(p,visible,new Map([[2,1]]),weights),{status:'invalid'});
});

test('选区雷数使用整个公开局面，包括远处线索和已确认格',()=>{
  const p={w:7,h:1,mines:2};
  const visible=[-1,1,-1,-1,1,-1,-1];
  const known=new Map([[0,0],[5,1]]);
  const weights=new Map([[0,9],[2,2],[3,4],[5,7],[6,8]]);
  assert.deepEqual(engine.selectionTotals(p,visible,known,weights),{status:'complete',values:[2]});
  assert.deepEqual(engine.selectionTotals(p,visible,known,weights,0),{status:'budget'});
});

test('各项难度目标提高时，生成使用更多初始种子',()=>{
  const easy={w:5,h:5,minAverage:1,minMultiPercent:0,minPeakClues:1};
  const initial=p=>engine.generationSchedule(p,18).initial;
  assert.equal(initial(easy),3);
  for(const change of [{minAverage:2},{minMultiPercent:30},{minPeakClues:5}]) {
    assert.ok(initial({...easy,...change})>initial(easy));
  }
  assert.equal(initial({w:5,h:5}),6);
  assert.equal(initial({w:1,h:25}),5);
  assert.equal(initial({w:16,h:16}),5);
});

test('生成每到一个轮数阈值增加一个种子，并遵守棋盘尺寸和核心数上限',()=>{
  const small=engine.generationSchedule({w:5,h:5},18);
  assert.equal(small.limit,12);
  assert.deepEqual([0,31,32,63,64,Infinity].map(small.lanesAt),[6,6,7,7,8,12]);
  const medium=engine.generationSchedule({w:16,h:16},18);
  assert.equal(medium.limit,10);
  assert.deepEqual([0,15,16,32,96].map(medium.lanesAt),[5,5,6,7,10]);
  const large=engine.generationSchedule({w:30,h:16},18);
  assert.equal(large.limit,8);
  assert.deepEqual([0,7,8,16,100].map(large.lanesAt),[5,5,6,7,8]);
  assert.equal(engine.generationSchedule({w:5,h:5},8).lanesAt(1000),7);
  assert.equal(engine.generationSchedule({w:5,h:5},2).lanesAt(1000),1);
  assert.equal(engine.generationSchedule({w:2,h:2},18).lanesAt(1000),1);
});

test('跨种子比较最接近候选时保留峰值优先规则',()=>{
  const rank=engine.generationRanking({w:5,h:5});
  const report=(clues,advancedDensity)=>({clues,advancedDensity,averageClues:1.8});
  assert.ok(rank.compareClosest(report(4,.7),report(3,.9))<0);
  assert.ok(rank.compareClosest(report(5,.1),report(4,.9))<0);
  assert.ok(rank.compareClosest(report(5,.29),report(8,.25))<0);
});

test('游戏内的可能取值包含下一步需要猜的公开局面',()=>{
  const position={w:3,h:1,mines:1}, visible=[-1,1,-1];
  const board=engine.publicBoard(position,visible).board;
  assert.equal(engine.verify(board,position,{certify:true,visible}).status,'stuck');
  const publicState=engine.classify(position,visible);
  assert.equal(publicState.state[0],'either');
  assert.equal(publicState.state[2],'either');
  assert.deepEqual(engine.selectionTotals(position,visible,new Map(),new Map([[0,1],[2,-1]])),
    {status:'complete',values:[-1,1]});
});


test('选区动态规划保留大幅正负系数产生的稀疏取值',()=>{
  const position={w:6,h:1,mines:2}, visible=[-1,1,-1,-1,1,-1];
  const weights=new Map([[0,-9500],[2,1],[3,-2],[5,60000]]);
  assert.deepEqual(engine.selectionTotals(position,visible,new Map(),weights),
    {status:'complete',values:[-9502,-1,50500,60001]});
});

test('区域传递按公开条件判定，与穷举的小盘布雷一致', () => {
  const w=3,h=2,ns=engine.adj(w,h),size=w*h;
  const layouts=Array.from({length:1<<size},(_,mask)=>ns.map((_,i)=>(mask>>i)&1));
  for(const bombs of layouts) for(let opened=0;opened<1<<size;opened++) {
    if(bombs.some((mine,i)=>mine && (opened>>i&1))) continue;
    const mines=bombs.reduce((a,b)=>a+b),p={w,h,mines};
    const visible=ns.map((row,i)=>opened>>i&1?row.reduce((sum,v)=>sum+bombs[v],0):-1);
    const possible=layouts.filter(layout=>layout.reduce((a,b)=>a+b)===mines && visible.every((clue,i)=>
      clue<0 || !layout[i] && clue===ns[i].reduce((sum,v)=>sum+layout[v],0)));
    const expected=visible.map((clue,i)=>clue>=0?'open':possible.every(a=>a[i])?'mine':
      possible.every(a=>!a[i])?'safe':'either');
    const result=engine.transfer(p,visible);
    assert.equal(result.status,'complete');
    assert.deepEqual(result.state,expected);
  }
  const p={w:6,h:1,mines:2}, visible=[-1,1,-1,-1,1,-1];
  assert.deepEqual(engine.transfer(p,visible).state,['either','open','either','either','open','either']);
  assert.equal(engine.transfer({...p,mines:1},visible).status,'invalid');
  assert.equal(engine.transfer(p,visible,{nodeBudget:0}).status,'budget');
});

test('前向传递和反向核验在同一预算内完成 12×12 的公开局面判定', () => {
  const p={w:12,h:12,mines:59};
  const visible=[
    '001.3.3.3.3.',
    '002.........',
    '235.6.6.6.3.',
    '............',
    '4.6.4.4.4.3.',
    '............',
    '2.4.3.3.3.3.',
    '............',
    '3.5.2.3.6.6.',
    '............',
    '2.4.3.4.6.6.',
    '............',
  ].join('').split('').map(cell=>cell==='.'?-1:Number(cell));
  const nodeBudget=120000;
  const result=engine.classify(p,visible,{nodeBudget});
  assert.equal(result.status,'complete');
  assert.ok(result.nodes<=nodeBudget);
  assert.deepEqual(result.state.flatMap((status,v)=>status==='safe'?[v]:[]),[3]);
  assert.deepEqual(result.state.flatMap((status,v)=>status==='mine'?[v]:[]),[15,27,36,37,38,39]);
  const smallBudget=1000;
  const partial=engine.classify(p,visible,{nodeBudget:smallBudget});
  assert.equal(partial.status,'budget');
  assert.ok(partial.nodes<=smallBudget);
  assert.ok(partial.state.every((status,v)=>status==='unknown' || status===result.state[v]));
});

test('完整枚举保留不同开局，并排除同一个初始信息下必须猜的布局', () => {
  const boards=[...engine.enumerateNoGuess({w:3,h:1,mines:1})];
  assert.equal(boards.length,5);
  const identities=boards.map(board=>`${board.bombs.findIndex(Boolean)}:${engine.opening(board).join(',')}`);
  assert.equal(new Set(identities).size,boards.length);
  assert.ok(boards.every(board=>board.opening.length!==1 || board.opening[0]!==1));
});

test('修改筛选回调或返回值收到的棋盘，不影响后续逆向枚举', () => {
  const p={w:3,h:2,mines:2};
  const identity=board=>`${board.bombs}:${board.clues}:${board.opening}:${board.ns.map(row=>row.join(',')).join(';')}`;
  const expected=[...engine.enumerateNoGuess(p)].map(identity);
  function modify(board) {
    board.opening.length=0;
    board.bombs.fill(false);
    board.clues.fill(0);
    board.ns[0].length=0;
    board.ns.pop();
  }
  const filtered=[];
  Array.from(engine.enumerateNoGuess(p,{accept:board=>{
    filtered.push(identity(board));
    modify(board);
    return true;
  }}));
  assert.deepEqual(filtered,expected);

  const consumed=[];
  for(const board of engine.enumerateNoGuess(p)) {
    consumed.push(identity(board));
    modify(board);
  }
  assert.deepEqual(consumed,expected);
});

test('高峰值拼接复用前轮结构，严格超过下限后在可用区间选目标', () => {
  const p={w:20,h:20,minPeakClues:8};
  const next=engine.composeClueSearch(p,2);
  const initial=Array.from({length:4},()=>next());
  assert.deepEqual(initial.map(({shape})=>shape.givens.length),[2,4,8,16]);
  assert.deepEqual(initial.map(({shape})=>shape.split),[[1,1],[2,2],[4,4],[8,8]]);
  for(let i=1;i<initial.length;i++) assert.ok(initial[i].shape.parts.every(part=>part===initial[i-1].shape));
  const targets=Array.from({length:12},()=>next().target);
  assert.ok(targets.every(target=>target>=8 && target<=16));
  assert.ok(new Set(targets).size>1);
});

test('最大拼接目标放不下时保留已有结构，再尝试较大的可行规模', () => {
  const next=engine.composeClueSearch({w:5,h:5,minPeakClues:8},2);
  next();
  next();
  const previous=next();
  const missed=next();
  assert.equal(missed.target,16);
  assert.equal(missed.shape,previous.shape);
  const improved=next();
  assert.ok(improved.target<missed.target);
  assert.ok(improved.shape.givens.length>8);
  assert.ok(improved.shape.parts.includes(previous.shape));
});

test('棋盘边缘截断接缝时重新放置同一结构', () => {
  const shape=engine.composeClues({w:3,h:6},4,3302644519,{balanced:true,preferLoops:true});
  assert.ok(shape);
  const {givens}=shape;
  const ns=engine.adj(3,6), opened=new Set(givens);
  const rows=givens.map(v=>ns[v].filter(u=>!opened.has(u)));
  assert.equal(givens.length,4);
  assert.ok(givens.every(v=>v>=3 && v<15));
  assert.ok(rows.every(row=>rows.some(other=>other!==row && row.filter(v=>other.includes(v)).length>=2)));

  const next=engine.composeClueSearch({w:5,h:5,minPeakClues:8},3);
  const {target,shape:scheduled}=Array.from({length:6},next).at(-1);
  assert.equal(target,10);
  assert.equal(scheduled.givens.length,10);
});

test('候选结构在所有偏移均不连通时继续检查其他接缝', () => {
  const next=engine.composeClueSearch({w:5,h:5,minPeakClues:8},0);
  const {target,shape}=Array.from({length:10},next).at(-1);
  assert.equal(target,11);
  assert.equal(shape.givens.length,11);
});

test('十线索递归拼接考虑五种拆分，并能在同一图中得到环和分支', () => {
  const histogram=Array(5).fill(0), identities=new Set();
  let mixed=false;
  const w=16,h=16,ns=engine.adj(w,h);
  for(let seed=0;seed<60;seed++) {
    const shape=engine.composeClues({w,h},10,seed);
    assert.ok(shape);
    const {givens,split}=shape;
    histogram[split[0]-1]++;
    assert.equal(split[0]+split[1],10);
    assert.equal(new Set(givens).size,10);
    assert.ok(givens.every(v=>Number.isInteger(v) && v>=0 && v<w*h));
    const opened=new Set(givens), covered=givens.map(v=>ns[v].filter(u=>!opened.has(u)));
    const edges=covered.map((a,i)=>covered.flatMap((b,j)=>i!==j && a.some(v=>b.includes(v))?[j]:[]));
    const queue=[0], seen=new Set(queue);
    for(const i of queue) for(const j of edges[i]) if(!seen.has(j)) { seen.add(j);queue.push(j); }
    assert.equal(seen.size,10);
    const terminals=edges.some(a=>a.length===1), branching=edges.some(a=>a.length>=3);
    mixed||=terminals && branching && edges.reduce((sum,a)=>sum+a.length,0)>=2*givens.length;
    const x=Math.min(...givens.map(v=>v%w)),y=Math.min(...givens.map(v=>Math.floor(v/w)));
    identities.add(givens.map(v=>v-x-y*w).sort((a,b)=>a-b).join(','));
  }
  assert.ok(histogram.every(n=>n>=5 && n<=20),JSON.stringify(histogram));
  assert.ok(identities.size>=40);
  assert.ok(mixed);
});

test('近半拆分将偶数线索等分，奇数线索两边只差一条', () => {
  for(const count of [10,11]) {
    const shape=engine.composeClues({w:20,h:20},count,0,{splitNearHalf:true});
    assert.deepEqual(shape.split,[5,count-5]);
    assert.equal(new Set(shape.givens).size,count);
  }
});

test('逆向构造与独立的 3×2 穷举回放得到同一批可通关开局', () => {
  const w=3,h=2,ns=engine.adj(w,h),size=w*h;
  const layouts=Array.from({length:1<<size},(_,mask)=>ns.map((_,i)=>Boolean(mask>>i&1)));
  const expected=new Set();
  for(const [mask,bombs] of layouts.entries()) {
    const mines=bombs.filter(Boolean).length;
    const clues=ns.map(row=>row.filter(v=>bombs[v]).length);
    for(let bits=1;bits<1<<size;bits++) {
      const opening=ns.flatMap((_,v)=>bits>>v&1?[v]:[]);
      if(opening.some(v=>bombs[v] || clues[v]===0 && ns[v].some(u=>!(bits>>u&1)))) continue;
      const visible=ns.map((_,v)=>bits>>v&1?clues[v]:-1);
      for(;;) {
        const possible=layouts.filter(layout=>layout.filter(Boolean).length===mines && visible.every((n,v)=>
          n<0 || !layout[v] && ns[v].filter(u=>layout[u]).length===n));
        const safe=ns.flatMap((_,v)=>visible[v]<0 && possible.every(layout=>!layout[v])?[v]:[]);
        if(!safe.length) break;
        for(const v of safe) visible[v]=clues[v];
      }
      if(visible.filter(n=>n>=0).length===size-mines) expected.add(`${mask}:${opening}`);
    }
  }
  const actual=[...engine.enumerateNoGuess({w,h})].map(board=>
    `${board.bombs.reduce((bits,mine,i)=>bits+(Number(mine)<<i),0)}:${board.opening}`);
  assert.equal(new Set(actual).size,actual.length);
  assert.deepEqual(new Set(actual),expected);
  assert.deepEqual([...engine.enumerateNoGuess({w,h},{accept:()=>false})],[]);
});

test('高峰值搜索保留较低的已验证候选，并采用超过峰值下限的合成棋局', () => {
  const p={w:20,h:20,minAverage:1,minMultiPercent:0,minPeakClues:15};
  const generator=engine.generate(p,2);
  const before=Array.from({length:3},()=>generator.next().value);
  assert.ok(before.every(result=>!result.board));
  const {candidate}=before.at(-1);
  assert.ok(candidate.report.clues<p.minPeakClues);
  assert.deepEqual(engine.verify(candidate.board,p,{certify:true}),candidate.report);
  const {board,report,route}=generator.next().value;
  assert.equal(route,'composed-transfer');
  assert.equal(report.clues,16);
  assert.deepEqual(engine.verify(board,p,{certify:true}),report);
});

test('20×20 的十五线索混合图开局，去掉任何一条后都没有固定格', () => {
  const p={w:20,h:20,minAverage:1,minMultiPercent:0,minPeakClues:15};
  const bombs=[
    '00000000111000000000000000001010000000000000000010001100000000000000110100011000',
    '10000000101101001000111111100100101010001111111000000100000011111111101111011000',
    '11111000011111001000111110011111111010001111100111111100000011111110111111100000',
    '11111111111111100000111111111111111000001111111111111110000011111111111111100000',
    '11111111111111100000111111111111111000001111111111111110000011111111111111100000',
  ].join('').split('').map(v=>v==='1');
  const ns=engine.adj(p.w,p.h), opening=[29,50,72,74,89,95,111,128,132,134,168,175,186,195,227];
  const clues=ns.map(row=>row.filter(v=>bombs[v]).length);
  const board={w:p.w,h:p.h,ns,opening,bombs,clues,mines:bombs.filter(Boolean).length};
  const replay=engine.verify(board,p,{certify:true,trace:true});
  assert.equal(replay.status,'passed');
  assert.equal(replay.openingClues,15);
  assert.equal(replay.clues,15);
  const givens=new Set(board.opening);
  const degree=board.opening.map(v=>board.opening.filter(u=>u!==v &&
    board.ns[v].some(x=>!givens.has(x) && board.ns[u].includes(x))).length);
  assert.ok(degree.some(n=>n>=3));
  assert.ok(degree.reduce((sum,n)=>sum+n,0)>=2*givens.size);
  assert.equal(replay.trace[0].positionMinimum,true);
  for(const v of board.opening) {
    const view=engine.opening(board);
    view[v]=-1;
    const weakened=engine.transfer({...p,mines:board.mines},view,{knownSafe:new Set([v]),nodeBudget:Infinity});
    assert.equal(weakened.status,'complete');
    assert.ok(weakened.state.every(state=>state!=='safe' && state!=='mine'));
  }
});

test('高峰值生成续接困难回合，新揭示的数字使原本不确定的格可推导', () => {
  const p={w:20,h:20,minPeakClues:15,minAverage:2,minMultiPercent:30};
  const candidates=[];
  const generator=engine.generate(p,2,({candidate})=>candidates.push(candidate));
  for(let round=0;round<5;round++) generator.next();
  const anchor=candidates.find(({report})=>report.clues>=p.minPeakClues);
  assert.ok(anchor);
  assert.ok(candidates.some(({board,report})=>board.mines===anchor.board.mines &&
    engine.opening(board).join()===engine.opening(anchor.board).join() && report.clues===anchor.report.clues &&
    report.averageClues>anchor.report.averageClues && report.advancedDensity>anchor.report.advancedDensity));
  const linked=candidates.find(({report})=>report.clues===15);
  assert.ok(linked);
  const {board}=linked, rounds=[];
  const {trace,...report}=engine.verify(board,p,{certify:true,trace:true,observeRound:(visible,flags,state)=>{
    rounds.push({visible:visible.slice(),flags:new Set(flags),state});
  }});
  assert.deepEqual({...report,trace:[]},linked.report);
  const source=168, target=184;
  const firstCommit=trace.findIndex(move=>move.commit);
  const followUp=trace.slice(firstCommit+1,trace.findIndex((move,i)=>i>firstCommit && move.commit)+1);
  assert.ok(trace[0].safe.includes(source) && trace[0].sources.length===15);
  assert.equal(rounds[0].state[target],'either');
  assert.ok(followUp.some(move=>move.safe.includes(target) && move.sources.includes(source) && move.sources.length===4));
  const {visible,flags}=rounds[1];
  assert.ok(visible[source]>=0);
  visible[source]=-1;
  const withoutDigit=engine.transfer(board,visible,{knownSafe:new Set([source]),proven:flags});
  assert.equal(withoutDigit.status,'complete');
  assert.equal(withoutDigit.state[target],'either');
});
