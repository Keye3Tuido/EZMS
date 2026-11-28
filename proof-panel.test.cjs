const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {Script} = require('node:vm');
const {focusBoardCell} = require('./board-input');
const engine = require('./engine');
const format = require('./proof-format');
const makeProofRenderer = require('./proof-renderer');
const makeGameRequests = require('./game-requests');
const makeGameModel = require('./model/game-model');
const seeds = require('./position-seed')(engine.adj);
const source = readFileSync(`${__dirname}/app.js`, 'utf8');

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

// Use the same renderer interface as the browser, with a minimal DOM and board focus adapter.
function renderSteps(game,move,proofTargets,proofRows,buttons=[]) {
  return makeProofRenderer({
    element(tag,className,text) {
      const node=new Node();
      node.className=className;
      if(text!==undefined) node.textContent=text;
      return node;
    },
    format,equivalentGroups:engine.equivalentGroups,proofTargets,proofRows,
    focusBoardCell:target=>focusBoardCell(game,buttons,target),
    scrollToTotal() {}
  }).steps(game,move);
}

function render(seed, confirmed=[], target) {
  const game=seeds.decode(seed), {board,visible,flags}=game;
  const {move}=engine.hint(board,visible,new Set(),new Set(flags),{opening:true,confirmed,target});
  return {move,rows:renderMove(game,move,confirmed)};
}

function renderMove(game,move,confirmed=[]) {
  const {board}=game;
  const proofTargets=new WeakMap(), proofRows=new WeakMap();
  const descendants=node=>node.children.flatMap(child=>[child,...descendants(child)]);
  const rows=renderSteps({...game,manual:{marked:new Map(confirmed)}},move,proofTargets,proofRows).children.map(row=>({
    formula:row.children[1].textContent,
    chain:row.children[1].children.filter(node=>node.classes.has('formula-chain-row'))
      .map(node=>node.children.map(part=>part.textContent)),
    note:row.children[2]?.textContent??'',
    clueEquation:row.children[1].classes.has('clue-equation'),
    clueCircles:row.children.slice(1).map(part=>part.children.flatMap(button=>
      button.children.filter(child=>child.classes.has('clue-coordinate')).map(child=>({
        coordinate:child.textContent,
        preview:[...proofTargets.get(button).cells].sort((a,b)=>a-b)
      })))),
    refs:row.querySelectorAll('.proof-note [data-equation]').map(ref=>Number(ref.textContent)),
    signedAreas:proofRows.has(row)?[...proofRows.get(row).areas.slice(1,3)].map(area=>[...area].sort((a,b)=>a-b)):undefined,
    weights:proofRows.has(row)?[...proofRows.get(row).weights].map(([v,c])=>[v,c]).sort(([a],[b])=>a-b):undefined,
    totalTargets:descendants(row.children[1]).filter(node=>proofTargets.get(node)?.total).map(node=>node.textContent),
    formulaTargets:descendants(row.children[1]).filter(node=>proofTargets.has(node)).map(node=>({
        label:node.textContent,cells:[...proofTargets.get(node).cells].sort((a,b)=>a-b)
      })),
    safe:row.classes.has('conclusion-safe'), mine:row.classes.has('conclusion-mine')
  }));
  return rows;
}

test('a circled clue focuses the number cell and previews its unknown neighbors', () => {
  const game=seeds.decode('J:eVyiz!}'), {board,visible,flags}=game;
  const {move}=engine.hint(board,visible,new Set(),new Set(flags),{opening:true});
  const proofTargets=new WeakMap(), proofRows=new WeakMap();
  let focused;
  const buttons=Array.from(visible,(_,v)=>({tabIndex:-1,focus:()=>{focused=v;}}));
  game.focus=3;
  buttons[3].tabIndex=0;
  const rows=renderSteps(game,move,proofTargets,proofRows,buttons);
  const row=rows.children.find(row=>row.children[1].children[0]?.textContent==='E1');
  const clue=row.children[1].children[0];
  assert.ok(clue.classes.has('clue-region'));
  assert.deepEqual([...proofTargets.get(clue).cells],[3,5,10]);
  clue.onclick();
  assert.equal(game.focus,4);
  assert.equal(focused,4);
  assert.equal(buttons[3].tabIndex,-1);
  assert.equal(buttons[4].tabIndex,0);
});

