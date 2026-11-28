// 组装应用与 Worker 共享的引擎接口。各模块通过传入的能力协作。
function makeMinesEngine(factories) {
  'use strict';
  const {board:makeBoard=makeMinesBoard,constraints:makeConstraints=makeMinesConstraints,
    inference:makeInference=makeMinesInference,
    generation:makeGeneration=makeMinesGeneration}=factories??{};
  const board=makeBoard();
  const model=makeConstraints(board);
  const inference=makeInference(board,model);
  const generation=makeGeneration(board,model,inference);
  const {adj,candidate,opening,reveal,numberAction}=board;
  const {equivalentGroups,classify,transfer,selectionTotals,gate}=model;
  const {analyze,minimumProof,enumerateNoGuess,confirmationTargets,advance,verify,hint,inspect,expand,publicBoard}=inference;
  const {composeClues,difficultyDefaults,generationRanking,generationSchedule,composeClueSearch,generate}=generation;
  return {version:22,adj,candidate,opening,reveal,numberAction,analyze,equivalentGroups,minimumProof,classify,transfer,
    enumerateNoGuess,composeClues,selectionTotals,confirmationTargets,gate,advance,verify,hint,inspect,expand,
    publicBoard,difficultyDefaults,generationRanking,generationSchedule,composeClueSearch,generate};
}

function minesEngineWorkerSource() {
  // 直接打开 index.html 时，Blob Worker 也能获得与页面相同的模块。
  return [makeMinesBoard,makeMinesConstraints,makeMinesInference,makeMinesGeneration,makeMinesEngine].map(factory=>factory.toString()).join('\n');
}

if(typeof module!=='undefined') module.exports=makeMinesEngine({
  board:require('./engine-board'),constraints:require('./engine-constraints'),inference:require('./engine-inference'),generation:require('./engine-generation')
});
