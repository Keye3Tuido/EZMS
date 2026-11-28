// 局面数据、棋局历史和旗标操作可独立于页面使用。
function makeGameModel({engine,seeds,makeMarkHistory,makeSelectionHistory}) {
  const noteColors=['red','blue','archivedBlue'];

  function positionGame({board,visible=engine.opening(board),flags=[],notes=[],numbers=false},p={}) {
    const opened=visible.filter(n=>n>=0).length;
    const history=makeMarkHistory();
    for (const [i,color] of noteColors.entries()) {
      for(const [cell,mark] of notes[i]??[]) history.layers[color].set(cell,
        color==='red' && mark.symbol==='s'?{...mark,symbol:'/'}:mark);
    }
    return {board,original:board,originalVisible:visible,originalFlags:[...flags],p:{...p,w:board.w,h:board.h,mines:board.mines},
      numbers,visible,flags:new Set(flags),notes:history,proven:new Set(),opened,
      state:opened===visible.length-board.mines?'won':'playing',started:null,ended:null,focus:board.first,
      judgment:null,answers:false,selection:makeSelectionHistory()};
  }

  function copyPosition(g) {
    const position=seeds.decode(seeds.encode(g));
    position.notes[1]=[...g.notes.layers.blue];
    position.notes[2]=[...g.notes.layers.archivedBlue];
    return position;
  }

  function removeFlag(g,i) {
    g.flags.delete(i);
    g.verification=undefined;
    g.notes.discardRedo();
    g.manual?.refreshTargets();
  }

  function noteEntries(game) {
    return noteColors.map(color=>[...game.notes.layers[color]]);
  }

  function prepareCommit(g) {
    const safe=g.manual.cells('safe'), mines=g.manual.cells('mine');
    const proven=new Set([...g.proven,...mines]);
    const flags=new Set([...g.flags,...mines]);
    for(const cell of safe) flags.delete(cell);
    return {safe,mines,proven,flags};
  }

  function applyAdvance(g,{board,visible,opened}) {
    Object.assign(g,{board,visible,opened:g.opened+opened,judgment:null});
  }

  function discardOpenedMarks(g,cells) {
    for(const cell of cells) g.flags.delete(cell);
    g.notes.discardCells(cells);
  }

  function resetConfirmation(g) {
    g.manual=null;
    g.notes.discardConfirmations();
  }

  function markWon(g,now) {
    g.state='won';
    g.ended=now;
  }

  return {positionGame,copyPosition,removeFlag,noteEntries,prepareCommit,applyAdvance,discardOpenedMarks,resetConfirmation,markWon};
}

if(typeof module!=='undefined') module.exports=makeGameModel;
