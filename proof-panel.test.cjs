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
  const rows=renderer.runInNewContext({
    game, move, engine, format, document:{createElement:()=>new Node()},
    proofTargets:new WeakMap(), proofRows:new WeakMap(),
    coord:v=>format.coordinate(v,board.w), source:v=>v<0?'total':format.coordinate(v,board.w)
  }).children.map(row=>({
    formula:row.children[1].textContent,
    note:row.children[2]?.textContent??'',
    refs:row.querySelectorAll('.proof-note [data-equation]').map(ref=>Number(ref.textContent)),
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
