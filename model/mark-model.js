// 红蓝标记历史、手动确认批次及草稿标记校验。
function makeMarkHistory() {
  const layers={red:new Map(),blue:new Map(),archivedBlue:new Map()}, past=[], future=[];
  const same=(a,b)=>a?.symbol===b?.symbol && a?.level===b?.level;
  function record(change) {
    if(Array.isArray(change) && !change.length) return false;
    past.push(change); future.length=0; return true;
  }
  function write(change,undo=false) {
    if(!Array.isArray(change)) {
      change.apply(undo);
      return 'confirmation';
    }
    for(const [color,cell,before,after] of change) {
      const value=undo?before:after;
      if(value) layers[color].set(cell,value); else layers[color].delete(cell);
    }
    return true;
  }
  function edit(color,entries) {
    const change=[];
    for(const [cell,after] of entries) {
      const before=layers[color].get(cell);
      if(!same(before,after)) change.push([color,cell,before,after]);
    }
    write(change); return record(change);
  }
  return {
    layers,edit,
    recordConfirmation(apply) {
      apply(false);
      record({apply});
    },
    discardConfirmations() {
      for(const stack of [past,future]) for(let i=stack.length-1;i>=0;i--) {
        if(!Array.isArray(stack[i])) stack.splice(i,1);
      }
    },
    discardRedo() {future.length=0;},
    stroke(color,start,mark) {
      const after=same(layers[color].get(start),mark)?undefined:mark;
      const seen=new Set(), change=[];
      let finished=false;
      return {
        visit(cell) {
          if(finished || seen.has(cell)) return false;
          seen.add(cell);
          const before=layers[color].get(cell);
          if(same(before,after)) return false;
          const entry=[color,cell,before,after];
          change.push(entry);write([entry]);return true;
        },
        finish() {if(!finished) {finished=true;return record(change);}}
      };
    },
    discardRed(cells) {
      for(const cell of cells) layers.red.delete(cell);
    },
    discardCells(cells) {
      const discarded=new Set(cells);
      for(const layer of Object.values(layers)) for(const cell of discarded) layer.delete(cell);
      // Opening a cell must not bring its marks back through undo or redo.
      for(const stack of [past,future]) for(let i=stack.length-1;i>=0;i--) {
        if(!Array.isArray(stack[i])) continue;
        const change=stack[i].filter(([,cell])=>!discarded.has(cell));
        if(change.length) stack[i]=change; else stack.splice(i,1);
      }
    },
    clear(color) {return edit(color,[...layers[color].keys()].map(i=>[i]));},
    clearBlue() {
      const color=layers.blue.size?'blue':'archivedBlue';
      return edit(color,[...layers[color].keys()].map(i=>[i]));
    },
    archiveBlue(covered=()=>true) {
      const change=[];
      const initialize=![...layers.archivedBlue.keys()].some(covered);
      let archived=false;
      for(const [cell,mark] of layers.blue) {
        change.push(['blue',cell,mark,undefined]);
        if(!covered(cell)) continue;
        const symbol=['x','o','v','ʌ'].includes(mark.symbol)?'o':['s','/','e','//'].includes(mark.symbol)?'/':null;
        if(!symbol) continue;
        const before=layers.archivedBlue.get(cell);
        if(!initialize && !before) continue;
        if(before?.symbol!==symbol) {
          change.push(['archivedBlue',cell,before,before?undefined:{symbol,level:0}]);
          archived=true;
        }
      }
      write(change);
      return record(change)?(archived?'archived':'cleared'):false;
    },
    clearDeductions(level) {
      const advanced=[...layers.blue].filter(([,m])=>m.level>1);
      const rank=level??advanced.reduce((n,[,m])=>Math.max(n,m.level),0);
      return edit('blue',advanced.filter(([,m])=>m.level===rank && ['ʌ','//'].includes(m.symbol)).map(([i])=>[i]));
    },
    get canUndo() {return !!past.length;}, get canRedo() {return !!future.length;},
    undo() {
      if(!past.length) return;
      const change=past.pop();
      future.push(change);
      return write(change,true);
    },
    redo() {
      if(!future.length) return;
      const change=future.pop();
      past.push(change);
      return write(change);
    }
  };
}

function makeManualBatch(state,flags,selectTargets,history) {
  const marked=new Map();
  let targets;
  function refreshTargets() {targets=selectTargets(state,flags);}
  function done() {return targets.size>0 && marked.size===targets.size;}
  function record(entries,from) {
    const wrong=entries.find(([i,kind])=>state[i]!==kind);
    if(wrong) return {wrong:wrong[0],state:state[wrong[0]]};
    const additions=new Map(entries.filter(([i])=>targets.has(i) && !marked.has(i)));
    const movesFlag=from!==undefined && flags.has(from);
    if(additions.size || movesFlag) {
      const apply=undo=>{
        if(movesFlag) {
          if(undo) flags.add(from); else flags.delete(from);
          refreshTargets();
        }
        for(const [i,kind] of additions) {
          if(undo) marked.delete(i); else marked.set(i,kind);
        }
      };
      if(history) history.recordConfirmation(apply); else apply(false);
    }
    return {done:done(),total:targets.size};
  }
  refreshTargets();
  return {
    marked,refreshTargets,
    get total() {return targets.size;},
    get done() {return done();},
    record(cells,kind,from) {return record(cells.map(i=>[i,kind]),from);},
    recordStep(safe,mines) {
      return record([...safe.map(i=>[i,'safe']),...mines.map(i=>[i,'mine'])]);
    },
    cells(kind) {return [...marked].filter(([,value])=>value===kind).map(([i])=>i).sort((a,b)=>a-b);}
  };
}

// A staged step has exactly two UI phases: collect every red mark, then commit the complete batch.
function manualStepAction(batch) {
  return batch?.done ? 'commit' : 'stage';
}

function checkPositionMarks(state,flags,red) {
  const issues=[];
  const check=(cell,expected,mark)=>{
    const actual=state[cell];
    if(actual===expected || expected==='safe' && actual==='open') return;
    issues.push({cell,mark,conflict:actual==='open' || actual==='safe' || actual==='mine'});
  };
  for(const cell of flags) check(cell,'mine','flag');
  for(const [cell,mark] of red) check(cell,mark.symbol==='x'?'mine':'safe',mark.symbol==='x'?'cross':'slash');
  return issues;
}

function restoreManualMarks(state,flags,selectTargets,notes) {
  const batch=makeManualBatch(state,flags,selectTargets,notes);
  for(const [cell,mark] of notes.layers.red) batch.record([cell],mark.symbol==='x'?'mine':'safe');
  notes.discardRed(notes.layers.red.keys());
  return batch.marked.size?batch:null;
}

if(typeof module!=='undefined') module.exports={makeMarkHistory,makeManualBatch,manualStepAction,checkPositionMarks,restoreManualMarks};