test('nine clue regions cancel in one equality after confirming C1:C3', () => {
  const seed='J:eVyiz!}';
  const first=render(seed).move;
  assert.deepEqual(first.safe,[2,8,14]);
  const confirmed=first.safe.map(v=>[v,'safe']);
  const {move,rows}=render(seed,confirmed);
  assert.equal(move.positionMinimum,true);
  assert.equal(move.sources.length,9);
  assert.deepEqual(move.safe,[0,1,7,29,30,35]);
  assert.deepEqual(move.mines,[19]);
  assert.deepEqual(move.proofs.map(proof=>proof.kind),['linear']);
  assert.equal(rows.length,12);
  for (const row of rows.slice(0,9)) {
    assert.equal(row.clueEquation,true);
    const [formulaClues,noteClues=[]]=row.clueCircles;
    assert.equal(formulaClues.length,1);
    assert.deepEqual(noteClues,[]);
    const [{coordinate,preview}]=formulaClues;
    assert.match(row.formula,new RegExp(`^${coordinate}= [0-8]$`));
    assert.ok(row.note==='' || row.note==='已确认安全格计 0');
    assert.ok(preview.length>0);
    assert.deepEqual(preview,row.signedAreas[0]);
  }
  const [cancellation,mine,safe]=rows.slice(9);
  assert.equal(cancellation.clueEquation,false);
  assert.deepEqual(cancellation.clueCircles,[[],[]]);
  assert.deepEqual(rows.filter(row=>row.safe||row.mine),[mine,safe]);
  assert.deepEqual(cancellation.signedAreas,[[19],[0,1,7,29,30,35]]);
  assert.equal(cancellation.formula,'1 =B4−A1:B2−F5:F6−A6');
  assert.deepEqual(cancellation.refs.slice().sort((a,b)=>a-b),[1,2,3,4,5,6,7,8,9]);
  assert.equal(mine.mine,true);
  assert.deepEqual(mine.chain,[['','B4'],['=','1+A1:B2+F5:F6+A6'],['≥','1 + 0 + 0 + 0'],['=','1']]);
  assert.deepEqual(mine.signedAreas,cancellation.signedAreas);
  assert.deepEqual(mine.refs,[10]);
  assert.equal(safe.safe,true);
  assert.deepEqual(safe.chain,[['','A1:B2+F5:F6+A6'],['=','B4− 1'],['≤','1 − 1'],['=','0']]);
  assert.deepEqual(safe.signedAreas,[[0,1,7,29,30,35],[19]]);
  assert.deepEqual(safe.weights,[[0,1],[1,1],[7,1],[19,-1],[29,1],[30,1],[35,1]]);
  assert.deepEqual(safe.formulaTargets.map(({label})=>label),['A1:B2','F5:F6','A6','B4']);
  assert.deepEqual(safe.refs,[10]);
  assert.match(safe.note,/正项至多为 1/);
  const mineHint=render(seed,confirmed,19);
  assert.equal(mineHint.move.sources.length,9);
  assert.deepEqual(mineHint.move.proofs.map(proof=>proof.kind),['linear']);
  assert.deepEqual(mineHint.rows,rows);
});

test('equivalent weighted targets share one isolation formula and one region preview', () => {
  const {move,rows}=render('J:eVyiz!}');
  assert.deepEqual(move.safe,[2,8,14]);
  const conclusion=rows.at(-1);
  assert.deepEqual(rows.filter(row=>row.safe||row.mine),[conclusion]);
  assert.deepEqual(conclusion.chain.map(([operator])=>operator),['','=','≤','=']);
  assert.equal(conclusion.chain[0][1],'C1:C3');
  assert.match(conclusion.chain[1][1],/^1\/2 × \(1.*\)$/);
  assert.match(conclusion.chain[2][1],/^1\/2 × \(1(?: [−+] 0)+\)$/);
  assert.equal(conclusion.chain[3][1],'1/2');
  assert.deepEqual(conclusion.formulaTargets[0],{label:'C1:C3',cells:[2,8,14]});
  assert.ok(conclusion.formulaTargets.slice(1).every(({cells})=>cells.every(v=>!move.safe.includes(v))));
  assert.deepEqual(conclusion.refs,[rows.length-1]);
  assert.equal(rows[0].formula,'全盘= 8');
  assert.deepEqual(rows[0].totalTargets,['全盘']);
  assert.deepEqual(rows[0].formulaTargets,[{label:'全盘',cells:rows[0].signedAreas[0]}]);
  assert.ok(rows.slice(1).every(row=>!row.totalTargets.length));
  assert.equal(rows[0].note,'');
  assert.equal(rows[0].clueEquation,true);
});

