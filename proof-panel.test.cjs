const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {Script} = require('node:vm');
const engine = require('./engine');
const format = require('./proof-format');
const seeds = require('./position-seed')(engine.adj);

// Exercise the real formula renderer without starting browser workers or timers.
const source = readFileSync(`${__dirname}/app.js`, 'utf8');
const renderer = new Script([
  source.slice(source.indexOf('  function proofPreview('),source.indexOf('  const proofPanel=')),
  source.slice(source.indexOf('  function element('),source.indexOf('  function display(')),
  'steps(move)'
].join('\n'),{filename:'app.js'});

class Node {
  constructor() {
    this.parts=[];
    this.dataset={};
    this.classes=new Set();
    this.classList={add:name=>this.classes.add(name)};
  }
  set className(name) {this.classes=new Set(name.split(' '));}
  set textContent(text) {this.parts=[text];}
  get textContent() {return this.parts.map(part=>part instanceof Node?part.textContent:part).join('');}
  get children() {return this.parts.filter(part=>part instanceof Node);}
  setAttribute() {}
  append(...parts) {
    for(const part of parts) if(part instanceof Node) part.parent=this;
    this.parts.push(...parts);
  }
  remove() {this.parent.parts=this.parent.parts.filter(part=>part!==this);}
  querySelectorAll(selector) {
    const descendants=node=>node.children.flatMap(child=>[child,...descendants(child)]);
    const elements=descendants(this);
    const scope=selector==='.proof-note [data-equation]'
      ? elements.filter(node=>node.classes.has('proof-note')).flatMap(descendants) : elements;
    return scope.filter(node=>node.dataset.equation);
  }
}

function render(seed) {
  const game=seeds.decode(seed), {board,visible,flags}=game;
  const {move}=engine.hint(board,visible,new Set(),new Set(flags),{opening:true});
  const proofTargets=new WeakMap(), proofRows=new WeakMap();
  const rows=renderer.runInNewContext({
    game, move, engine, format, document:{createElement:()=>new Node()},
    proofTargets, proofRows,
    coord:v=>format.coordinate(v,board.w), source:v=>v<0?'total':format.coordinate(v,board.w)
  }).children.map(row=>({
    formula:row.children[1].textContent,
    note:row.children[2]?.textContent??'',
    refs:row.querySelectorAll('.proof-note [data-equation]').map(ref=>Number(ref.textContent)),
    signedAreas:proofRows.has(row)?[...proofRows.get(row).areas.slice(1,3)].map(area=>[...area].sort((a,b)=>a-b)):undefined,
    weights:proofRows.has(row)?[...proofRows.get(row).weights].map(([v,c])=>[v,c]).sort(([a],[b])=>a-b):undefined,
    derivation:row.children[1].children.filter(node=>node.classes.has('isolation-row')).map(node=>{
      const [relation,expression]=node.children;
      const chips=expression.children.flatMap(child=>proofTargets.has(child)?[child]:child.children.filter(child=>proofTargets.has(child)));
      return {relation:relation.textContent,expression:expression.textContent,chips:chips.map(chip=>chip.textContent)};
    }),
    safe:row.classes.has('conclusion-safe'), mine:row.classes.has('conclusion-mine')
  }));
  return {move,rows};
}

test('one mixed equality replaces a separate rounding proof of the same cells', () => {
  const {move,rows}=render('>&;a6&r');
  assert.deepEqual(move.safe,[12,16,17,18]);
  assert.deepEqual(move.mines,[0]);
  assert.deepEqual(move.proofs.map(p=>p.kind),['linear','cut']);
  assert.equal(rows.length,5);
  const conclusion=rows[4];
  assert.deepEqual(rows.filter(row=>row.safe||row.mine),[rows[4]]);
  assert.equal(conclusion.formula,'1 =A1−A4:C5');
  assert.deepEqual([conclusion.safe,conclusion.mine],[true,true]);
  assert.deepEqual(conclusion.refs.slice().sort(),[1,2,3,4]);
  assert.ok(rows.every(row=>!row.note.includes('÷ 2')));
});

test('a weighted conclusion previews the symbolic right-hand side and ends at the numeric bound', () => {
  const {rows}=render("C('JKn6a1FFf31{");
  const [original,isolated]=rows.slice(-2);
  assert.match(original.formula,/2·E2/);
  assert.deepEqual([original.safe,original.mine],[false,false]);
  assert.deepEqual(original.signedAreas,[[3,4,8,9,15,20,21],[11]]);
  assert.deepEqual([isolated.safe,isolated.mine],[true,false]);
  assert.deepEqual(isolated.signedAreas,[[11],[3,4,8,15,20,21]]);
  assert.deepEqual(isolated.weights,[[3,-1],[4,-1],[8,-1],[11,1],[15,-1],[20,-1],[21,-1]]);
  assert.deepEqual(isolated.derivation.map(row=>row.relation),['', '=', '≤', '=']);
  const [target,symbolic,bound,limit]=isolated.derivation;
  assert.deepEqual(target.chips,['E2']);
  assert.match(symbolic.expression,/^1\/2 × \(0.*\)$/);
  assert.ok(symbolic.chips.includes('B3'));
  assert.match(bound.expression,/^1\/2 × \(0.*\)$/);
  assert.deepEqual(bound.chips,[]);
  assert.equal(limit.expression,'1/2');
  assert.deepEqual(isolated.refs,[rows.length-1]);
});

