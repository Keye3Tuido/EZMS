const assert=require('node:assert/strict');
const test=require('node:test');
const engine=require('./engine');
const seeds=require('./position-seed')(engine.adj);
const {makeMarkHistory,makeManualBatch}=require('./model/mark-model');
const {history:makeSelectionHistory}=require('./region-selection')(engine.adj);
const gameModel=require('./model/game-model')({engine,seeds,makeMarkHistory,makeSelectionHistory});
const makeEditorModel=require('./model/editor-model');

test('回合提交准备保持原旗标和确认状态，应用开格后才更新棋盘',()=>{
  const game=gameModel.positionGame(seeds.create(3,2,'100000'));
  game.flags.add(1);
  game.manual=makeManualBatch(['mine','safe','both','both','both','both'],game.flags,engine.confirmationTargets,game.notes);
  game.manual.recordStep([1],[0]);
  const {safe,mines,proven,flags}=gameModel.prepareCommit(game);
  assert.deepEqual(safe,[1]);
  assert.deepEqual(mines,[0]);
  assert.deepEqual(proven,new Set([0]));
  assert.deepEqual(flags,new Set([0]));
  assert.deepEqual(game.flags,new Set([1]));
  assert.equal(game.opened,0);
  gameModel.applyAdvance(game,{board:game.board,visible:[-1,1,-1,-1,-1,-1],opened:1});
  gameModel.discardOpenedMarks(game,safe);
  gameModel.resetConfirmation(game);
  assert.equal(game.opened,1);
  assert.equal(game.manual,null);
  assert.deepEqual(game.flags,new Set());
});

test('数字草稿调整尺寸时重映射数字和标记，原棋局保留',()=>{
  const editor=makeEditorModel({engine,seeds,gameModel});
  const game=gameModel.positionGame(seeds.numbers(3,2,2,'.1..2.',[3]));
  game.notes.edit('blue',[[5,{symbol:'x',level:0}]]);
  editor.parkedGame=gameModel.positionGame(seeds.create(3,2));
  editor.draft=game;
  const resized=gameModel.positionGame(editor.resize(game,{w:4,h:2},false));
  assert.deepEqual(resized.visible,[-1,1,-1,-1,-1,2,-1,-1]);
  assert.deepEqual(resized.flags,new Set([4]));
  assert.equal(resized.notes.layers.blue.get(6).symbol,'x');
  assert.equal(editor.setMineCount(resized,9),false);
  assert.equal(resized.board.mines,2);
  assert.equal(editor.setMineCount(resized,3),true);
  assert.equal(resized.p.mines,3);
  assert.equal(editor.parkedGame.board.w,3);
  assert.equal(editor.draft,game);
});
