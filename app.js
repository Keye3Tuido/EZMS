(() => {
  'use strict';
  const engine = makeMinesEngine();
  const format = makeProofFormat();
  const regionSelection=makeRegionSelection(engine.adj,makeSelectionExpression());
  const seeds = makePositionSeeds(engine.adj);
  const $ = id => document.getElementById(id);
  const selectionReadout=$('selectionReadout');
  const viewport = $('gameViewport');
  const fullscreen = makeGameFullscreen(viewport, $('fullscreenToggle'), $('fullscreenStatus'));
  const feedback = makeGameFeedback($('soundToggle'),$('motionToggle'));
  const fields = ['width', 'height', 'minAverage', 'minMultiPercent', 'minPeakClues'];
  let game, auto = false, run = 0;
  let editing=false, editTool='mine';
  let digit=1, draftMinesValid=true;
  let verificationWorker, verificationTimer;
  let draftMarkJob, draftMarkJudgment;
  const proofTargets=new WeakMap(), proofRows=new WeakMap();
  const {chip,steps,regionChips,proofPreview}=makeProofRenderer({
    element,format,equivalentGroups:engine.equivalentGroups,proofTargets,proofRows,
    scrollToTotal:()=>$('totalMines')?.scrollIntoView({block:'nearest'}),
    focusBoardCell:target=>focusBoardCell(game,boardView.buttons,target)
  });
  const reasonView=makeReasonView({$,element,format,chip,steps,regionChips});
  let hoveredProof, focusedProof, pinnedProof;
  let activeProofRow, shownProofClues, proofHighlight=null;
  let activeAreaPreview = null;
  let selectionHistory=regionSelection.history();
  const selectionView=makeSelectionView({$,element,proofPreview});
  let hoveredSelection, focusedSelection, selectionReadoutKey;
  let selectionCountWorker, selectionCountKey, selectionCountTimer;
  let selectionExpressionWorker, selectionExpressionJob;
  const selectionCountCache=new Map();
  let activeSelectionClues=[];
  let selectionMode='';

  function dismissSearchResult() {
    if(generation.searching) return;
    if(generation.discardCandidate()) {
      $('useCandidate').disabled=true;
    }
    if(!$('searchCard').hidden) saySearch('');
  }
  const icon = id => `<svg class="icon" aria-hidden="true"><use href="#${id}"/></svg>`;
  const controlsView=makeControlsView({$,fields,icon});
  const {updateOperationCard,say,saySearch}=controlsView;
  const gameModel=makeGameModel({engine,seeds,makeMarkHistory,makeSelectionHistory:regionSelection.history});
  const editorModel=makeEditorModel({engine,seeds,gameModel});
  const {positionGame,copyPosition,removeFlag}=gameModel;
  const boardOverlays=makeBoardOverlays({$,contour:regionSelection.contour,inkTrails,inkPath});
  const boardView=makeBoardView({$,format,icon,element,feedback,overlays:boardOverlays,inkGlyph,selectBoardRectangle});
  const coord = i => format.coordinate(i,game.board.w);

  function batchControls() {
    const batch=game?.manual, complete=!!batch?.done, live=ready();
    const locked = auto || gameRequests.busy;
    const commit=$('commitMarks');
    const canCommit=live && complete;
    if(!canCommit && document.activeElement===commit) boardView.buttons[game?.focus]?.focus({preventScroll:true});
    commit.hidden=!canCommit;
    commit.disabled=locked || !canCommit;
    const progress=$('roundProgress');
    const showProgress=live && !!batch?.marked.size;
    $('operationRound').hidden=!showProgress && !canCommit;
    progress.max=batch?.total || 1;
    progress.value=batch?.marked.size || 0;
    progress.toggleAttribute('data-complete',complete);
    const text=$('roundText');
    const message=!showProgress?'':`本轮已确认 ${batch.marked.size} / ${batch.total} 格${complete?'，可以开格并插旗。':''}`;
    if(text.textContent!==message) text.textContent=message;
    text.toggleAttribute('data-complete',complete);
    updateOperationCard();
    // 标齐后，求解一步直接提交这一批；未标齐时才执行下一条推导。
    $('apply').disabled = locked || !live;
    input.history();
  }

  function updateSolveControl(live) {
    const button=$('solve');
    const label=button.querySelector('span');
    const text=auto?'停止求解':'自动求解';
    button.disabled=!auto && (generation.searching || !live || gameRequests.busy);
    if(label.textContent!==text) {
      button.querySelector('use').setAttribute('href',auto?'#stopIcon':'#play');
      label.textContent=text;
    }
  }

  function controls() {
    controlsView.controls({game,editing,auto,busy:gameRequests.busy,searching:generation.searching,
      candidate:generation.candidate,hasParkedGame:!!editorModel.parkedGame,draftMinesValid,proofPending:!!proofRequest},
    {batchControls,updateSelectionAxes,selectionHistoryControls,updateSolveControl});
  }

  function showDifficultyDefaults() {
    for (const [id,value] of Object.entries(engine.difficultyDefaults())) {
      $(id).placeholder=`默认 ${value}${id==='minMultiPercent'?'%':''}`;
    }
  }

  function generationProgress({tried,passed,closest,target},report) {
    const progress=`已搜索 ${tried} 轮 · ${passed} 局通过技巧验证`;
    if(!closest) return {text:progress};
    const {average,multiPercent,peak}=closest;
    const metrics=[
      ['平均线索',average,target.average,'',average<target.average],
      ['多线索步骤占比',multiPercent,target.multiPercent,'%',report.advancedDensity<target.multiPercent/100],
      ['峰值线索',peak,target.peak,'',peak<target.peak]
    ];
    const summary=metrics.map(([name,actual,goal,suffix,miss])=>{
      const value=`${name} ${Number(actual.toFixed(2))}${suffix}`;
      return miss?`${value}（需 ≥ ${goal}${suffix}）`:value;
    }).join('、');
    const missing=metrics.filter(([, , , ,miss])=>miss).map(([name])=>name);
    return {text:`${progress}。最接近候选：${summary}。`,shortfall:missing.length?`未达标：${missing.join('、')}`:''};
  }

  function readDimensions(width,height) {
    const integer = (id,name) => {
      const v = $(id).valueAsNumber;
      if (!Number.isSafeInteger(v) || v < 1) { $(id).focus(); throw Error(`${name}须为正整数。`); }
      return v;
    };
    const w=integer(width,'宽度'), h=integer(height,'高度');
    if(!seeds.dimensionsOk(w,h)) throw Error('棋盘面积超出浏览器可表示的范围。');
    return {w,h};
  }

  function readSettings() {
    const optional = (id, condition, error) => {
      const input = $(id), v = input.valueAsNumber;
      if (input.value === '' && !input.validity.badInput) return undefined;
      if (Number.isFinite(v) && condition(v)) return v;
      setDifficultyOpen(true);
      input.focus(); throw Error(error);
    };
    const {w,h}=readDimensions('width','height');
    const minAverage = optional('minAverage', v=>v>=1, '平均最少线索下限须至少为 1。');
    const minMultiPercent = optional('minMultiPercent', v=>v>=0 && v<=100, '多线索步骤占比须为 0–100%。');
    const minPeakClues = optional('minPeakClues', v=>Number.isSafeInteger(v) && v>=1, '峰值线索数下限须为正整数。');
    return {w,h,minAverage,minMultiPercent,minPeakClues};
  }

  function stopAuto() {
    const wasSolving=auto;
    auto=false;
    run++;
    cancelPlayRequest();
    if(wasSolving && proofVisible && proofPanel.querySelector('.proof-pending'))
      proofPanel.replaceChildren(element('p','proof-pending','自动求解已停止。'));
    controls();
  }
  function background(code) {
    const url = URL.createObjectURL(new Blob([`${minesEngineWorkerSource()}\n${code}`],{type:'text/javascript'}));
    try { return new Worker(url); }
    finally { URL.revokeObjectURL(url); }
  }

  const gameRequests=makeGameRequests({openWorker:background,onBusyChange:controls});
  const {ask,cancel:cancelPlayRequest}=gameRequests;

  const generation=makeGenerationController({
    rank:engine.generationRanking,scheduleFor:engine.generationSchedule,
    logicalCores:()=>navigator.hardwareConcurrency,
    randomSeed:()=>crypto.getRandomValues(new Uint32Array(1))[0],openWorker:background,
    onChange:controls,
    onStart:()=>saySearch('正在构造开局'),
    onCandidate:()=>{$('useCandidate').disabled=false;},
    onProgress(progress,report) {
      const {text,shortfall}=generationProgress(progress,report);
      saySearch(text,'',shortfall);
    },
    onFailure(kind,detail,candidate) {
      const message=kind==='startup' ? '浏览器无法启动生成任务。请用 Edge 或 Chrome 打开本页。' :
        kind==='search' ? `本次生成中止：${detail}` : `生成任务无法运行。${game ? '当前棋局已保留。' : ''}`;
      if(candidate) {
        const {text,shortfall}=generationProgress(candidate.progress,candidate.report);
        saySearch(`${message} ${text}`,'error',shortfall);
      } else saySearch(message,'error');
    },
    onResult:(result,p,tried)=>mountGenerated(result,p,`三项难度达标 · 技巧通关验证通过 · 搜索 ${tried} 轮`)
  });

  function generate(e) {
    e?.preventDefault();
    if (generation.searching || gameRequests.busy && !auto) return;
    let p;
    try { p = readSettings(); } catch (error) { saySearch(error.message, 'error'); return; }
    stopAuto();
    say('');
    generation.start(p);
  }

  function mountGenerated({board,report},p,message,shortfall) {
    if(!report.openingMinimum) {saySearch('没有通过首步最少线索验证，未发放该局。','error'); return;}
    const position=positionGame({board},p);
    position.openingVerification=verificationSummary(report);
    mount(position);
    saySearch(message,'success',shortfall);
  }

  function mount(position) {
    stopAuto();
    dismissSearchResult();
    game=position;
    selectionHistory=game?.selection??regionSelection.history();
    setSelectionMode();
    hoveredSelection=focusedSelection=undefined;
    selectionReadoutKey=undefined;
    updateSelectionReadout();
    input.reset(editing); showReason(false);
    clearHint();
    scheduleVerification();
    boardView.mount(game);
    if(!game) {controls();return;}
    render(); controls();
    feedback.visual('board',$('board'));
  }

  function verificationSummary({status,steps,averageClues,clues,advancedDensity}) {
    return {status,...(status==='passed' && steps>0 && Number.isFinite(averageClues)?
      {averageClues,peakClues:clues,multiClueRatio:advancedDensity}:{})};
  }

  function showVerification() {reasonView.showVerification(game,editing,shownProofClues);}

  function time() {boardView.time(game);}

  new ResizeObserver(()=>{
    boardOverlays.paintInk(game,editing);
    boardOverlays.paintProofAreas(game,activeAreaPreview);
  }).observe($('board'));

  function render() {
    batchControls();
    boardView.render(game,editing,proofHighlight,activeSelectionClues);
    if(selectionHistory.weights.size || selectionHistory.clueWeights.size) {
      updateSelectionReadout();
      updateProofPreview();
    }
  }

  function updateProofPreview() {
    const target=hoveredProof??focusedProof??pinnedProof;
    const row=target?.closest('.proof-line');
    if(row!==activeProofRow) {
      activeProofRow?.classList.remove('proof-active');
      row?.classList.add('proof-active');
      activeProofRow=row;
    }
    const proof=proofTargets.get(target)??proofRows.get(target);
    const selection=selectionView.preview(hoveredSelection??focusedSelection);
    const clues=proof?[]:selection?.clues??[];
    if(clues!==activeSelectionClues) {
      const hintClues=new Set(proofHighlight?.sources);
      for(const cell of activeSelectionClues) {
        if(!hintClues.has(cell)) boardView.buttons[cell]?.classList.remove('clue');
      }
      for(const cell of clues) boardView.buttons[cell]?.classList.add('clue');
      activeSelectionClues=clues;
    }
    const next=proof??selection?.preview??(selectionHistory.weights.size?selectionPreview():null);
    if(next===activeAreaPreview) return;
    for(const v of activeAreaPreview?.cells??[]) boardView.buttons[v]?.classList.remove('proof-preview');
    activeAreaPreview=next;
    for(const v of next?.cells??[]) boardView.buttons[v]?.classList.add('proof-preview');
    $('totalMines')?.classList.toggle('proof-hover',!!next?.total);
    boardOverlays.paintProofAreas(game,activeAreaPreview);
  }

  function clearProofHover() {
    pinnedProof?.setAttribute('aria-pressed','false');
    hoveredProof=focusedProof=pinnedProof=undefined;
    updateProofPreview();
  }

  function selectionPreview() {
    const weights=selectionUnknownWeights();
    const {positive,negative}=regionSelection.bounds(weights,new Map());
    return proofPreview([[],[],[],[],positive,negative],false,weights);
  }

  function selectionKnown() {
    return regionSelection.knownCells({visible:game.visible,flags:game.flags,proven:game.proven,
      manual:game.manual?.marked??[],red:game.notes.layers.red});
  }

  function selectionUnknownWeights(known=selectionKnown()) {
    return new Map([...selectionHistory.weights].filter(([cell])=>!known.has(cell)));
  }

  function updateSelectionHover(event,target) {
    if(event.pointerType!=='mouse') return;
    hoveredSelection=selectionView.tokenAt(target);
    updateProofPreview();
  }

  function cancelSelectionCount() {
    if(selectionCountTimer===undefined) return;
    clearTimeout(selectionCountTimer);
    selectionCountTimer=undefined;
    selectionCountWorker?.terminate();
    selectionCountWorker=undefined;
  }

  function updateSelectionCount(known,weights) {
    const {w,h,mines}=game.board;
    const p={w,h,mines}, visible=game.visible;
    const key=JSON.stringify([p,visible,[...known],[...weights]]);
    if(key===selectionCountKey) return;
    selectionCountKey=key;
    cancelSelectionCount();
    const output=$('selectionBounds');
    if(selectionCountCache.has(key)) {
      output.textContent=selectionCountCache.get(key);
      return;
    }
    output.textContent='';
    let task;
    try {
      task=selectionCountWorker??=background(`const engine=makeMinesEngine();
        onmessage=({data:{p,visible,known,weights}})=>postMessage(engine.selectionTotals(p,visible,known,weights));`);
    } catch {
      output.textContent='无法统计';
      return;
    }
    selectionCountTimer=setTimeout(()=>{output.textContent='正在统计…';},100);
    function show(text) {
      clearTimeout(selectionCountTimer);
      selectionCountTimer=undefined;
      output.textContent=text;
    }
    task.onmessage=({data:{status,values}})=>{
      if(selectionCountWorker!==task) return;
      if(status==='invalid') {show('线索与标记矛盾');return;}
      const text=values.join(', ');
      if(text.length<2048) {
        if(selectionCountCache.size>=24) selectionCountCache.delete(selectionCountCache.keys().next().value);
        selectionCountCache.set(key,text);
      }
      show(text);
    };
    task.onerror=()=>{
      if(selectionCountWorker!==task) return;
      task.terminate();
      selectionCountWorker=undefined;
      show('无法统计');
    };
    task.postMessage({p,visible,known,weights});
  }

  function cancelSelectionExpression() {
    if(!selectionExpressionJob) return;
    const {timer,worker}=selectionExpressionJob;
    clearTimeout(timer);
    if(worker) {
      worker.terminate();
      selectionExpressionWorker=undefined;
    }
    selectionExpressionJob=undefined;
  }

  function updateSelectionExpression(data) {
    const job=selectionExpressionJob={};
    // 合并短时间内连续触发的操作，只整理最新选区。
    job.timer=setTimeout(()=>{
      function fail() {
        if(selectionExpressionJob!==job) return;
        cancelSelectionExpression();
        $('selectionTerms').textContent='无法整理选区';
      }
      try {
        const worker=job.worker=selectionExpressionWorker??=background(`
          ${makeSelectionExpression.toString()}
          ${makeProofFormat.toString()}
          const engine=makeMinesEngine();
          const selection=makeSelectionExpression();
          const format=makeProofFormat();
          onmessage=({data:{w,h,visible,known,weights,clueWeights,rectangleWeights}})=>{
            const regionVisible=visible.map((value,cell)=>known.has(cell)?0:value);
            const partition=cells=>format.regions(cells,w,h,regionVisible);
            const {terms}=selection.readout(weights,clueWeights,visible,engine.adj(w,h),known,
              rest=>selection.regionTerms(rest,w,known,partition),w,rectangleWeights);
            postMessage(terms.map(term=>({...term,label:term.rectangle?format.rectangleLabel(term.rectangle,w)
              :term.clue!==undefined?format.coordinate(term.clue,w):format.label(term.cells,w,h,regionVisible,{namedRegions:false})})));
          };`);
        worker.onmessage=({data:terms})=>{
          if(selectionExpressionJob!==job) return;
          selectionExpressionJob=undefined;
          selectionView.render(terms);
        };
        worker.onerror=worker.onmessageerror=fail;
        worker.postMessage(data);
      } catch { fail(); }
    },0);
  }

  function updateSelectionReadout() {
    const known=game && selectionHistory.weights.size?selectionKnown():null;
    const {w,h,mines,ns}=game?.board??{};
    const visible=game?.visible, {clueWeights,rectangleWeights}=selectionHistory;
    const key=known?JSON.stringify([w,h,mines,visible,[...known],
      [...selectionHistory.weights],[...clueWeights],[...rectangleWeights]]):null;
    if(key===selectionReadoutKey) return;
    selectionReadoutKey=key;
    const weights=known?selectionUnknownWeights(known):null;
    selectionReadout.hidden=!weights?.size;
    hoveredSelection=focusedSelection=undefined;
    cancelSelectionExpression();
    $('selectionTerms').replaceChildren();
    if(!weights?.size) {
      selectionCountKey=undefined;
      cancelSelectionCount();
      return;
    }
    // 进入游戏的局面已有可行布雷，同时满足公开线索和已确认标记。
    const clue=!editing?regionSelection.singleClue(weights,clueWeights,visible,ns,known):undefined;
    if(clue) {
      selectionCountKey=undefined;
      cancelSelectionCount();
      $('selectionBounds').textContent=String(clue.total);
      if(!rectangleWeights.size) {
        selectionView.render([{...clue,label:format.coordinate(clue.clue,w)}]);
        return;
      }
    } else updateSelectionCount(known,weights);
    updateSelectionExpression({w,h,visible,known,weights,clueWeights,rectangleWeights});
  }

  function setSelectionMode(mode='') {
    selectionMode=mode;
    $('selectionAdd').ariaPressed=String(mode==='add');
    $('selectionSubtract').ariaPressed=String(mode==='subtract');
    updateSelectionAxes();
  }

  function updateSelectionAxes() {
    const active=!!selectionMode && !editing && game?.state==='playing';
    const disabled=!active || $('selectionMenu').disabled;
    boardView.updateAxes(active,disabled);
  }

  function selectionHistoryControls() {
    const locked=$('selectionMenu').disabled;
    $('selectionUndo').disabled=locked || !selectionHistory.canUndo;
    $('selectionRedo').disabled=locked || !selectionHistory.canRedo;
  }

  function refreshSelection() {
    selectionHistoryControls();
    updateSelectionReadout();
    updateProofPreview();
  }

  function clearSelection(remember=false) {
    if(remember) selectionHistory.clear();
    else selectionHistory.reset();
    setSelectionMode();
    refreshSelection();
  }

  function applySelection(cells,{clue,focus,rectangle}={}) {
    const unknown=regionSelection.unknown(cells,selectionKnown());
    const sign=selectionMode==='add'?1:-1;
    if(!selectionHistory.select(unknown,clue,sign,rectangle)) return;
    if(focus!==undefined) {
      boardView.buttons[game.focus].tabIndex=-1;
      game.focus=focus;
      boardView.buttons[focus].tabIndex=0;
    }
    refreshSelection();
    feedback.sound('click');
  }

  function selectBoardCell(i) {
    if(!selectionMode || !game || editing || game.state!=='playing') return false;
    if($('selectionMenu').disabled) return true;
    const clue=game.visible[i]>=0?i:undefined;
    applySelection(clue===undefined?[i]:game.board.ns[clue],{clue,focus:i});
    return true;
  }

  function selectBoardRectangle(left,top,right,bottom) {
    if(!selectionMode || !ready() || $('selectionMenu').disabled) return;
    const {w}=game.board;
    const cells=[];
    for(let y=top;y<bottom;y++) {
      for(let x=left;x<right;x++) cells.push(y*w+x);
    }
    dismissSearchResult();
    applySelection(cells,{rectangle:[left,top,right,bottom]});
  }

  const proofPanel=$('proof');
  const reasonSlot=proofPanel.closest('.reason-slot');
  const reasonLayout=reasonSlot.parentElement;
  const reasonContent=reasonSlot.querySelector('.reason-content');
  const proofPane=$('proofPane'), reasonStatus=$('reasonStatus');
  const openReasonPanel=$('openReasonPanel');
  const header=viewport.querySelector('header');
  const compactReason=matchMedia('(max-width: 760px), (pointer: coarse) and (max-width: 1000px)');
  let proofVisible=false, reasonCollapsed=false, proofReturn, proofMode, proofRequest;
  const {layoutRadial,positionProofWindow,syncProofLayout,observe:observeToolLayout}=makeGameToolLayout({
    $,radialLayout:makeRadialLayout(),proofLayout:proofWindowLayout,
    viewport,header,reasonSlot,proofPane,reasonContent,reasonStatus,openReasonPanel,
    compactReason,isProofVisible:()=>proofVisible,isReasonCollapsed:()=>reasonCollapsed,isEditing:()=>editing,
    collapseReasonTools:()=>showReason(false)
  });
  syncProofLayout();
  let touchProof=false;
  function proofAt(target,includeRow) {
    if(!proofPanel.contains(target)) return;
    const token=target?.closest?.('.proof-cell');
    if(proofTargets.has(token)) return token;
    if(!includeRow) return;
    const row=target?.closest?.('.proof-line');
    if(proofRows.has(row)) return row;
  }
  function hoverProof(e,target) {
    if(e.pointerType!=='mouse') return;
    hoveredProof=proofAt(target,true);
    updateProofPreview();
  }
  proofPanel.addEventListener('pointerover',e=>hoverProof(e,e.target));
  proofPanel.addEventListener('pointerout',e=>hoverProof(e,e.relatedTarget));
  proofPanel.addEventListener('focusin',e=>{
    focusedProof=e.target.matches(':focus-visible')?proofAt(e.target,false):undefined;
    updateProofPreview();
  });
  proofPanel.addEventListener('focusout',()=>{focusedProof=undefined;updateProofPreview();});
  document.addEventListener('pointerdown',e=>{
    touchProof=e.pointerType==='touch' || e.pointerType==='pen';
  });
  document.addEventListener('click',e=>{
    if(e.detail && skipDragClick && board.contains(e.target)) {
      skipDragClick=false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if(pinnedProof && !proofAt(e.target,true)) clearProofHover();
  },true);
  proofPanel.addEventListener('click',e=>{
    const direct=e.detail!==0 && touchProof;
    const target=proofAt(e.target,direct);
    if(!target || (!direct && !target.classList.contains('cancellation-chip'))) return;
    if(direct) {
      // A tap previews in place; it must not move focus to the board.
      e.preventDefault();e.stopPropagation();
      if(!e.target.closest('button')) feedback.sound('click');
      hoveredProof=focusedProof=undefined;
    }
    if(pinnedProof?.classList.contains('cancellation-chip')) pinnedProof.setAttribute('aria-pressed','false');
    pinnedProof=pinnedProof===target?undefined:target;
    if(pinnedProof?.classList.contains('cancellation-chip')) pinnedProof.setAttribute('aria-pressed','true');
    updateProofPreview();
  },true);

  function cancelProofRequest() {
    if(!proofRequest) return;
    proofRequest=undefined;
    cancelPlayRequest();
    controls();
  }

  function clearHint(keepProof=false) {
    if(!keepProof) cancelProofRequest();
    if(game) {
      proofHighlight = null;
      if(shownProofClues!==undefined) {
        shownProofClues=undefined;
        showVerification();
      }
    }
    clearProofHover();
    setProofVisible(keepProof);
    if(keepProof) showPendingProof();
  }

  function showPendingProof() {
    proofPanel.replaceChildren(element('p','proof-pending','正在推理…'));
  }
  function ready() { return !editing && game?.state === 'playing' && !generation.searching; }

  async function judge(g) {
    if(g.judgment?.status==='complete') return g.judgment;
    const view=g.visible;
    const result=await ask('classify',{p:g.p,visible:view});
    if(g!==game || g.visible!==view || !ready() || !result || result.status==='error') return null;
    g.judgment=result;
    if(g.answers) render();
    return result;
  }

  async function toggleAnswers() {
    if(!ready() || gameRequests.busy || auto) return;
    dismissSearchResult();
    const g=game;
    g.answers=!g.answers;
    if(g.answers) clearSelection();
    controls(); render();
    if(!g.answers) return;
    const result=await judge(g);
    if(g===game && g.answers && result?.status!=='complete') say('只显示已证实的答案；其余格尚未判定。','error');
  }

  function finish() {
    gameModel.markWon(game,Date.now());
    stopAuto();
    say('通关 · 所有安全格已打开','success');
    feedback.sound('won');
  }

  async function recordManual(g,cells,kind,from) {
    const task=run;
    if(g.judgment?.status!=='complete') say('正在核对当前局面…');
    const judgment=await judge(g);
    if(task!==run || g!==game || !ready()) return;
    if(judgment?.status!=='complete') {
      feedback.sound('rejected');
      say(judgment?.status==='invalid'?'当前线索互相矛盾。':'未能核对当前局面。','error'); return;
    }
    const batch=g.manual??makeManualBatch(judgment.state,g.flags,engine.confirmationTargets,g.notes);
    const added=cells.filter(i=>!batch.marked.has(i));
    const wasDone=batch.done;
    const result=batch.record(cells,kind,from);
    if(result.wrong!==undefined) {
      feedback.tile('rejected',boardView.buttons[result.wrong]);
      feedback.sound('rejected');
      const cell=coord(result.wrong);
      say(kind==='mine'?`无法插旗：${cell} 可能安全。`:`无法开格：${cell} 可能有雷。`,'rejected'); return;
    }
    for(const i of cells) feedback.clearRejection(boardView.buttons[i]);
    g.manual=batch;
    const confirmed=added.filter(i=>batch.marked.has(i));
    if(!confirmed.length) feedback.sound(from===undefined?'click':'erase');
    showMarks(g,confirmed,wasDone);
  }

  function showMarks(g,added,wasDone) {
    g.started??=Date.now();
    say('');
    g.current=g.verification=undefined; scheduleVerification();
    render();
    for(const i of added) feedback.tile('ink',boardView.buttons[i]);
    if(added.length) feedback.sound(!wasDone && g.manual.done?'ready':'ink');
  }

  async function commitBatch(g) {
    if(g!==game || !g.manual?.done || !ready() || gameRequests.busy) return false;
    dismissSearchResult();
    const task=run;
    const refreshProof=!auto&&proofVisible;
    const {safe,mines,proven,flags}=gameModel.prepareCommit(g);
    if(safe.length) {
      say('正在开格并插旗…');
      const result=await ask('advance',{board:g.board,p:g.p,visible:g.visible,cells:safe,
        proven:new Set([...proven].filter(v=>flags.has(v))),flags,allowUnsolved:true,exact:true});
      if(task!==run || g!==game || !ready()) return false;
      if(!result?.board || !result.visible || !(result.opened>=safe.length)) {
        feedback.sound('rejected');
        say('未能更新棋盘，红色标记已保留。','error'); return false;
      }
      gameModel.applyAdvance(g,result);
      for(const i of result.cells??safe) flags.delete(i);
      discardOpenedMarks(g,result.cells??safe);
    }
    feedback.handoff(boardOverlays.inkDrawing);
    g.proven=proven;
    g.flags=flags;
    discardOpenedMarks(g,safe);
    gameModel.resetConfirmation(g);
    g.current=g.verification=undefined; scheduleVerification();
    const won=g.opened===g.visible.length-g.board.mines;
    clearHint(!won && proofVisible);
    if(won) finish();
    else {
      say(`本轮已打开 ${safe.length} 格，插旗 ${mines.length} 格。`,'success');
      feedback.sound(safe.length?'commit':'flag');
    }
    render();
    if(safe.length && g.answers && ready()) {
      const result=await judge(g);
      if(g===game && run===task && g.answers && result?.status!=='complete') say('只显示已证实的答案；其余格尚未判定。','error');
    }
    if(refreshProof && !won && g===game && run===task && proofVisible) await previewNextProof(proofMode);
    return true;
  }

  function play(i, marking) {
    if (!ready() || auto || gameRequests.busy) return;
    const g = game;
    g.focus = i;
    say('');
    clearHint();
    if (g.visible[i] >= 0) {
      const action = engine.numberAction(g.board.ns,g.visible,g.flags,i,marking,g.manual?.marked);
      if(action) void recordManual(g,action.cells,action.kind==='flag'?'mine':'safe');
      else feedback.sound('click');
    } else if(marking && g.flags.has(i)) {
      removeFlag(g,i);
      g.current=undefined; scheduleVerification();
      say(`已撤销 ${coord(i)} 的旗子。`);
      feedback.sound('erase');
    } else void recordManual(g,[i],marking?'mine':'safe');
    render();
  }

  function next() {
    const {p,visible,proven,flags} = game;
    return ask('hint',{p,visible,proven:[...proven].filter(v=>flags.has(v)),flags,opening:game.opened===game.original.opening.length,
      confirmed:game.manual ? [...game.manual.marked] : undefined});
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function display(a, weak) {
    if(!proofVisible) return;
    proofMode=weak?'focus':'hint';
    updateProofButtons();
    const selectedClues=a.move?.sources.length;
    if(shownProofClues!==selectedClues) {
      shownProofClues=selectedClues;
      showVerification();
    }
    clearProofHover();
    proofHighlight=reasonView.display(game,a,weak);
    render();
  }

  async function stageStep(a) {
    const g=game, task=run;
    if(auto && proofVisible) display(a,proofMode==='focus');
    if(!a.move) return false;
    const judgment=await judge(g);
    if(task!==run || g!==game || !ready()) return false;
    if(judgment?.status!=='complete') {say('未能核对当前局面。','error');return false;}
    const {safe,mines}=a.move;
    if(safe.some(v=>judgment.state[v]!=='safe') || mines.some(v=>judgment.state[v]!=='mine')) {
      say('推导未通过核对，红色标记未改变。','error');return false;
    }
    g.manual??=makeManualBatch(judgment.state,g.flags,engine.confirmationTargets,g.notes);
    const added=[...safe,...mines].filter(i=>!g.manual.marked.has(i));
    const wasDone=g.manual.done;
    g.manual.recordStep(safe,mines);
    const confirmed=added.filter(i=>g.manual.marked.has(i));
    if(!confirmed.length) return false;
    showMarks(g,confirmed,wasDone);
    return true;
  }

  function pauseSolve() {
    stopAuto();
    say('已停止自动求解。');
  }

  async function solve() {
    if (auto) { pauseSolve(); return; }
    if (!ready() || gameRequests.busy) return;
    dismissSearchResult();
    auto = true;
    const task=++run, g=game;
    if(proofVisible) showPendingProof();
    controls();
    try {
      while (task === run && ready()) {
        if(g.manual?.done) {
          if(!await commitBatch(g)) break;
          continue;
        }
        const a = await next();
        if (task !== run || !ready() || !a || !await stageStep(a)) break;
        // Let the red marks paint before another proof or the automatic commit.
        await new Promise(resolve=>setTimeout(resolve,250));
      }
    } finally { if (task === run) stopAuto(); }
  }

  function toggleHint(mode) {
    if(!ready() || auto || gameRequests.busy && !proofRequest) return;
    if(proofVisible && proofMode===mode) {
      closeProof();
      return;
    }
    cancelProofRequest();
    void requestHint($(mode),mode);
  }

  async function previewNextProof(mode) {
    const task=run, ticket=proofRequest={};
    try {
      const a=await next();
      if(task===run && ready() && a && proofRequest===ticket) display(a,mode==='focus');
    } finally {
      if(proofRequest===ticket) {
        proofRequest=undefined;
        controls();
      }
    }
  }

  async function requestHint(trigger,mode) {
    if(!ready() || auto || gameRequests.busy) return;
    dismissSearchResult();
    clearSelection();
    if(mode) {
      if(!compactReason.matches && reasonCollapsed) setReasonCollapsed(false);
      proofMode=mode;
      proofReturn=trigger;
    }
    clearHint(!!mode || proofVisible);
    render();
    if(mode && compactReason.matches) {
      const split=viewport.classList.contains('mobile-proof-split');
      if(split) showReason(false);
      if(split || mode==='hint') $('closeProof').focus({preventScroll:true});
    }
    if(mode) return previewNextProof(mode);
    const g=game, task=run, a=await next();
    if(task!==run || g!==game || !ready() || !a) return;
    const staged=await stageStep(a);
    if(task!==run || g!==game || !ready() || !proofVisible) return;
    if(!staged) { display(a,proofMode==='focus'); return; }
    if(g.manual.done) { display({status:'confirmed'},proofMode==='focus'); return; }
    return previewNextProof(proofMode);
  }

  function showReason(open,focus=false) {
    if(open) input.close();
    setRadial('reason',open);
    if(focus) $('reasonMenu').focus({preventScroll:true});
  }

  function setRadial(name,open) {
    const flower=$(`${name}Flower`), launcher=$(`${name}Menu`);
    if(name==='selection') {
      if(open) {input.close();showReason(false);}
      else setSelectionMode();
    }
    if(name==='mark'&&open) {setSelectionMode();showReason(false);}
    if(name==='reason'&&open) {clearSelection();input.close();}
    if(open) for(const other of ['mark','selection','reason']) {
      if(other===name) continue;
      const otherFlower=$(`${other}Flower`),otherLauncher=$(`${other}Menu`);
      otherFlower.inert=true;otherFlower.classList.remove('expanded');
      otherLauncher.setAttribute('aria-expanded','false');otherLauncher.classList.remove('is-open');
    }
    if(open) layoutRadial(name);
    else if(flower.contains(document.activeElement)) launcher.focus({preventScroll:true});
    flower.inert=!open;
    flower.classList.toggle('expanded',open);
    launcher.setAttribute('aria-expanded',String(open));
    launcher.classList.toggle('is-open',open);
    if(name==='reason') positionProofWindow();
  }

  observeToolLayout();

  function updateProofButtons() {
    for(const [id,name] of [['focus','线索'],['hint','推导']]) {
      const button=$(id), shown=proofVisible && proofMode===id;
      button.setAttribute('aria-pressed',String(shown));
      const label=button.querySelector('span');
      const text=`${shown?'隐藏':'显示'}${name}`;
      if(label.textContent!==text) label.textContent=text;
    }
  }

  function setProofVisible(visible) {
    if(!visible && proofPane.contains(document.activeElement)) focusProofReturn();
    proofVisible=visible;
    if(!visible) proofMode=undefined;
    updateProofButtons();
    proofPane.classList.toggle('is-open',visible);
    reasonLayout.classList.toggle('show-proof',visible);
    syncProofLayout();
  }

  function setReasonCollapsed(collapsed, focus=false) {
    if(collapsed && !compactReason.matches) clearProofHover();
    reasonCollapsed=collapsed;
    reasonLayout.classList.toggle('reason-collapsed',collapsed);
    openReasonPanel.inert=!collapsed;
    openReasonPanel.setAttribute('aria-expanded',String(!collapsed));
    syncProofLayout();
    if(focus) {
      const section=proofVisible && !compactReason.matches?proofPane:reasonStatus;
      (collapsed?openReasonPanel:section.querySelector('[data-collapse-reason]')).focus({preventScroll:true});
    }
  }

  function focusProofReturn() {
    (proofReturn?.isConnected && !proofReturn.disabled && !proofReturn.closest('[inert]')
      ? proofReturn : $('reasonMenu')).focus({preventScroll:true});
  }

  function closeProof() {
    clearHint(); render();
    focusProofReturn();
  }

  function setMode(next) {
    editing=next;
    controlsView.showMode(next,()=>setRadial('selection',false));
  }

  function mountDraft(position) {
    editorModel.draft=position;
    draftMinesValid=true;
    controlsView.showDraft(position);
    mount(position);
  }

  function switchMode(next) {
    if(editing===next || generation.searching || gameRequests.busy || auto) return;
    if(next) {
      let position=editorModel.draft;
      if(!position) try {
        const w=$('width').valueAsNumber, h=$('height').valueAsNumber;
        position=positionGame(game ? copyPosition(game) : seeds.dimensionsOk(w,h) ? seeds.create(w,h) :
          seeds.create(Number($('width').defaultValue),Number($('height').defaultValue)));
      } catch(error) {say(error instanceof RangeError?'浏览器无法分配此棋盘，请缩小尺寸。':error.message,'error');return;}
      editorModel.parkedGame=game;
      setMode(next); mountDraft(position);
    } else {setMode(next);draftMinesValid=true;mount(editorModel.parkedGame);}
    say('');
  }

  function resizeDraft(blank) {
    if(!editing || gameRequests.busy) return;
    try { resizeDraftTo(readDimensions('editWidth','editHeight'),blank); }
    catch(error) {say(error instanceof RangeError?'浏览器无法分配此棋盘，请缩小尺寸。':error.message,'error');}
  }

  function resizeDraftTo(dimensions,blank) {
    mountDraft(positionGame(editorModel.resize(game,dimensions,blank)));
    say(blank?'已新建空白局面。':'已调整棋盘尺寸。');
  }

  function editCell(i,marking=false,value=digit) {
    if(!editing || gameRequests.busy) return;
    const tool=marking?'flag':game.numbers?'number':editTool;
    const result=editorModel.edit(game,i,tool,value);
    if(result.status==='unchanged') {feedback.sound('click');return;}
    if(result.status==='blocked') {feedback.sound('rejected');say('有雷的格子不能设为已开。','error');return;}
    feedback.sound(result.sound);
    if(result.status==='flag') {refreshDraftMarks();render();return;}
    if(tool==='mine') boardView.showSize(game);
    discardOpenedMarks(game,result.opened);
    scheduleVerification(); render(); say('');
  }

  function discardOpenedMarks(g,cells) {
    if(!cells.length) return;
    input.endStroke();
    gameModel.discardOpenedMarks(g,cells);
    input.history();
  }

  function positionMarkIssue({status,state},board,flags,red) {
    if(status==='invalid') return '数字与总雷数互相矛盾。';
    if(status!=='complete') return '未能核对旗子和红标。';
    const names={flag:'旗子',cross:'红叉',slash:'红斜杠'};
    const issues=checkPositionMarks(state,flags,red);
    if(!issues.length) return '';
    const details=issues.slice(0,6).map(({cell,mark,conflict})=>
      `${format.coordinate(cell,board.w)} 的${names[mark]}${conflict?'与公开线索冲突':'尚不能由公开线索证实'}`);
    if(issues.length>details.length) details.push(`另有 ${issues.length-details.length} 处`);
    return `${details.join('；')}。`;
  }

  function cancelDraftMarkJob() {
    if(!draftMarkJob) return;
    clearTimeout(draftMarkJob.timer);
    draftMarkJob.worker?.terminate();
    draftMarkJob=null;
  }

  function refreshDraftMarks(publicChanged=false) {
    const label=$('draftMarkStatus'), g=game;
    if(publicChanged) {
      cancelDraftMarkJob();
      draftMarkJudgment=null;
    }
    label.hidden=!editing || !g;
    if(label.hidden) return;
    const red=g.notes.layers.red;
    function show(text,tone='') {
      label.dataset.tone=tone;
      if(label.textContent!==text) label.textContent=text;
    }
    if(!g.flags.size && !red.size) {
      cancelDraftMarkJob();
      show('草稿标记校验：无旗子或红标。');
    } else if(g.numbers && !draftMinesValid) {
      show('草稿标记校验：请输入有效的总雷数。','error');
    } else if(g.board.mines===g.visible.length) {
      show('草稿标记校验：游戏局面至少需要一个安全格。','error');
    } else if(draftMarkJudgment) {
      const issue=positionMarkIssue(draftMarkJudgment,g.board,g.flags,red);
      show(`草稿标记校验：${issue || '旗子和红标均可由公开线索证实。'}`,issue?'error':'success');
    } else {
      show('正在核对草稿中的旗子和红标…');
      if(draftMarkJob) return;
      const job=draftMarkJob={timer:setTimeout(()=>{
        function receive(result) {
          if(job!==draftMarkJob || g!==game || !editing) return;
          cancelDraftMarkJob();
          draftMarkJudgment=result;
          refreshDraftMarks();
        }
        try {
          const task=job.worker=background(`const engine=makeMinesEngine();
            onmessage=({data:{p,visible}})=>{
              try {postMessage(engine.classify(p,visible,{nodeBudget:Infinity}));}
              catch {postMessage({status:'error'});}
            };`);
          task.onmessage=({data})=>receive(data);
          task.onerror=()=>receive({status:'error'});
          task.postMessage({p:g.p,visible:g.visible});
        } catch {receive({status:'error'});}
      },160)};
    }
  }

  async function prepareGame(position,p,witness) {
    const {board,visible,flags=[],notes=[]}=position;
    if(board.mines===visible.length) throw Error('游戏局面至少需要一个安全格。');
    let judgment;
    if(flags.length || notes[0]?.length) {
      // Check the public position without assuming any of its flags or red marks.
      judgment=await ask('classify',{p:{w:board.w,h:board.h,mines:board.mines},visible});
      const issue=positionMarkIssue(judgment??{},board,flags,notes[0]??[]);
      if(issue) throw Error(`局面未载入：${issue}`);
    }
    if(position.numbers) {
      const result=witness?{board:witness}:await ask('materialize',{p:board,visible});
      if(!result?.board) throw Error(result?.status==='invalid'?'数字与总雷数互相矛盾。':'尚未找到可行的雷布局。');
      position={...position,numbers:false,board:result.board};
    }
    const g=positionGame(position,p);
    if(judgment) {
      g.judgment=judgment;
      g.proven=new Set(g.flags);
      g.manual=restoreManualMarks(judgment.state,g.flags,engine.confirmationTargets,g.notes);
    }
    return g;
  }

  function scheduleVerification() {
    refreshDraftMarks(true);
    clearTimeout(verificationTimer);
    verificationWorker?.terminate();
    verificationWorker=null;
    const g=game;
    const needsOpeningVerification=g && !editing && !g.openingVerification;
    if(!g || g.current && g.verification && !needsOpeningVerification) {showVerification();return;}
    if(editing && g.numbers && !draftMinesValid) {
      g.current={status:'invalid-total'}; showVerification(); controls(); return;
    }
    if(g.board.mines===g.visible.length && (!g.numbers || !g.opened)) {
      g.current={status:'no-safe-cell'}; showVerification(); controls(); return;
    }
    showVerification();
    verificationTimer=setTimeout(()=>{
      try {
        const task=verificationWorker=background(`const engine = makeMinesEngine();
          const summarize=(${verificationSummary.toString()});
          onmessage = ({data:{board,p,visible,proven,flags,numbers,hasCurrent,hasVerification,opening,confirmed,original,sameAsOpening}}) => {
            try {
              const current=hasCurrent?null:engine.inspect(p,visible,proven,flags,{opening,confirmed});
              const witness=numbers && current?.status!=='invalid'?engine.publicBoard(p,visible).board:null;
              if(current) postMessage({current,witness});
              if(!hasVerification) {
                const model=current.status==='invalid' || current.status==='finished'?null:numbers?witness:board;
                const snapshot=model && {...model,opening:visible.flatMap((v,i)=>v>=0?[i]:[])};
                const report=snapshot?engine.verify(snapshot,p,{marks:proven,flags,certify:true,confirmed,allowEmpty:true,
                  ...(opening?{}:{visible})}):{status:current.status};
                const verification=summarize(report);
                postMessage({verification,...(sameAsOpening?{openingVerification:verification}:{})});
              }
              if(original) {
                const report=engine.verify(original.board,p,{flags:original.flags,marks:original.flags,certify:true,allowEmpty:true});
                postMessage({openingVerification:summarize(report)});
              }
              postMessage({done:true});
            } catch {postMessage({error:true,done:true});}
          };`);
        const receive=({current,witness,verification,openingVerification,error,done})=>{
          if(task!==verificationWorker || g!==game) return;
          if(done) {task.terminate(); verificationWorker=null;}
          if(current) {g.current=current;g.witness=witness;}
          if(verification) g.verification=verification;
          if(openingVerification) g.openingVerification=openingVerification;
          if(error) {g.current??={status:'error'};g.verification??={status:'error'};}
          showVerification(); controls();
        };
        task.onmessage=({data})=>receive(data);
        task.onerror=()=>receive({error:true,done:true});
        const confirmed=g.manual?[...g.manual.marked]:[];
        const sameAsOpening=needsOpeningVerification && !g.verification && g.visible===g.originalVisible && !g.proven.size && !confirmed.length &&
          g.flags.size===g.originalFlags.length && g.originalFlags.every(v=>g.flags.has(v));
        // Draft marks describe the editor's notes, not the puzzle being verified.
        task.postMessage({p:g.p,board:g.board,visible:g.visible,proven:[...g.proven],flags:editing?[]:[...g.flags],numbers:g.numbers,
          hasCurrent:!!g.current && !!g.verification,hasVerification:!!g.verification,
          opening:editing || g.opened===g.original.opening.length,confirmed,sameAsOpening,
          original:needsOpeningVerification && !sameAsOpening?{board:g.original,flags:g.originalFlags}:null});
      } catch {
        verificationWorker?.terminate(); verificationWorker=null;
        g.current??={status:'error'}; g.verification??={status:'error'};
        showVerification(); controls();
      }
    },160);
  }

  function seedFeedback(text,tone='') {
    $('seedFeedback').textContent=text;
    $('seedFeedback').dataset.tone=tone;
  }

  let seedImport;
  function seedDialog(importing) {
    const dialog=$('seedDialog');
    const box=$('positionSeedText');
    $('seedDialogTitle').textContent=importing?'导入局面种子':'导出局面种子';
    $('confirmImport').hidden=!importing;
    $('copyPosition').hidden=importing;
    box.readOnly=!importing;
    box.value=importing?'':seeds.encode(game);
    seedFeedback('');
    if(!dialog.open) dialog.showModal();
    dialog.classList.remove('is-closing');
    box.focus();
    if(!importing) box.select();
  }

  function closeSeedDialog() {
    const dialog=$('seedDialog');
    if(!dialog.open || dialog.classList.contains('is-closing')) return;
    if(seedImport) {
      seedImport=null;
      cancelPlayRequest();
      $('confirmImport').disabled=false;
      controls();
    }
    dialog.classList.add('is-closing');
    // Keep the native modal active until its fade finishes, then return focus.
    const fade=dialog.getAnimations().find(a=>a.transitionProperty==='opacity');
    const finish=()=>{
      if(!dialog.classList.contains('is-closing')) return;
      dialog.close();
      dialog.classList.remove('is-closing');
    };
    if(fade) fade.finished.then(finish,finish);
    else finish();
  }

  $('gameMode').onclick=()=>switchMode(false);
  $('editMode').onclick=()=>switchMode(true);
  $('editorSettings').onsubmit=e=>{e.preventDefault();resizeDraft(false);};
  $('blankPosition').onclick=()=>resizeDraft(true);
  $('copyGamePosition').onclick=()=>{
    if(!editorModel.parkedGame) return;
    mountDraft(positionGame(copyPosition(editorModel.parkedGame)));
    say('已复制当前游戏局面。');
  };
  $('editTools').onclick=e=>{
    const mode=e.target.closest('[data-draft]')?.dataset.draft;
    if(mode) {
      if((mode==='numbers')===game.numbers) return;
      const {w,h,mines}=game.board;
      if(mode==='numbers') {
        const position=seeds.numbers(w,h,mines,game.visible.map(n=>n<0?'.':n).join(''),[...game.flags]);
        position.notes=gameModel.noteEntries(game);
        mountDraft(positionGame(position));
      } else {
        if(!game.witness) {
          const hasClues=game.visible.some(n=>n>=0);
          if(hasClues && !confirm('当前数字没有可用的排雷布局。切换为标雷并新建空白局面？')) return;
          mountDraft(positionGame(seeds.create(w,h)));
        } else mountDraft(positionGame({...copyPosition(game),board:game.witness,numbers:false}));
      }
      say('');return;
    }
    const button=e.target.closest('[data-edit]');
    if(!button) return;
    editTool=button.dataset.edit;
    for(const item of $('mineTools').querySelectorAll('[data-edit]')) item.setAttribute('aria-pressed',String(item===button));
  };
  $('draftMines').oninput=()=>{
    const value=$('draftMines').valueAsNumber;
    draftMinesValid=editorModel.setMineCount(game,value);
    boardView.showSize(game); render(); scheduleVerification(); controls();
  };
  function chooseDigit(value) {
    digit=value;
    for(const button of $('digitPalette').children) button.setAttribute('aria-pressed',String(Number(button.dataset.digit)===digit));
  }
  for(const value of [0,1,2,3,4,5,6,7,8,-1]) {
    const button=element('button','digit-tool'); button.type='button'; button.dataset.digit=value;
    if(value<0) {button.innerHTML=icon('eraser');button.title='盖回格子';button.setAttribute('aria-label',button.title);}
    else button.textContent=value;
    button.onclick=()=>chooseDigit(value);
    $('digitPalette').append(button);
  }
  chooseDigit(digit);
  $('playPosition').onclick=async()=>{
    if(!editing || gameRequests.busy || $('playPosition').disabled) return;
    try {
      const g=await prepareGame(copyPosition(game),undefined,game.witness);
      setMode(false);
      editorModel.parkedGame=undefined;
      mount(g);
      say('已将编辑局面载入游戏。','success');
    } catch(error) {say(error.message,'error');}
  };
  $('expandPosition').onclick=async()=>{
    const g=game;
    if(!g || g.current?.status!=='blocked' || gameRequests.busy || generation.searching || auto) return;
    const board=g.numbers?g.witness:g.board;
    if(!board) return;
    dismissSearchResult();
    const result=await ask('expand',{board,visible:g.visible,flags:editing?[]:g.flags});
    if(g!==game) return;
    if(result?.status!=='expanded') {say('未能确定最少开扩格数，局面未改变。','error');return;}
    gameModel.resetConfirmation(g);
    g.visible=result.visible; g.opened+=result.cells.length;
    discardOpenedMarks(g,result.cells);
    if(editing) {
      g.board.opening=g.visible.flatMap((n,i)=>n>=0?[i]:[]);
      g.board.first=g.board.opening[0]??0;
    } else {
      clearHint();
      g.started??=Date.now();
      if(g.opened===g.visible.length-g.board.mines) finish();
    }
    g.verification=g.current=g.judgment=g.witness=undefined;
    scheduleVerification(); render();
    say(`已开扩 ${result.cells.length} 格 · ${result.cells.map(coord).join('、')}`,'success');
    if(g.answers && ready()) void judge(g);
  };
  $('importPosition').onclick=()=>seedDialog(true);
  $('exportPosition').onclick=()=>seedDialog(false);
  $('closeSeedDialog').onclick=closeSeedDialog;
  $('seedDialog').addEventListener('cancel',e=>{e.preventDefault();closeSeedDialog();});
  $('seedForm').onsubmit=async e=>{
    e.preventDefault();
    const dialog=$('seedDialog'), button=$('confirmImport');
    if(!dialog.open || dialog.classList.contains('is-closing') || button.hidden || seedImport || gameRequests.busy) return;
    const job=seedImport={};
    button.disabled=true;
    try {
      const position=seeds.decode($('positionSeedText').value);
      const g=editing?positionGame(position):await prepareGame(position);
      if(seedImport!==job) return;
      if(editing) mountDraft(g);
      else mount(g);
      say('已导入局面。','success');
    } catch(error) {
      if(seedImport===job) seedFeedback(error.message,'error');
      return;
    } finally {
      if(seedImport===job) {
        seedImport=null;
        button.disabled=false;
      }
    }
    closeSeedDialog();
  };
  $('copyPosition').onclick=async()=>{
    const box=$('positionSeedText');
    try {await navigator.clipboard.writeText(box.value);}
    catch {
      box.focus(); box.select();
      if(!document.execCommand('copy')) {seedFeedback('请按 Ctrl+C 复制已选中的种子。');return;}
    }
    seedFeedback('已复制。','success');
  };

  const input = makeBoardInput({$,icon,say,sound:feedback.sound,canAct:()=>!!game && !generation.searching && !gameRequests.busy && !auto && (editing || ready()),getGame:()=>game,changed:(cells,kind)=>{
    if(game) {
      dismissSearchResult();
      if(editing) refreshDraftMarks();
      render();
      if(cells.length) feedback.tile(editing?'ink':'blue',boardView.buttons[cells.at(-1)]);
      feedback.sound(kind,cells.length || 1);
    }
  },
    confirmationChanged:effect=>{
      clearHint();
      showMarks(game,[],false);
      feedback.sound(effect);
    },menu:setRadial,closeReason:()=>showReason(false)});
  $('settings').addEventListener('submit',generate);
  showDifficultyDefaults();
  const difficulty=$('difficultySettings');
  const difficultyToggle=$('difficultyToggle'), difficultyOptions=$('difficultyOptions');
  function setDifficultyOpen(open) {
    difficultyToggle.setAttribute('aria-expanded',String(open));
    difficultyOptions.inert=!open;
  }
  difficultyToggle.onclick=()=>setDifficultyOpen(difficultyOptions.inert);
  document.addEventListener('pointerdown',e=>{
    if(!difficultyOptions.inert && !difficulty.contains(e.target)) {
      if(difficultyOptions.contains(document.activeElement)) difficultyToggle.focus({preventScroll:true});
      setDifficultyOpen(false);
    }
  });
  $('cancel').onclick = () => { generation.stop(); saySearch(`已取消生成。${game ? '当前棋局已保留。' : ''}`); };
  $('useCandidate').onclick = () => {
    if(!generation.candidate) return;
    const candidate=generation.candidate, wasSearching=generation.searching;
    generation.stop();
    const {text,shortfall}=generationProgress(candidate.progress,candidate.report);
    const message=wasSearching?'已停止搜索并采用候选。':'已采用候选。';
    mountGenerated(candidate,candidate.p,`${message}${text}`,shortfall);
    $('board').querySelector('[tabindex="0"]')?.focus({preventScroll:true});
  };
  $('restart').onclick = async () => {
    if (!game || generation.searching || gameRequests.busy && !auto) return;
    dismissSearchResult();
    stopAuto();
    const {original,p,originalVisible,originalFlags}=game;
    try {
      const position=await prepareGame({board:original,visible:originalVisible,flags:originalFlags},p);
      mount(position);
      say(game.state === 'won' ? '首开通关 · 所有安全格已打开' : '已恢复原始开局。');
    } catch(error) {say(error.message,'error');}
  };
  $('focus').onclick = () => toggleHint('focus');
  $('hint').onclick = () => toggleHint('hint');
  $('apply').onclick = () => {
    if (!ready() || auto || gameRequests.busy) return;
    if (manualStepAction(game?.manual)==='commit') void commitBatch(game);
    else void requestHint($('apply'));
  };
  $('commitMarks').dataset.soundHandled='';
  $('commitMarks').onclick = () => {if(!auto) void commitBatch(game);};
  $('solve').onclick = solve;
  $('answers').onclick = toggleAnswers;
  const reasonLauncher=$('reasonMenu');
  let reasonHold, suppressReasonClick=false;
  function stopReasonHold(e) {
    if(!reasonHold || (e && e.pointerId!==reasonHold.id)) return;
    clearTimeout(reasonHold.timer);
    reasonHold=undefined;
    reasonLauncher.classList.remove('holding');
  }
  reasonLauncher.onpointerdown=e=>{
    if(e.button!==0 || !e.isPrimary || reasonLauncher.disabled) return;
    suppressReasonClick=false;
    const timer=setTimeout(()=>{
      suppressReasonClick=true;
      stopReasonHold();
      if(reasonLauncher.disabled) return;
      if(game) game.answers=false;
      clearHint(false);
      showReason(false);
      controls(); render();
    },650);
    reasonHold={timer,id:e.pointerId,x:e.clientX,y:e.clientY};
    reasonLauncher.classList.add('holding');
    reasonLauncher.setPointerCapture(e.pointerId);
  };
  reasonLauncher.onpointermove=e=>{
    if(reasonHold?.id!==e.pointerId) return;
    const {left,right,top,bottom}=reasonLauncher.getBoundingClientRect();
    const outside=e.clientX<left || e.clientX>right || e.clientY<top || e.clientY>bottom;
    if(outside || Math.hypot(e.clientX-reasonHold.x,e.clientY-reasonHold.y)>9) {
      suppressReasonClick=true;
      stopReasonHold(e);
    }
  };
  reasonLauncher.onpointerup=reasonLauncher.onpointercancel=reasonLauncher.onlostpointercapture=stopReasonHold;
  reasonLauncher.onclick=e=>{
    const blocked=e.detail!==0 && suppressReasonClick;
    suppressReasonClick=false;
    if(!blocked) showReason($('reasonFlower').inert,true);
  };
  selectionReadout.addEventListener('pointerover',e=>updateSelectionHover(e,e.target));
  selectionReadout.addEventListener('pointerout',e=>updateSelectionHover(e,e.relatedTarget));
  selectionReadout.addEventListener('focusin',e=>{
    focusedSelection=selectionView.tokenAt(e.target);
    updateProofPreview();
  });
  selectionReadout.addEventListener('focusout',e=>{
    focusedSelection=selectionView.tokenAt(e.relatedTarget);
    updateProofPreview();
  });
  const selectionLauncher=$('selectionMenu');
  let selectionHold, suppressSelectionClick=false;
  function stopSelectionHold() {
    clearTimeout(selectionHold?.timer);
    selectionHold=undefined;
    selectionLauncher.classList.remove('holding');
  }
  selectionLauncher.onpointerdown=e=>{
    if(e.button!==0 || !e.isPrimary || selectionLauncher.disabled) return;
    suppressSelectionClick=false;
    const timer=setTimeout(()=>{
      suppressSelectionClick=true;
      stopSelectionHold();
      if(!selectionLauncher.disabled && (selectionHistory.weights.size || selectionHistory.clueWeights.size)) {
        dismissSearchResult();
        clearSelection(true);
      }
    },650);
    selectionHold={timer,id:e.pointerId,x:e.clientX,y:e.clientY};
    selectionLauncher.classList.add('holding');
    selectionLauncher.setPointerCapture(e.pointerId);
  };
  selectionLauncher.onpointermove=e=>{
    if(selectionHold?.id===e.pointerId && Math.hypot(e.clientX-selectionHold.x,e.clientY-selectionHold.y)>9) {
      suppressSelectionClick=true;
      stopSelectionHold();
    }
  };
  selectionLauncher.onpointerup=selectionLauncher.onpointercancel=selectionLauncher.onlostpointercapture=stopSelectionHold;
  selectionLauncher.oncontextmenu=e=>e.preventDefault();
  selectionLauncher.onclick=e=>{
    const blocked=e.detail!==0 && suppressSelectionClick;
    suppressSelectionClick=false;
    if(!blocked) setRadial('selection',$('selectionFlower').inert);
  };
  $('selectionAdd').onclick=()=>setSelectionMode(selectionMode==='add'?'':'add');
  $('selectionSubtract').onclick=()=>setSelectionMode(selectionMode==='subtract'?'':'subtract');
  function moveSelectionHistory(action) {
    if(!selectionHistory[action]()) return;
    dismissSearchResult();
    refreshSelection();
  }
  $('selectionUndo').onclick=()=>moveSelectionHistory('undo');
  $('selectionRedo').onclick=()=>moveSelectionHistory('redo');
  $('markHistory').addEventListener('click',e=>{
    if(e.target.closest('button:not(:disabled)')) dismissSearchResult();
  },{capture:true});
  $('closeProof').onclick = closeProof;
  openReasonPanel.onclick = () => setReasonCollapsed(false,true);
  for(const button of document.querySelectorAll('[data-collapse-reason]')) {
    button.onclick = () => setReasonCollapsed(true,true);
  }
  document.addEventListener('keydown',e=>{
    if(e.key!=='Escape' || e.defaultPrevented || $('seedDialog').open) return;
    if(!proofPane.inert) closeProof();
    else if(!difficultyOptions.inert) {setDifficultyOpen(false);difficultyToggle.focus({preventScroll:true});}
    else if(!$('reasonFlower').inert) showReason(false,true);
    else if(!$('selectionFlower').inert) {setRadial('selection',false);selectionLauncher.focus({preventScroll:true});}
    else if(!$('markFlower').inert || input.writing) {input.close();$('markMenu').focus({preventScroll:true});}
    else fullscreen.escape();
  });

  const board = $('board');
  const touchFlagHold=320;
  let flagDrag, inkDrag, skipDragClick=false;
  board.addEventListener('touchstart',e=>{
    if(input.writing && e.target.closest('[data-cell]')) e.preventDefault();
  },{passive:false});
  board.addEventListener('touchmove',e=>{
    // On the split board, a held touch on an open tile drags a flag; a swipe pans natively.
    if(e.touches.length===1 && flagDrag?.holdUntil && e.timeStamp>=flagDrag.holdUntil) e.preventDefault();
  },{passive:false});
  function cellAt(x,y) {
    const cell=document.elementFromPoint(x,y)?.closest('[data-cell]');
    if(cell && board.contains(cell)) return Number(cell.dataset.cell);
  }
  function moveInk(e) {
    if(inkDrag?.id!==e.pointerId) return;
    const {x,y,spacing}=inkDrag, dx=e.clientX-x, dy=e.clientY-y;
    // Capture keeps the gesture active across gaps; sample the segment to avoid skipping cells.
    const count=Math.max(1,Math.ceil(Math.hypot(dx,dy)/spacing)), cells=[];
    for(let step=1;step<=count;step++) {
      const i=cellAt(x+dx*step/count,y+dy*step/count);
      if(i!==undefined) cells.push(i);
    }
    inkDrag.x=e.clientX;inkDrag.y=e.clientY;
    input.drawStroke(cells);
  }
  function stopInk(e,finish=false) {
    if(inkDrag?.id!==e.pointerId) return;
    if(finish) moveInk(e);
    inkDrag=null;input.endStroke();
  }
  board.addEventListener('pointerdown',e=>{
    if(!e.isPrimary || e.button!==0) return;
    if(inkDrag) return;
    flagDrag=null; skipDragClick=false;
    const cell=e.target.closest('[data-cell]');
    if(!cell) return;
    const i=Number(cell.dataset.cell);
    if(selectionMode) return;
    if(input.writing) {
      if(input.startStroke(i)) {
        dismissSearchResult();
        inkDrag={id:e.pointerId,x:e.clientX,y:e.clientY,spacing:Math.max(1,cell.offsetWidth/4)};
        skipDragClick=true;
        board.setPointerCapture(e.pointerId);
        cell.focus({preventScroll:true});
        if(game.visible[i]>=0) feedback.sound('click');
        input.drawStroke([i]);
      }
      return;
    }
    if(!ready() || gameRequests.busy || auto || !$('markFlower').inert) return;
    const from=game.flags.has(i)?i:undefined;
    if(game.visible[i]<0 && from===undefined) return;
    const holdUntil=e.pointerType==='touch' && from===undefined && viewport.classList.contains('mobile-proof-split')
      ? e.timeStamp+touchFlagHold : 0;
    flagDrag={id:e.pointerId,x:e.clientX,y:e.clientY,from,game,holdUntil};
  });
  board.addEventListener('pointermove',e=>{
    if(inkDrag?.id===e.pointerId) {moveInk(e);return;}
    const drag=flagDrag;
    if(drag?.id!==e.pointerId || drag.game!==game) return;
    if(!drag.ghost) {
      if(!e.buttons || Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<8) return;
      if(e.timeStamp<drag.holdUntil) {flagDrag=null;return;}
      // 越过拖动阈值后再捕获指针，让直接点按仍落在原格子上。
      dismissSearchResult();
      board.setPointerCapture(e.pointerId);
      drag.ghost=element('span','drag-flag');
      drag.ghost.innerHTML=icon('flag');
      drag.ghost.setAttribute('aria-hidden','true');
      viewport.append(drag.ghost);
    }
    const previewOffset=32;
    drag.ghost.style.transform=`translate(${e.clientX-previewOffset}px,${e.clientY-previewOffset}px) translate(-50%,-50%)`;
  });
  function stopFlagDrag(e,drop=false) {
    const drag=flagDrag;
    if(drag?.id!==e.pointerId) return;
    flagDrag=null;
    if(!drag.ghost) {
      // Releasing a held touch without dragging must not play the tile's tap action.
      if(drop && drag.holdUntil && e.timeStamp>=drag.holdUntil) skipDragClick=true;
      return;
    }
    drag.ghost.remove();
    skipDragClick=true;
    if(!drop || drag.game!==game || !ready() || gameRequests.busy || auto || input.writing) return;
    const i=cellAt(e.clientX,e.clientY);
    if(i===undefined || game.visible[i]>=0) {
      if(drag.from!==undefined) play(drag.from,true);
      else feedback.sound('click');
    } else if(!game.flags.has(i)) {
      clearHint(); game.focus=i;
      void recordManual(game,[i],'mine',drag.from);
    } else feedback.sound('click');
  }
  document.addEventListener('pointerup',e=>{stopInk(e,true);stopFlagDrag(e,true);});
  document.addEventListener('pointercancel',e=>{stopInk(e);stopFlagDrag(e);});
  board.addEventListener('lostpointercapture',e=>{if(e.target===board) {stopInk(e);stopFlagDrag(e);}});
  board.addEventListener('click',e=>{
    const b=e.target.closest('[data-cell]'); if(!b) return;
    dismissSearchResult();
    const i=Number(b.dataset.cell);
    if(selectBoardCell(i)) return;
    if(input.stamp(i)) return;
    (editing?editCell:play)(i,e.shiftKey);
  });
  board.addEventListener('contextmenu',e=>{
    const b=e.target.closest('[data-cell]'); if (b) {
      e.preventDefault();
      if(inkDrag || flagDrag?.holdUntil) return;
      dismissSearchResult();
      const i=Number(b.dataset.cell);
      if(selectBoardCell(i)) return;
      if(input.erase(i)) return;
      (editing?editCell:play)(i,true);
    }
  });
  board.addEventListener('keydown',e=>{
    const b=e.target.closest('[data-cell]'); if (!b || !game) return;
    const i=Number(b.dataset.cell), w=game.board.w;
    if(editing && game.numbers && (/^[0-8]$/.test(e.key) || ['Delete','Backspace'].includes(e.key))) {
      dismissSearchResult();
      e.preventDefault(); editCell(i,false,/^[0-8]$/.test(e.key)?Number(e.key):-1); return;
    }
    let n=i;
    switch (e.key) {
      case 'ArrowLeft': if(i%w) n--; break;
      case 'ArrowRight': if(i%w<w-1) n++; break;
      case 'ArrowUp': if(i>=w) n-=w; break;
      case 'ArrowDown': if(i+w<boardView.buttons.length) n+=w; break;
      case 'f': case 'F':
        e.preventDefault();
        dismissSearchResult();
        if(selectBoardCell(i)) return;
        if(!input.writing) (editing?editCell:play)(i,true);
        return;
      default: return;
    }
    e.preventDefault();
    if(n!==i) dismissSearchResult();
    game.focus=n; boardView.buttons[i].tabIndex=-1; boardView.buttons[n].tabIndex=0; boardView.buttons[n].focus();
  });
  setInterval(time,250);
  controls();
})();