test('a shared bound and separate formulas survive when each conclusion adds cells', () => {
  const {move,rows}=render(':P^qQ');
  assert.deepEqual(move.safe,[10,15]);
  assert.deepEqual(move.mines,[2]);
  const safe=rows.find(row=>row.safe), mine=rows.find(row=>row.mine);
  assert.notEqual(safe,mine);
  assert.match(mine.formula,/C1/);
  assert.match(safe.formula,/C3:D4/);
  const prerequisite=rows[mine.refs.at(-1)-1];
  assert.match(prerequisite.formula,/≤/);
  assert.equal(prerequisite.safe||prerequisite.mine,false);
  assert.ok(prerequisite.refs.length>0);
  assert.ok(rows.every((row,i)=>row.refs.every(ref=>ref>0&&ref<=i)));
});

test('rounding remains visible when it proves a new cell', () => {
  const {move,rows}=render(':-F6n');
  assert.deepEqual(move.safe,[0,8]);
  assert.deepEqual(move.mines,[14]);
  assert.ok(rows.some(row=>row.note.includes('÷ 2')));
  assert.ok(rows.some(row=>row.mine&&row.formula.includes('C4')));
  assert.ok(rows.some(row=>row.safe));
  assert.ok(rows.every((row,i)=>row.refs.every(ref=>ref>0&&ref<=i)));
});


test('显示不等式和移项后的结论时，正系数变量项统一排在前面',()=>{
  const {comparison,isolateConclusion,terms}=require('./proof-format');
  assert.deepEqual(comparison([[0,-2],[1,1],[2,-1]],'≤',1,[]).terms.map(t=>t.cells[0]),[1,0,2]);
  assert.deepEqual(comparison([[0,-2],[1,1],[2,-1]],'≤',-1,[]).terms.map(t=>t.cells[0]),[0,2,1]);
  const isolated=isolateConclusion([[0,1],[1,-1],[2,2]],'≤',0,2,0);
  assert.deepEqual(terms(isolated.terms,[]).map(t=>t.cells[0]),[1,0]);
});

test('停止求解控件只在状态变化时更新，并立即作废待处理工作',()=>{
  const {readFileSync}=require('node:fs');
  const {runInNewContext}=require('node:vm');
  const source=readFileSync(`${__dirname}/app.js`,'utf8');
  const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b));
  const calls=[];
  const label={textContent:'自动求解'};
  const button={querySelector:s=>s==='use'?{setAttribute:(...args)=>calls.push(args)}:label,
    set innerHTML(_) {throw Error('不应重建停止按钮');}};
  runInNewContext(section('  function updateSolveControl(', '  function controls(')+
    section('  function cancelPlayRequest()', '  function finishWorker(')+`
    let run=7, auto=true, proofVisible=false, worker;
    let playWorker={terminate(){events.push('terminate');}},pending=value=>events.push({value,run,auto});
    updateSolveControl(true);
    updateSolveControl(true);
    stopAuto();
    `,{$:()=>button,controls(){},events:calls});
  assert.equal(label.textContent,'停止求解');
  assert.equal(calls.filter(Array.isArray).length,1);
  assert.deepEqual({...calls.at(-1)},{value:null,run:8,auto:false});
});

test('提交后自动刷新的线索可立即关闭，取消后不渲染旧结果',async()=>{
  const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b));
  const events=[];
  const state=new Script([
    section('  function cancelPlayRequest()', '  function stopAuto()'),
    section('  function cancelProofRequest()', '  async function judge('),
    section('  async function commitBatch(', '  function play('),
    section('  async function stageStep(', '  function pauseSolve()'),
    section('  function toggleHint(', '  function showReason('),
    section('  function closeProof()', '  function setMode('),
    `let auto=false, run=0, pending, playWorker, editing=false, worker;
    let proofVisible=true, proofMode='focus', proofRequest, proofReturn;
    const game={state:'playing',visible:[0,-1,-1],opened:1,board:{mines:1},
      flags:new Set(),proven:new Set(),notes:{discardConfirmations(){}},
      manual:{done:true,cells:kind=>kind==='mine'?[1]:[]}};
    function setProofVisible(open){proofVisible=open;if(!open) proofMode=undefined;}
    function next(){
      playWorker={terminate(){events.push('terminate');}};
      return new Promise(resolve=>{pending=resolve;});
    }
    const commit=commitBatch(game);
    ({commit,toggleHint,visible:()=>proofVisible,pending:()=>pending})`
  ].join('\n'),{filename:'app.js'}).runInNewContext({
    events, dismissSearchResult(){}, feedback:{handoff(){},sound(){}}, inkDrawing:{}, discardOpenedMarks(){},
    scheduleVerification(){}, clearProofHover(){}, proofPanel:{replaceChildren(){}}, element(){},
    say(){}, render(){}, controls(){}, focusProofReturn(){}, display:(_result,weak)=>events.push(weak)
  });
  const oldResult=state.pending();
  assert.equal(typeof oldResult,'function');
  state.toggleHint('focus');
  assert.equal(state.visible(),false);
  assert.equal(state.pending(),null);
  oldResult({status:'confirmed'});
  assert.equal(await state.commit,true);
  assert.deepEqual(events,['terminate']);
});

test('求解一步刷新提示时继续显示当前选中的提示类型',async()=>{
  const stage=source.slice(source.indexOf('  async function stageStep('),source.indexOf('  function pauseSolve()'));
  const displays=[];
  await new Script(`${stage}
    let game, run=0, proofVisible=true, proofMode='focus';
    stageStep({status:'confirmed'});`).runInNewContext({display:(_a,weak)=>displays.push(weak)});
  assert.deepEqual(displays,[true]);
});