test('a clue that subtracts a confirmed mine shows the original count and the subtraction', () => {
  const {rows}=render('J:eVyiz!}',[[2,'safe'],[8,'safe'],[14,'safe'],[19,'mine']]);
  const clue=rows.find(row=>row.formula.startsWith('A4='));
  assert.equal(clue.formula,'A4= 2');
  assert.equal(clue.note,'3 − 1（扣除已知雷）');
  assert.deepEqual(clue.clueCircles[1],[]);
  assert.ok(!clue.clueCircles[0][0].preview.includes(19));
});

test('one mixed equality replaces a separate rounding proof of the same cells', () => {
  const {move,rows}=render('>&;a6&r');
  assert.deepEqual(move.safe,[12,16,17,18]);
  assert.deepEqual(move.mines,[0]);
  assert.deepEqual(move.proofs.map(p=>p.kind),['linear']);
  assert.equal(rows.length,7);
  const [cancellation,mine,safe]=rows.slice(4);
  assert.deepEqual(rows.filter(row=>row.safe||row.mine),[mine,safe]);
  assert.equal(cancellation.formula,'1 =A1−A4:C5');
  assert.deepEqual(cancellation.refs.slice().sort(),[1,2,3,4]);
  assert.deepEqual(mine.chain,[['','A1'],['=','1+A4:C5'],['≥','1 + 0'],['=','1']]);
  assert.deepEqual(safe.chain,[['','A4:C5'],['=','A1− 1'],['≤','1 − 1'],['=','0']]);
  assert.ok(rows.every(row=>!row.note.includes('÷ 2')));
});

test('a weighted conclusion previews all signed cells and ends at the numeric bound', () => {
  const {rows}=render("C('JKn6a1FFf31{");
  const [original,isolated]=rows.slice(-2);
  assert.match(original.formula,/2·E2/);
  assert.deepEqual([original.safe,original.mine],[false,false]);
  assert.deepEqual(original.signedAreas,[[3,4,8,9,15,20,21],[11]]);
  assert.deepEqual([isolated.safe,isolated.mine],[true,false]);
  assert.deepEqual(isolated.signedAreas,original.signedAreas);
  assert.deepEqual(isolated.weights,[[3,1],[4,1],[8,1],[9,2],[11,-1],[15,1],[20,1],[21,1]]);
  assert.deepEqual(isolated.formulaTargets[0],{label:'E2',cells:[9]});
  assert.ok(isolated.formulaTargets.some(({label})=>label==='B3'));
  assert.deepEqual(isolated.chain.map(([operator])=>operator),['','=','≤','=']);
  assert.equal(isolated.chain[0][1],'E2');
  assert.match(isolated.chain[1][1],/^1\/2 × \(0.*\)$/);
  assert.match(isolated.chain[2][1],/^1\/2 × \(0 \+ 1(?: − 0)+\)$/);
  assert.equal(isolated.chain[3][1],'1/2');
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

test('停止求解控件只在状态变化时更新，并立即作废待处理工作',async()=>{
  const {readFileSync}=require('node:fs');
  const {runInNewContext}=require('node:vm');
  const source=readFileSync(`${__dirname}/app.js`,'utf8');
  const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b));
  const calls=[];
  const label={textContent:'自动求解'};
  const button={querySelector:s=>s==='use'?{setAttribute:(...args)=>calls.push(args)}:label,
    set innerHTML(_) {throw Error('不应重建停止按钮');}};
  await runInNewContext(section('  function updateSolveControl(', '  function controls(')+
    section('  function stopAuto()', '  function background(')+`
    let run=7, auto=true, proofVisible=false;
    const generation={searching:false};
    const gameRequests=makeGameRequests({openWorker:()=>({postMessage(){},addEventListener(){},terminate(){events.push('terminate');}}),onBusyChange:controls});
    const {cancel:cancelPlayRequest}=gameRequests;
    const result=gameRequests.ask('hint',{}).then(value=>events.push({value,run,auto}));
    updateSolveControl(true);
    updateSolveControl(true);
    stopAuto();
    result;
    `,{$:()=>button,controls(){},events:calls,makeGameRequests});
  assert.equal(label.textContent,'停止求解');
  assert.equal(calls.filter(Array.isArray).length,1);
  assert.deepEqual({...calls.at(-1)},{value:null,run:8,auto:false});
});

