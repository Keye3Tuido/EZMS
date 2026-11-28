// 选区表达式的词条和棋盘预览数据。
function makeSelectionView({$,element,proofPreview}) {
  const selectionTargets=new WeakMap();
  const selectionReadout=$('selectionReadout');

  function tokenAt(target) {
    const token=target?.closest?.('.selection-token');
    return selectionReadout.contains(token)?token:undefined;
  }

  function render(terms) {
    const prefix=(coefficient,index)=>
      `${index?(coefficient<0?' − ':' + '):(coefficient<0?'−':'')}${Math.abs(coefficient)>1?`${Math.abs(coefficient)}·`:''}`;
    const items=terms.flatMap(({coefficient,cells,clue,label},index)=>{
      const isClue=clue!==undefined;
      const kind=coefficient<0?'selection-token negative':'selection-token';
      const node=element('span',isClue?`${kind} clue-token`:kind,label);
      node.tabIndex=0;
      if(isClue) node.title=`${label} 的线索邻域`;
      selectionTargets.set(node,{
        clues:isClue?[clue]:undefined,
        preview:proofPreview([[],[],[],cells],false,new Map(cells.map(cell=>[cell,coefficient])))
      });
      return [prefix(coefficient,index),node];
    });
    $('selectionTerms').replaceChildren(...items);
  }

  return {tokenAt,render,preview:target=>selectionTargets.get(target)};
}