test('提交后自动刷新的线索可立即关闭，取消后不渲染旧结果',async()=>{
  const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b));
  const events=[];
  const state=new Script([
    section('  function cancelProofRequest()', '  async function judge('),
    section('  async function commitBatch(', '  function play('),
    section('  async function stageStep(', '  function pauseSolve()'),
    section('  function toggleHint(', '  function showReason('),
    section('  function closeProof()', '  function setMode('),
    `let auto=false, run=0, editing=false;
    const generation={searching:false};
    const worker={postMessage(){},addEventListener(){},terminate(){events.push('terminate');}};
    const gameRequests=makeGameRequests({openWorker:()=>worker,onBusyChange:controls});
    const {cancel:cancelPlayRequest}=gameRequests;
    let proofVisible=true, proofMode='focus', proofRequest, proofReturn, proofHighlight, shownProofClues;
    const game={state:'playing',visible:[0,-1,-1],opened:1,board:{mines:1},
      flags:new Set(),proven:new Set(),notes:{discardConfirmations(){}},
      manual:{done:true,cells:kind=>kind==='mine'?[1]:[]}};
    function setProofVisible(open){proofVisible=open;if(!open) proofMode=undefined;}
    function next(){return gameRequests.ask('hint',{});}
    const commit=commitBatch(game);
    ({commit,toggleHint,visible:()=>proofVisible,pending:()=>gameRequests.busy && worker.onmessage ? data=>worker.onmessage({data}) : null})`
  ].join('\n'),{filename:'app.js'}).runInNewContext({
    events, makeGameRequests, gameModel:makeGameModel({engine,seeds}), dismissSearchResult(){},
    feedback:{handoff(){},sound(){}}, boardOverlays:{inkDrawing:{}}, discardOpenedMarks(){},
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

test('求解一步落红标后按新局面刷新，并保留原模式和折叠状态',async()=>{
  const request=source.slice(source.indexOf('  async function requestHint('),source.indexOf('  function showReason('));
  const stage=source.slice(source.indexOf('  async function stageStep('),source.indexOf('  function pauseSolve()'));
  const script=new Script([request,stage,
    `const game={flags:new Set()}, events=[];
    let run=0, auto=false, reasonCollapsed=true, proofMode=initialMode, proofReturn;
    const gameRequests={busy:false};
    let proofVisible=initiallyVisible;
    const compactReason={matches:false};
    function setReasonCollapsed(value){reasonCollapsed=value;}
    function clearHint(visible){proofVisible=visible;events.push(['clear',visible]);}
    async function next(){return {move:{safe:[0],mines:[]}};}
    async function judge(){return {status:'complete',state:['safe']};}
    function makeManualBatch(){
      return {done:false,marked:new Map(),recordStep(safe){this.marked.set(safe[0],'safe');this.done=roundDone;}};
    }
    function showMarks(){events.push(['marked', [...game.manual.marked]]);if(closeWhileStaging) proofVisible=false;}
    function display(result,weak){events.push(['display',result.status,weak]);}
    async function previewNextProof(mode){events.push(['preview',mode,[...game.manual.marked]]);}
    ({events, collapsed:()=>reasonCollapsed, visible:()=>proofVisible, request:mode=>requestHint({},mode)})`
  ].join('\n'),{filename:'app.js'});
  const scenarios=[
    {initiallyVisible:true,initialMode:'hint',expected:[['clear',true],['marked',[[0,'safe']]],['preview','hint',[[0,'safe']]]]},
    {initiallyVisible:true,initialMode:'focus',expected:[['clear',true],['marked',[[0,'safe']]],['preview','focus',[[0,'safe']]]]},
    {initiallyVisible:true,initialMode:'hint',roundDone:true,expected:[['clear',true],['marked',[[0,'safe']]],['display','confirmed',false]]},
    {initiallyVisible:false,expected:[['clear',false],['marked',[[0,'safe']]]]},
    {initiallyVisible:true,closeWhileStaging:true,expected:[['clear',true],['marked',[[0,'safe']]]]}
  ];
  for(const {expected,...scenario} of scenarios) {
    const state=script.runInNewContext({roundDone:false,closeWhileStaging:false,initialMode:undefined,engine:{},
      ready:()=>true,dismissSearchResult(){},clearSelection(){},render(){},...scenario});
    await state.request();
    assert.deepEqual(JSON.parse(JSON.stringify(state.events)),expected);
    assert.equal(state.collapsed(),true);
    assert.equal(state.visible(),scenario.initiallyVisible&&!scenario.closeWhileStaging);
    if(!scenario.initiallyVisible) {
      await state.request('hint');
      assert.equal(state.collapsed(),false);
      assert.equal(state.visible(),true);
    }
  }
});
