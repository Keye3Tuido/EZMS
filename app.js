(() => {
  'use strict';
  const engine = makeMinesEngine();
  const format = makeProofFormat();
  const regionSelection=makeRegionSelection(engine.adj);
  const radialLayout=makeRadialLayout();
  const seeds = makePositionSeeds(engine.adj);
  const $ = id => document.getElementById(id);
  const selectionReadout=$('selectionReadout');
  const viewport = $('gameViewport');
  const fullscreen = makeGameFullscreen(viewport, $('fullscreenToggle'), $('fullscreenStatus'));
  const feedback = makeGameFeedback($('soundToggle'),$('motionToggle'));
  const proofDrawing=document.createElementNS('http://www.w3.org/2000/svg','svg');
  proofDrawing.classList.add('board-proof');
  proofDrawing.setAttribute('aria-hidden','true');
  const proofPattern=document.createElementNS(proofDrawing.namespaceURI,'defs');
  const hatch=document.createElementNS(proofDrawing.namespaceURI,'pattern');
  for(const [name,value] of Object.entries({id:'proof-hatch',patternUnits:'userSpaceOnUse',width:6,height:6,patternTransform:'rotate(45)'})) hatch.setAttribute(name,value);
  const hatchLine=document.createElementNS(proofDrawing.namespaceURI,'rect');
  hatchLine.setAttribute('width','2'); hatchLine.setAttribute('height','6');
  hatch.append(hatchLine); proofPattern.append(hatch);
  const inkDrawing=document.createElementNS('http://www.w3.org/2000/svg','svg');
  inkDrawing.classList.add('board-ink');
  inkDrawing.setAttribute('aria-hidden','true');
  let paintedInk='';
  const fields = ['width', 'height', 'minAverage', 'minMultiPercent', 'minPeakClues'];
  let game, worker, generationCandidate, auto = false, run = 0, buttons = [];
  let editing=false, parkedGame, draft, editTool='mine';
  let digit=1, draftMinesValid=true;
  let playWorker, pending;
  let verificationWorker, verificationTimer;
  let draftMarkJob, draftMarkJudgment;
  const proofKinds=['cancelled','positive','negative','element','selection-positive','selection-negative'];
  const proofTargets=new WeakMap(), proofRows=new WeakMap();
  let hoveredProof, focusedProof, pinnedProof;
  let activeProofRow;
  let activeAreaPreview = null;
  let selectionHistory=regionSelection.history();
  const selectionTargets=new WeakMap();
  let hoveredSelection, focusedSelection, selectionReadoutKey;
  let selectionCountWorker, selectionCountKey, selectionCountTimer;
  let selectionExpressionWorker, selectionExpressionJob;
  const selectionCountCache=new Map();
  let activeSelectionClues=[];
  let selectionMode='';

  function updateOperationCard() {
    $('operationCard').hidden=$('operationText').hidden && $('operationRound').hidden;
  }

  function say(text,tone='') {
    const status=$('operationText');
    status.textContent=text;
    status.dataset.tone=tone;
    status.hidden=!text;
    updateOperationCard();
  }

  function saySearch(text,tone='',shortfall='') {
    const status=$('status'), summary=$('candidateShortfall');
    $('searchCard').hidden=!text;
    status.textContent=text;
    status.dataset.tone=tone;
    if(summary.textContent!==shortfall) summary.textContent=shortfall;
    summary.hidden=!shortfall;
  }

  function dismissSearchResult() {
    if(worker) return;
    if(generationCandidate) {
      generationCandidate=undefined;
      $('useCandidate').disabled=true;
    }
    if(!$('searchCard').hidden) saySearch('');
  }
  const icon = id => `<svg class="icon" aria-hidden="true"><use href="#${id}"/></svg>`;
  const coord = i => format.coordinate(i,game.board.w);

  function batchControls() {
    const batch=game?.manual, complete=!!batch?.done, live=ready();
    const locked = auto || !!pending;
    const commit=$('commitMarks');
    const canCommit=live && complete;
    if(!canCommit && document.activeElement===commit) buttons[game?.focus]?.focus({preventScroll:true});
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
    button.disabled=!auto && (!!worker || !live || !!pending);
    if(label.textContent!==text) {
      button.querySelector('use').setAttribute('href',auto?'#stopIcon':'#play');
      label.textContent=text;
    }
  }

  function controls() {
    const live = game?.state === 'playing', locked = !!worker || auto || !!pending;
    for (const id of fields) $(id).disabled = !!worker;
    $('generate').disabled = !!worker || !!pending && !auto;
    const cancel=$('cancel'), canCancel=!!worker;
    cancel.classList.toggle('is-inactive',!canCancel);
    cancel.setAttribute('aria-hidden',String(!canCancel));
    cancel.disabled=!canCancel;
    const useCandidate=$('useCandidate');
    useCandidate.disabled=!generationCandidate;
    useCandidate.textContent=canCancel?'停止并采用候选':'采用候选';
    for (const id of ['gameMode','editMode','importPosition']) $(id).disabled = locked;
    $('exportPosition').disabled = locked || !game;
    $('playPosition').disabled = locked || !game || game.board.mines===game.visible.length || !!(game.numbers && !game.witness);
    $('draftMines').disabled=locked;
    $('exportPosition').disabled ||= editing && !draftMinesValid;
    $('expandPosition').disabled=locked;
    batchControls();
    for (const control of $('editorSettings').elements) control.disabled = locked;
    $('copyGamePosition').disabled = locked || !parkedGame;
    for (const button of $('editTools').querySelectorAll('button'))
      button.disabled = locked && !(editing && button.matches('[data-draft], [data-edit]'));
    $('reasonMenu').classList.toggle('is-inactive',editing);
    $('restart').hidden = editing;
    $('gameTime').hidden = editing;
    $('board').setAttribute('aria-busy',String(!!pending));
    $('answers').disabled=locked || !live;
    for(const id of ['focus','hint']) $(id).disabled=!!worker || auto || !live || !!pending && !proofRequest;
    $('reasonMenu').disabled = editing || !game || !!worker;
    $('selectionMenu').disabled = editing || !game || locked;
    selectionHistoryControls();
    $('markMenu').disabled = !game || !!worker || !!pending || auto || !editing && !live;
    $('restart').disabled = !!worker || !!pending && !auto || !game;
    updateSolveControl(live);
    $('reasonMenu').innerHTML=icon('hintIcon');
    $('reasonMenu').title='推理工具';
    $('reasonMenu').setAttribute('aria-label','推理工具');
    $('answers').setAttribute('aria-pressed',String(!!game?.answers));
    $('answers').querySelector('span').textContent = game?.answers ? '隐藏答案' : '展示答案';
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

  function cancelPlayRequest() {
    if (!pending) return;
    const resolve=pending, task=playWorker;
    pending=playWorker=null;
    task?.terminate();
    resolve(null);
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
  function finishWorker(keepCandidate=false) {
    for(const lane of worker?.active??[]) lane.terminate();
    worker=null;
    if(!keepCandidate) generationCandidate=undefined;
    controls();
  }

  function background(code) {
    const url = URL.createObjectURL(new Blob([`${makeMinesEngine.toString()}\n${code}`],{type:'text/javascript'}));
    try { return new Worker(url); }
    finally { URL.revokeObjectURL(url); }
  }

  function generate(e) {
    e?.preventDefault();
    if (worker || pending && !auto) return;
    let p;
    try { p = readSettings(); } catch (error) { saySearch(error.message, 'error'); return; }
    stopAuto();
    say('');
    const {target,compareClosest}=engine.generationRanking(p);
    const schedule=engine.generationSchedule(p,navigator.hardwareConcurrency);
    const usedSeeds=new Set();
    generationCandidate=undefined;
    let canStartMore=true, originalLane, replacedOriginal=false, originalFallback;
    const task=worker={lanes:new Map(),active:new Set()};
    function progress() {
      let tried=0,passed=0;
      for(const lane of task.lanes.values()) {tried+=lane.tried;passed+=lane.passed;}
      const report=generationCandidate?.report;
      const closest=report&&{average:report.averageClues,multiPercent:report.advancedDensity*100,peak:report.clues};
      return {tried,passed,closest,target};
    }
    function failed(lane,message) {
      if(worker!==task || !task.active.delete(lane)) return;
      lane.terminate();
      if(lane===originalLane) {
        if(!replacedOriginal) {
          replacedOriginal=true;
          try { startLane(true); return; }
          catch { /* 补位失败，结束整组搜索。 */ }
        }
      } else if(task.active.size) {
        updateCandidateFallback();
        return;
      }
      finishWorker(true);
      const candidate=generationCandidate;
      if(candidate) {
        const {text,shortfall}=generationProgress(candidate.progress,candidate.report);
        saySearch(`${message} ${text}`,'error',shortfall);
      } else saySearch(message,'error');
    }
    const code=`const options={};
      onmessage = async ({data:{p,seed,originalTarget,candidateFallback}}) => {
        options.candidateFallback=candidateFallback;
        if(!p) return;
        options.originalTarget=originalTarget;
        try {
          let updated = -Infinity, sentCandidate;
          const sendProgress=({candidate,...progress})=>{
            postMessage(candidate!==sentCandidate ? {progress,candidate} : {progress});
            sentCandidate=candidate;
            updated=performance.now();
          };
          for (const result of makeMinesEngine().generate(p,seed,sendProgress,options)) {
            if (result.board) { postMessage({result}); return; }
            if (performance.now() - updated >= 100) sendProgress(result);
            // 原目标线程在轮次之间接收实际并发变化。
            if(originalTarget) await new Promise(resolve=>setTimeout(resolve,0));
          }
        }
        catch (error) { postMessage({error:error.message}); }
      };`;
    function startLane(originalTarget) {
      let [seed]=crypto.getRandomValues(new Uint32Array(1));
      while(usedSeeds.has(seed)) seed=(seed+1)>>>0;
      usedSeeds.add(seed);
      const lane=background(code);
      lane.onmessage=({data})=>{
        if(worker!==task || !task.active.has(lane)) return;
        if(data.error) {failed(lane,`本次生成中止：${data.error}`);return;}
        if(data.progress) {
          task.lanes.set(lane,data.progress);
          if(data.candidate && (!generationCandidate || compareClosest(data.candidate.report,generationCandidate.report)<0)) {
            generationCandidate={...data.candidate,p};
            $('useCandidate').disabled=false;
          }
          const merged=progress();
          if(generationCandidate) generationCandidate.progress=merged;
          startLanes(schedule.lanesAt(merged.tried));
          const {text,shortfall}=generationProgress(merged,generationCandidate?.report);
          saySearch(text,'',shortfall);
          return;
        }
        const result=data.result;
        task.lanes.set(lane,result);
        const {tried}=progress();
        finishWorker();
        mountGenerated(result,p,`三项难度达标 · 技巧通关验证通过 · 搜索 ${tried} 轮`);
      };
      lane.onerror=()=>failed(lane,`生成任务无法运行。${game ? '当前棋局已保留。' : ''}`);
      const candidateFallback=originalTarget && !task.active.size;
      try { lane.postMessage({p,seed,originalTarget,candidateFallback}); }
      catch(error) { lane.terminate(); throw error; }
      task.lanes.set(lane,{tried:0,passed:0});
      task.active.add(lane);
      if(originalTarget) {
        originalLane=lane;
        originalFallback=candidateFallback;
      }
    }
    function updateCandidateFallback() {
      if(!task.active.has(originalLane)) return;
      const enabled=task.active.size===1;
      if(enabled===originalFallback) return;
      originalLane.postMessage({candidateFallback:enabled});
      originalFallback=enabled;
    }
    function startLanes(desired) {
      // 退役线程仍计入累计进度，补位只占原有的一个并发名额。
      const scheduled=task.lanes.size-Number(replacedOriginal);
      for(let count=scheduled;canStartMore && count<desired;count++) {
        try { startLane(!originalLane); }
        catch { canStartMore=false; }
      }
      updateCandidateFallback();
    }
    startLanes(schedule.initial);
    if(!task.active.size) {
      finishWorker();
      saySearch('浏览器无法启动生成任务。请用 Edge 或 Chrome 打开本页。','error');
      return;
    }
    controls();
    saySearch('正在构造开局');
  }

  function mountGenerated({board,report},p,message,shortfall) {
    if(!report.openingMinimum) {saySearch('没有通过首步最少线索验证，未发放该局。','error'); return;}
    const position=positionGame({board},p);
    position.openingVerification=verificationSummary(report);
    mount(position);
    saySearch(message,'success',shortfall);
  }

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
      state:opened===visible.length-board.mines?'won':'playing',started:null,ended:null,highlight:null,focus:board.first,
      judgment:null,answers:false,selection:regionSelection.history()};
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
    const root = $('board');
    root.parentElement.hidden = !game;
    root.hidden = !game;
    if(!game) {
      $('size').textContent='—'; $('remaining').textContent='—'; time();
      root.replaceChildren(); buttons=[]; controls(); return;
    }
    const {board}=game;
    boardSize();
    root.style.setProperty('--cols',board.w);
    root.style.setProperty('--rows',board.h);
    buttons = Array.from({length:board.w*board.h}, (_,i) => {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.cell = i;
      return b;
    });
    function axis(text) {
      const label = document.createElement('span'); label.className = 'axis';
      label.setAttribute('aria-hidden','true'); label.textContent = text;
      return label;
    }
    const grid=document.createDocumentFragment();
    grid.append(axis(''));
    for(let x=0;x<board.w;x++) grid.append(axis(format.column(x)));
    for(let y=0;y<board.h;y++) {
      grid.append(axis(y+1));
      for(let x=0;x<board.w;x++) grid.append(buttons[y*board.w+x]);
    }
    root.replaceChildren(grid,proofDrawing,inkDrawing);
    render(); controls();
    feedback.visual('board',root);
  }

  function boardSize() {
    const {board}=game;
    $('size').textContent = `${board.w} × ${board.h} · `;
    const total = document.createElement('span'); total.id = 'totalMines'; total.textContent = `${board.mines} 雷`;
    $('size').append(total);
  }

  function verificationSummary({status,steps,averageClues,clues,advancedDensity}) {
    return {status,...(status==='passed' && steps>0 && Number.isFinite(averageClues)?
      {averageClues,peakClues:clues,multiClueRatio:advancedDensity}:{})};
  }

  function showVerification() {
    const current=game?.current;
    const verification=game?.verification;
    const wholeGame=editing?verification:game?.openingVerification;
    const count=n=>n==null?'—':`${current.partial?'≥ ':''}${n}`;
    const texts={deducible:current?.clues?'有确定结论':'有确定结论，尚无可展示的最少线索推导',blocked:'无可解格',
      invalid:'数字与总雷数互相矛盾',budget:'尚未完成验证',finished:'所有安全格已开',error:'验证未完成',
      confirmed:'本轮已标齐，可以开格并插旗',
      'invalid-total':'请输入有效的总雷数','no-safe-cell':'局面至少需要一个安全格'};
    $('currentStatus').textContent=game?(current?texts[current.status]:'正在验证当前线索…'):'暂无棋局';
    $('reasonStatus').dataset.state=current?.status??'';
    $('currentSafe').textContent=count(current?.safe);
    $('currentMines').textContent=count(current?.mines);
    const selectedClues=game?.selectedClues;
    $('currentClueLabel').textContent=selectedClues===undefined?'本步最少线索':'所示步骤最少线索';
    $('currentClues').textContent=selectedClues??current?.clues??'—';
    $('averageClues').textContent=verification?.averageClues?.toFixed(2)??'—';
    $('peakClues').textContent=wholeGame?.peakClues??'—';
    const ratio=wholeGame?.multiClueRatio;
    $('multiClueRatio').textContent=ratio==null?'—':`${Number((ratio*100).toFixed(2))}%`;
    $('expandPosition').hidden=current?.status!=='blocked' || !!(game.numbers && !game.witness);
    const check=$('verificationStatus');
    const showCheck=game && !['finished','invalid','invalid-total','no-safe-cell'].includes(current?.status);
    check.textContent=!showCheck?'':verification?.status==='passed' ? (game.numbers?'可行雷图的无猜验证通过':'无猜验证通过') :
      verification?.status==='stuck' ? '技巧推导卡住，未证实无猜可解' :
      verification ? '未能证实无猜可解' : '正在验证无猜通关…';
  }

  function time() {
    $('time').textContent = game?.started == null ? '0' : String(Math.floor(((game.ended ?? Date.now()) - game.started)/1000));
  }

  function confirmedInk(g,i) {
    const kind=g.manual?.marked.get(i);
    return kind?{symbol:kind==='mine'?'x':'/',level:0}:editing?g.notes.layers.red.get(i):undefined;
  }

  function paintInk() {
    if(!game || !buttons.length) return;
    const {w}=game.board, root=$('board'), style=getComputedStyle(root);
    const [axis,tile]=style.gridTemplateColumns.split(' ',2).map(parseFloat);
    const [axisY,height]=style.gridTemplateRows.split(' ',2).map(parseFloat);
    const dx=tile+parseFloat(style.columnGap),dy=height+parseFloat(style.rowGap);
    const left=axis+dx-tile/2, top=axisY+dy-height/2;
    if(!Number.isFinite(left+top)) return;
    const redCells=editing?game.notes.layers.red.keys():game.manual?.marked.keys()??[];
    const covered=([i])=>game.visible[i]<0;
    const visibleRed=new Map([...redCells].map(i=>[i,confirmedInk(game,i)]).filter(covered));
    const layers=[['red',visibleRed],['blue',[...game.notes.layers.blue].filter(covered)]];
    const width=parseFloat(style.width), boardHeight=parseFloat(style.height);
    const key=JSON.stringify([w,width,boardHeight,tile,height,dx,dy,left,top,...layers.map(([,ink])=>[...ink])]);
    if(key===paintedInk) return;
    paintedInk=key;
    const center=i=>[left+i%w*dx,top+Math.floor(i/w)*dy];
    const paths=document.createDocumentFragment();
    const draw=(color,d,weight)=>{
      const path=document.createElementNS(inkDrawing.namespaceURI,'path');
      path.setAttribute('class',color);
      path.setAttribute('d',d);
      path.setAttribute('stroke-width',weight);
      paths.append(path);
    };
    const weight=Math.max(1.2,tile*.054);
    for(const [color,ink] of layers) {
      const lines=new Map();
      for(const [i,{symbol,level}] of ink) {
        if(symbol==='x') {
          const [x,y]=center(i), r=tile*(color==='blue'?.29:.36);
          draw(color,`M${x-r},${y-r}L${x+r},${y+r}M${x-r},${y+r}L${x+r},${y-r}`,weight);
        } else if(symbol==='/' || symbol==='//') {
          const group=symbol==='/'?0:level;
          if(!lines.has(group)) lines.set(group,[]);
          lines.get(group).push(i);
        }
      }
      for(const [rank,cells] of lines) for(const {cells:trail,closed} of inkTrails(cells,w)) {
        const points=trail.map(center);
        const overlaps=color==='blue' && !rank && trail.some(i=>visibleRed.get(i)?.symbol==='/');
        for(const shift of rank?[-tile*.09,tile*.09]:[overlaps?tile*.13:0]) {
          draw(color,inkPath(points,tile,shift,closed),weight*(rank?.78:1));
        }
      }
    }
    inkDrawing.setAttribute('viewBox',`0 0 ${width} ${boardHeight}`);
    inkDrawing.replaceChildren(paths);
  }
  function proofGeometry() {
    const root=$('board'), style=getComputedStyle(root);
    const columns=style.gridTemplateColumns.split(' ',2).map(parseFloat);
    const rows=style.gridTemplateRows.split(' ',2).map(parseFloat);
    if(columns.length<2 || rows.length<2) return null;
    const tile=columns[1], height=rows[1];
    const dx=tile+parseFloat(style.columnGap), dy=height+parseFloat(style.rowGap);
    const left=columns[0]+dx-tile/2, top=rows[0]+dy-height/2;
    const width=parseFloat(style.width), boardHeight=parseFloat(style.height);
    return Number.isFinite(left+top+dx+dy) ? {width,boardHeight,tile,height,dx,dy,left,top} : null;
  }

  function coefficientDepth(weight=1) {
    const magnitude=Math.abs(weight);
    return magnitude>1 ? .66*(magnitude-1)/(magnitude+1) : 0;
  }

  function paintProofAreas() {
    if(!activeAreaPreview || !game || !buttons.length) { proofDrawing.replaceChildren(); return; }
    const geo=proofGeometry();
    if(!geo) return;
    const {w,h}=game.board, {width,boardHeight,tile,height,dx,dy,left,top}=geo;
    const step=Math.min(tile,height);
    const grid={x:left-dx/2,y:top-dy/2,dx,dy,radius:Math.min(6,step*.16),inset:Math.min(1.75,step*.1)};
    const paths=document.createDocumentFragment();
    const {areas,weights}=activeAreaPreview;
    const append=(kind,d,parent=paths)=>{
      const path=document.createElementNS(proofDrawing.namespaceURI,'path');
      path.setAttribute('class',kind);
      path.setAttribute('d',d);
      path.setAttribute('fill-rule','evenodd');
      parent.append(path);
      return path;
    };
    for(const [i,kind] of proofKinds.entries()) {
      const cells=areas[i];
      if(!cells?.size) continue;
      const opposite={positive:2,negative:1,'selection-positive':5,'selection-negative':4}[kind];
      const d=regionSelection.contour(cells,w,h,grid,areas[opposite]);
      append(kind,d);
      if(weights?.size && kind!=='cancelled') {
        const shades=new Map();
        for(const cell of cells) {
          const magnitude=Math.abs(weights.get(cell)??1);
          if(magnitude<=1) continue;
          const x=grid.x+(cell%w)*dx, y=grid.y+Math.floor(cell/w)*dy;
          const square=`M${x},${y}H${x+dx}V${y+dy}H${x}Z`;
          shades.set(magnitude,(shades.get(magnitude)??'')+square);
        }
        if(shades.size) {
          // Clip the shading to the shared contour so adjacent weights do not create extra borders.
          const clip=document.createElementNS(proofDrawing.namespaceURI,'clipPath');
          const shading=document.createElementNS(proofDrawing.namespaceURI,'g');
          const clipId=`${kind}-clip`;
          clip.setAttribute('id',clipId);
          append('',d,clip).setAttribute('clip-rule','evenodd');
          shading.setAttribute('clip-path',`url(#${clipId})`);
          for(const [magnitude,squares] of shades) {
            append(`${kind}-shade`,squares,shading).setAttribute('fill-opacity',coefficientDepth(magnitude));
          }
          paths.append(clip,shading);
        }
      }
      if(kind==='element') append('element-hatch',d);
      append(`${kind} boundary`,d);
    }
    proofDrawing.setAttribute('viewBox',`0 0 ${width} ${boardHeight}`);
    proofDrawing.replaceChildren(proofPattern,paths);
  }

  new ResizeObserver(()=>{paintInk();paintProofAreas();}).observe($('board'));

  function render() {
    const {board,visible,flags,highlight,state,focus} = game;
    const first=new Set(board.opening), proofClues=new Set(highlight?.sources);
    const proofSafe=new Set(highlight?.safe), proofMines=new Set(highlight?.mines);
    let revealed=0;
    batchControls();
    for (const [i,b] of buttons.entries()) {
      const n = visible[i], mine=editing && !game.numbers && board.bombs[i];
      const marked = flags.has(i) || (!editing && state === 'won' && n < 0);
      const label = mine ? (marked?'雷，有旗':'雷') : n >= 0 ? (n || '空白') : marked ? '旗' : '未开';
      const marks = ['cell', n >= 0 ? 'open' : 'covered'];
      if (first.has(i)) marks.push('first');
      if (n > 0) marks.push(`n${n}`);
      if (marked) marks.push('flagged');
      if (mine) marks.push('edit-mine');
      if (proofClues.has(i) || activeSelectionClues.includes(i)) marks.push('clue');
      const answer=game.answers && game.judgment?.state[i];
      if (proofSafe.has(i) || answer==='safe') marks.push('target-safe');
      if (proofMines.has(i) || answer==='mine') marks.push('target-mine');
      let body = mine ? icon('mine')+(marked?`<span class="edit-flag">${icon('flag')}</span>`:'') : marked ? icon('flag') : n > 0 || n===0 && editing && game.numbers ? `<span class="cell-number">${n}</span>` : '';
      const confirmed=game.manual?.marked.get(i);
      const depth=coefficientDepth(highlight?.weights?.get(i));
      if(depth) b.style.setProperty('--hint-depth',`${depth*100}%`);
      else if(b.style.getPropertyValue('--hint-depth')) b.style.removeProperty('--hint-depth');
      const red=n<0?confirmedInk(game,i):undefined;
      const blue=n<0?game.notes.layers.blue.get(i):undefined;
      const archived=n<0?game.notes.layers.archivedBlue.get(i):undefined;
      if(blue) {
        if(blue.symbol!=='x') body+=inkGlyph(blue.symbol);
        if(blue.level>2) body+=`<sub class="ink-rank">${blue.level}</sub>`;
      }
      if(archived) body+=`<svg class="archived-note" viewBox="0 0 12 12" aria-hidden="true">${archived.symbol==='o'?'<circle cx="6" cy="6" r="4"/>':'<path d="M2 10L10 2"/>'}</svg>`;
      if (b.classList.contains('proof-preview')) marks.push('proof-preview');
      const opening=b.classList.contains('covered') && n>=0;
      const flagPlaced=b.classList.contains('cell') && marked && !b.classList.contains('flagged');
      if (b.className !== marks.join(' ')) b.className = marks.join(' ');
      if (b.dataset.body !== body) { b.innerHTML = body; b.dataset.body = body; }
      if(opening) feedback.tile('open',b,Math.min(revealed++*11,99));
      if(flagPlaced && !mine) feedback.visual('flag',b.querySelector('.icon'),65);
      b.tabIndex = i === focus ? 0 : -1;
      b.setAttribute('aria-label',`${coord(i)} ${label}${first.has(i) ? '，开局给出' : ''}${confirmed==='mine'?'，已确认有雷':confirmed==='safe'?'，已确认安全':red?`，红色笔记：${red.symbol==='x'?'雷':'安全'}`:''}${blue?`，蓝色 ${blue.symbol}${blue.level>1?` ${blue.level} 层`:''}`:''}${archived?`，绿色持久标${archived.symbol==='o'?'雷':'安全'}`:''}`);
    }
    $('remaining').textContent = !editing && state === 'won' ? '0' : board.mines-flags.size;
    $('totalMines').classList.toggle('clue-total', !!highlight?.sources.includes(-1));
    paintInk();
    time();
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
    const selection=selectionTargets.get(hoveredSelection??focusedSelection);
    const clues=proof?[]:selection?.clues??[];
    if(clues!==activeSelectionClues) {
      const hintClues=new Set(game?.highlight?.sources);
      for(const cell of activeSelectionClues) {
        if(!hintClues.has(cell)) buttons[cell]?.classList.remove('clue');
      }
      for(const cell of clues) buttons[cell]?.classList.add('clue');
      activeSelectionClues=clues;
    }
    const next=proof??selection?.preview??(selectionHistory.weights.size?selectionPreview():null);
    if(next===activeAreaPreview) return;
    for(const v of activeAreaPreview?.cells??[]) buttons[v]?.classList.remove('proof-preview');
    activeAreaPreview=next;
    for(const v of next?.cells??[]) buttons[v]?.classList.add('proof-preview');
    $('totalMines')?.classList.toggle('proof-hover',!!next?.total);
    paintProofAreas();
  }

  function clearProofHover() {
    pinnedProof?.setAttribute('aria-pressed','false');
    hoveredProof=focusedProof=pinnedProof=undefined;
    updateProofPreview();
  }

  function proofPreview(areas,total=false,weights) {
    return {areas:areas.map(vs=>new Set(vs)),cells:new Set(areas.flat()),total,weights};
  }

  function signedProofPreview(terms,weights) {
    const positive=terms.filter(term=>term.coefficient>0).flatMap(term=>term.cells);
    const negative=terms.filter(term=>term.coefficient<0).flatMap(term=>term.cells);
    return proofPreview([[],positive,negative],false,weights);
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

  function selectionTarget(target) {
    const token=target?.closest?.('.selection-token');
    return selectionReadout.contains(token)?token:undefined;
  }
  function updateSelectionHover(event,target) {
    if(event.pointerType!=='mouse') return;
    hoveredSelection=selectionTarget(target);
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
          ${makeRegionSelection.toString()}
          ${makeProofFormat.toString()}
          const engine=makeMinesEngine();
          const selection=makeRegionSelection(engine.adj);
          const format=makeProofFormat();
          onmessage=({data:{w,h,visible,known,weights,clueWeights}})=>{
            const regionVisible=visible.map((value,cell)=>known.has(cell)?0:value);
            const partition=cells=>format.regions(cells,w,h,regionVisible);
            const {terms}=selection.readout(weights,clueWeights,visible,engine.adj(w,h),known,
              rest=>selection.regionTerms(rest,w,known,partition));
            postMessage(terms.map(term=>({...term,label:term.clue===undefined
              ?format.label(term.cells,w,h,regionVisible):format.coordinate(term.clue,w)})));
          };`);
        worker.onmessage=({data:terms})=>{
          if(selectionExpressionJob!==job) return;
          selectionExpressionJob=undefined;
          renderSelectionTerms(terms);
        };
        worker.onerror=worker.onmessageerror=fail;
        worker.postMessage(data);
      } catch { fail(); }
    },0);
  }

  function updateSelectionReadout() {
    const known=game && selectionHistory.weights.size?selectionKnown():null;
    const {w,h,mines,ns}=game?.board??{};
    const visible=game?.visible, {clueWeights}=selectionHistory;
    const key=known?JSON.stringify([w,h,mines,visible,[...known],
      [...selectionHistory.weights],[...clueWeights]]):null;
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
      renderSelectionTerms([{...clue,label:format.coordinate(clue.clue,w)}]);
      return;
    }
    updateSelectionCount(known,weights);
    updateSelectionExpression({w,h,visible,known,weights,clueWeights});
  }

  function renderSelectionTerms(terms) {
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

  function setSelectionMode(mode='') {
    selectionMode=mode;
    $('selectionAdd').ariaPressed=String(mode==='add');
    $('selectionSubtract').ariaPressed=String(mode==='subtract');
    $('board').classList.toggle('selecting',!!mode);
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

  function selectBoardCell(i) {
    if(!selectionMode || !game || editing || game.state!=='playing') return false;
    if($('selectionMenu').disabled) return true;
    const clue=game.visible[i]>=0?i:undefined;
    const cells=regionSelection.unknown(clue===undefined?[i]:game.board.ns[clue],selectionKnown());
    const sign=selectionMode==='add'?1:-1;
    if(!selectionHistory.select(cells,clue,sign)) return true;
    buttons[game.focus].tabIndex=-1;
    game.focus=i;
    buttons[i].tabIndex=0;
    refreshSelection();
    feedback.sound('click');
    return true;
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

  function positionProofWindow() {
    if(!compactReason.matches || !proofVisible) return;
    const top=document.documentElement.dataset.fullscreenMode ? header.getBoundingClientRect().bottom+8 : 12;
    const minRoom=proofPane.querySelector('.panel-head').offsetHeight+24;
    const gap=10;
    const fan=$('reasonFlower').getBoundingClientRect();
    const focus=$('focus'), answers=$('answers');
    // Reserve the fully expanded fan, independent of its opening animation.
    const fanLeft=fan.left+parseFloat(focus.style.getPropertyValue('--x'))-focus.offsetWidth/2;
    const fanTop=fan.top+parseFloat(answers.style.getPropertyValue('--y'))-answers.offsetHeight/2;
    const aboveFan=fanTop-gap;
    const shortLandscape=window.innerHeight <= 500 && window.innerWidth > window.innerHeight;
    const tight=aboveFan-top<minRoom;
    const side=(shortLandscape && fanLeft>=230) || (tight && fanLeft>=170);
    // If neither placement fits, keep the controls above the scrollable proof.
    proofPane.classList.toggle('under-tools',tight && !side);
    proofPane.style.setProperty('--proof-right',side?`${window.innerWidth-fanLeft+gap}px`:'12px');
    const bottom=side?window.innerHeight-12:Math.max(top+minRoom,aboveFan);
    const rect=reasonSlot.getBoundingClientRect();
    const above=Math.min(bottom,rect.top-8)-top;
    const below=bottom-Math.max(top,rect.bottom+8);
    // Leave the current reasoning visible even when the page is scrolled to it.
    const useBelow=above<Math.min(180,(bottom-top)*.45) && below>above;
    const y=useBelow?Math.max(top,rect.bottom+8):top;
    const room=useBelow?below:above;
    // Leave room for the title and a scrollable strip on short screens.
    proofPane.style.setProperty('--proof-top',`${Math.min(y,Math.max(top,bottom-minRoom))}px`);
    proofPane.style.setProperty('--proof-room',`${Math.max(minRoom,room)}px`);
  }

  function syncReasonLayout() {
    const floating=compactReason.matches;
    if(floating && proofPane.parentElement!==viewport) viewport.append(proofPane);
    else if(!floating && proofPane.parentElement!==reasonContent) reasonContent.append(proofPane);
    proofPane.setAttribute('role',floating?'dialog':'region');
    reasonStatus.inert=reasonCollapsed || (!floating && proofVisible);
    proofPane.inert=!proofVisible || (!floating && reasonCollapsed);
    positionProofWindow();
  }
  compactReason.addEventListener('change',syncReasonLayout);
  window.addEventListener('resize',positionProofWindow);
  document.addEventListener('scroll',positionProofWindow,{capture:true,passive:true});
  new MutationObserver(positionProofWindow).observe(document.documentElement,{
    attributes:true,attributeFilter:['data-fullscreen-mode']
  });
  const proofPositionObserver=new ResizeObserver(positionProofWindow);
  proofPositionObserver.observe(reasonSlot);
  proofPositionObserver.observe(header);
  syncReasonLayout();
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
      game.highlight = null;
      if(game.selectedClues!==undefined) {
        game.selectedClues=undefined;
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
  function ready() { return !editing && game?.state === 'playing' && !worker; }

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
    if(!ready() || pending || auto) return;
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
    game.state = 'won'; game.ended = Date.now();
    stopAuto();
    say('通关 · 所有安全格已打开','success');
    feedback.sound('won');
  }

  function removeFlag(g,i) {
    g.flags.delete(i);
    g.verification=undefined;
    g.notes.discardRedo();
    g.manual?.refreshTargets();
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
      feedback.tile('rejected',buttons[result.wrong]);
      feedback.sound('rejected');
      const cell=coord(result.wrong);
      say(kind==='mine'?`无法插旗：${cell} 可能安全。`:`无法开格：${cell} 可能有雷。`,'rejected'); return;
    }
    for(const i of cells) feedback.clearRejection(buttons[i]);
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
    for(const i of added) feedback.tile('ink',buttons[i]);
    if(added.length) feedback.sound(!wasDone && g.manual.done?'ready':'ink');
  }

  async function commitBatch(g) {
    if(g!==game || !g.manual?.done || !ready() || pending) return false;
    dismissSearchResult();
    const task=run;
    const refreshProof=!auto&&proofVisible;
    const safe=g.manual.cells('safe'), mines=g.manual.cells('mine');
    const proven=new Set([...g.proven,...mines]);
    const flags=new Set([...g.flags,...mines]);
    for(const v of safe) flags.delete(v);
    if(safe.length) {
      say('正在开格并插旗…');
      const result=await ask('advance',{board:g.board,p:g.p,visible:g.visible,cells:safe,
        proven:new Set([...proven].filter(v=>flags.has(v))),flags,allowUnsolved:true,exact:true});
      if(task!==run || g!==game || !ready()) return false;
      if(!result?.board || !result.visible || !(result.opened>=safe.length)) {
        feedback.sound('rejected');
        say('未能更新棋盘，红色标记已保留。','error'); return false;
      }
      Object.assign(g,{board:result.board,visible:result.visible,opened:g.opened+result.opened,judgment:null});
      for(const i of result.cells??safe) flags.delete(i);
      discardOpenedMarks(g,result.cells??safe);
    }
    feedback.handoff(inkDrawing);
    g.proven=proven;
    g.flags=flags;
    discardOpenedMarks(g,safe);
    g.manual=null;
    g.notes.discardConfirmations();
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
    if (!ready() || auto || pending) return;
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

  function ask(kind,data) {
    if (!playWorker) {
      try { playWorker = background(`const engine = makeMinesEngine();
        onmessage = ({data:{kind,board,p,visible,proven,flags,cells,opening,allowUnsolved,exact,confirmed}}) => {
          try { postMessage(kind==='classify' ? engine.classify(p,visible,{nodeBudget:Infinity})
            : kind==='advance' ? engine.advance(board,p,visible,cells,proven,{allowUnsolved,exact,flags})
            : kind==='expand' ? engine.expand(board,visible,flags)
            : kind==='materialize' ? engine.publicBoard(p,visible)
            : engine.hint(p,visible,proven,flags,{opening,confirmed})); }
          catch { postMessage({status:'error'}); }
        };`); }
      catch { return Promise.resolve({status:'error'}); }
      const task = playWorker;
      function finish(result) {
        if (task !== playWorker || !pending) return;
        pending(result); pending = null; controls();
      }
      playWorker.onmessage = ({data}) => finish(data);
      playWorker.onerror = () => {
        if (task !== playWorker) return;
        finish({status:'error'}); task.terminate(); playWorker = null;
      };
    }
    return new Promise(resolve => {
      pending = resolve; controls();
      playWorker.postMessage({kind,...data});
    });
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

  function chip(indices, label, {clueRegion, description, weights, total = indices === -1} = {}) {
    const vs = indices === -1 ? [] : Array.isArray(indices) ? indices : [indices];
    const {w,h} = game.board;
    const text = label ?? (total ? '总雷数' : format.label(vs,w,h,game.visible));
    const button = element('button','proof-cell');
    button.type = 'button';
    if (clueRegion) {
      button.classList.add('clue-region');
      button.append(element('span','clue-coordinate',text));
    } else button.textContent = text;
    proofTargets.set(button,proofPreview([[],[],[],vs],total,weights));
    if (description) {
      button.title = description;
      button.setAttribute('aria-label',description);
    } else if (vs.length > 1) button.title = `${vs.length} 格的雷数`;
    button.onclick = () => {
      if (total) { $('totalMines')?.scrollIntoView({block:'nearest'}); return; }
      if (!buttons[vs[0]]) return;
      if (buttons[game.focus]) buttons[game.focus].tabIndex = -1;
      game.focus = vs[0];
      buttons[game.focus].tabIndex = 0;
      buttons[game.focus].focus();
    };
    return button;
  }

  function regionChips(vs,kind,weights) {
    const {w,h}=game.board;
    return format.regions(vs,w,h,game.visible).map(group=>{
      const text=format.label(group,w,h,game.visible);
      return chip(group,text,{description:`${text}：${group.length} 格${kind}`,weights});
    });
  }

  function cancellationChip(inputs, reflected=false) {
    const {cancelled,positive,negative,weights}=format.cancellation(inputs,reflected);
    if (!cancelled.length) return '';
    const preview=element('button','proof-cell cancellation-chip','相消');
    preview.type='button';
    preview.title=`灰纹：相消 ${cancelled.length} 格；紫：正项 ${positive.length} 格；黄：负项 ${negative.length} 格`;
    preview.setAttribute('aria-label',preview.title);
    proofTargets.set(preview,proofPreview([cancelled,positive,negative],false,weights));
    preview.setAttribute('aria-pressed','false');
    return preview;
  }

  function steps(batch,conclusionWeights=new Map()) {
    const list = element('ol','proof-steps'), rows = new Map(), emitted = new Map(), lines = [];
    list.setAttribute('role','list');
    const targets=new Map([...batch.safe.map(v=>[v,0]),...batch.mines.map(v=>[v,1])]);
    const covered=new Set();
    const visited = new Set();
    const gather = node => {
      if (visited.has(node)) return;
      visited.add(node);
      if (node.row) rows.set(node.row.source,node.row);
      else { gather(node.a); if (node.b) gather(node.b); }
    };
    for (const m of batch.proofs) {
      if (m.kind === 'count') rows.set(m.row.source,m.row);
      if (m.kind === 'difference') for (const row of [m.a,m.b]) rows.set(row.source,row);
      if (m.kind === 'resolution') for (const node of m.nodes) if (node.row) rows.set(node.row.source,node.row);
      if (m.inequality) gather(m.inequality);
    }
    const groups = engine.equivalentGroups([...rows.values()]);
    const ones = vs => vs.map(v => [v,1]);
    const rowNumbers = new Map();
    function equationNumber(id) {
      const number=element('span','equation-number',String(id));
      number.dataset.equation=String(id);
      return number;
    }
    function arithmetic(refs, reflected=false) {
      return format.referenceTerms(refs,reflected).flatMap(({id,operator,factor},i)=>{
        const term=element('span','equation-ref');
        term.append(factor,equationNumber(id));
        const prefix=operator ? `${i?' ':''}${operator}${i?' ':''}` : '';
        return [prefix,term];
      });
    }
    function chainRow(formula,operator,...parts) {
      const row=element('div','formula-chain-row');
      const expression=element('div','formula-chain-expression');
      expression.append(...parts);
      row.append(element('span','operator',operator),expression);
      formula.append(row);
    }
    function termElements(terms,weights,leadingPlus=false) {
      return terms.map(({coefficient,cells},i)=>{
        const token=element('span','formula-term');
        if(i || leadingPlus || coefficient<0) token.append(element('span','operator',coefficient<0?'−':'+'));
        if(Math.abs(coefficient)!==1) token.append(element('span','operator',`${Math.abs(coefficient)}·`));
        token.append(chip(cells,undefined,{weights}));
        return token;
      });
    }
    function appendDerived(formula,kind,terms,weights,note,refs) {
      const line=element('li',`proof-line conclusion-${kind}`);
      proofRows.set(line,signedProofPreview(terms,weights));
      const id=list.children.length+1, marker=equationNumber(id);
      marker.classList.add('equation-marker');
      const explanation=element('small','proof-note');
      explanation.append(...note);
      line.append(marker,formula,explanation);
      list.append(line);
      lines.push({keep:true,refs});
    }
    function appendMixed(terms,weights,constant,fresh,sourceId) {
      const a=terms.filter(term=>term.coefficient>0);
      const b=terms.filter(term=>term.coefficient<0).map(term=>({...term,coefficient:-term.coefficient}));
      if(fresh.some(([,value])=>value===1)) {
        const aResult=element('div','formula formula-chain');
        chainRow(aResult,'',...termElements(a,weights));
        chainRow(aResult,'=',String(constant),...termElements(b,weights,true));
        chainRow(aResult,'≥',String(constant));
        appendDerived(aResult,'mine',terms,weights,
          ['由 ',equationNumber(sourceId),`，减项非负，正项至多为 ${constant}`],[sourceId]);
      }
      if(fresh.some(([,value])=>value===0)) {
        const reversedTerms=terms.map(term=>({...term,coefficient:-term.coefficient}));
        const reversedWeights=new Map([...weights].map(([v,weight])=>[v,-weight]));
        const bResult=element('div','formula formula-chain');
        chainRow(bResult,'',...termElements(b,reversedWeights));
        chainRow(bResult,'=',...termElements(a,reversedWeights),element('span','operator',`− ${constant}`));
        chainRow(bResult,'≤','0');
        appendDerived(bResult,'safe',reversedTerms,reversedWeights,
          ['由 ',equationNumber(sourceId),`，正项至多为 ${constant}，减项非负，故为 0`],[sourceId]);
      }
    }
    function appendIsolation(raw,sign,rhs,cells,value,sourceId) {
      const {divisor,constant,terms,relation,bound,limit}=format.isolateConclusion(raw,sign,rhs,cells,value);
      const isolated=format.terms(terms,groups.map(group=>group.filter(v=>!cells.includes(v))));
      const signedTerms=[{cells,coefficient:divisor},
        ...isolated.map(term=>({...term,coefficient:-term.coefficient}))];
      const weights=new Map([...cells.map(v=>[v,divisor]),...terms.map(([v,c])=>[v,-c])]);
      const factor=divisor===1?'':`1/${divisor} × `;
      const formula=element('div','formula formula-chain');
      const exactLimit=limit%divisor===0?String(limit/divisor):`${limit}/${divisor}`;
      chainRow(formula,'',chip(cells,undefined,{weights}));
      chainRow(formula,relation,`${factor}(${constant}`,...termElements(isolated,weights,true),')');
      if(isolated.length) {
        const substitutions=isolated.map(({coefficient,cells})=>{
          const count=(coefficient>0)===(value===0)?cells.length:0;
          return `${coefficient<0?'−':'+'} ${Math.abs(coefficient)*count}`;
        });
        chainRow(formula,bound,`${factor}(${[constant,...substitutions].join(' ')})`);
        chainRow(formula,'=',exactLimit);
      } else {
        chainRow(formula,bound,exactLimit);
      }
      appendDerived(formula,value?'mine':'safe',signedTerms,weights,
        ['由 ',equationNumber(sourceId),`，雷数为 0 至 ${cells.length} 的整数`],[sourceId]);
    }
    function add(raw, sign, rhs, note, sourceRow) {
      const {key,flipped}=format.lineIdentity(raw,sign,rhs);
      if(emitted.has(key)) {
        const ref=emitted.get(key);
        return {...ref,reflected:ref.reflected!==(ref.flipped!==flipped)};
      }
      const fixed=format.fixedCells(raw,sign,rhs).filter(([v,value])=>targets.get(v)===value);
      const fresh=fixed.filter(([v])=>!covered.has(v));
      const {w,h}=game.board;
      const grouping=fresh.length ? format.conclusionGroups(raw,groups,w,h,game.visible) : groups;
      const {terms,sign:comparison,constant,constantFirst}=format.comparison(raw,sign,rhs,grouping);
      const weights=new Map(terms.flatMap(({cells,coefficient})=>cells.map(v=>[v,coefficient])));
      const mixed=sign==='=' && constant>0 && terms.some(t=>t.coefficient>0) && terms.some(t=>t.coefficient<0);
      const positiveCapacity=terms.reduce((sum,{coefficient,cells})=>sum+Math.max(0,coefficient)*cells.length,0);
      // When the positive side is at capacity, the subtracted side has to be zero.
      const mixedConclusion=mixed && fresh.length>0 && positiveCapacity===constant;
      const isolate=!mixedConclusion && fresh.some(([v])=>Math.abs(weights.get(v))>1);
      const expanded=mixedConclusion || isolate;
      const line=element('li','proof-line'), formula=element('div','formula');
      for(const [v,value] of fresh) {
        if(!expanded) line.classList.add(value?'conclusion-mine':'conclusion-safe');
        covered.add(v);
        if(Math.abs(weights.get(v))>1) conclusionWeights.set(v,weights.get(v));
      }
      const id=list.children.length+1;
      const marker=equationNumber(id);
      marker.classList.add('equation-marker');
      if (sourceRow) {
        formula.classList.add('clue-equation');
        const s=sourceRow.source, clueRegion=s>=0, name=clueRegion?coord(s):'全盘';
        const scope=clueRegion?`${name} 的邻域`:name;
        formula.append(chip(sourceRow.vs,name,{clueRegion,total:!clueRegion,
          description:`${scope}：${sourceRow.vs.length} 个格子计入本式`}),element('span','operator',`${sign} ${rhs}`));
      } else {
        if (constantFirst) formula.append(element('span','operator',`${constant} ${comparison}`));
        if (!terms.length) formula.append('0');
        formula.append(...termElements(terms,weights));
        if (!constantFirst) formula.append(element('span','operator',`${comparison} ${constant}`));
      }
      proofRows.set(line,signedProofPreview(terms,weights));
      line.append(marker,formula);
      if (note) {
        const small = element('small','proof-note');
        small.append(...(Array.isArray(note) ? note : [note]));
        line.append(small);
      }
      list.append(line);
      lines.push({keep:!expanded && fresh.length>0,refs:[...line.querySelectorAll('.proof-note [data-equation]')]
        .map(number=>Number(number.dataset.equation))});
      if(mixedConclusion) appendMixed(terms,weights,constant,fresh,id);
      if(isolate) {
        for(const value of [0,1]) {
          const sameValue=fresh.filter(([,fixedValue])=>fixedValue===value);
          const targetTerms=sameValue.map(([v])=>[v,weights.get(v)]);
          const targetCells=new Set(targetTerms.map(([v])=>v));
          const targetGroups=groups.map(group=>group.filter(v=>targetCells.has(v)));
          for(const {cells} of format.terms(targetTerms,targetGroups)) {
            appendIsolation(raw,sign,rhs,cells,value,id);
          }
        }
      }
      const ref={id,reflected:constantFirst,exact:comparison==='=',flipped};
      emitted.set(key,ref);
      return ref;
    }
    for (const row of rows.values()) {
      const shown = row.source < 0 ? game.board.mines : game.visible[row.source];
      const details=[];
      if (shown!==row.rhs) details.push(`扣除 ${shown-row.rhs} 个已知雷`);
      if ([...game.manual?.marked??[]].some(([v,kind])=>kind==='safe' &&
        (row.source<0 || game.board.ns[row.source].includes(v)))) details.push('已确认安全格计 0');
      rowNumbers.set(row.source,add(ones(row.vs),'=',row.rhs,details.join('，'),row).id);
    }
    for(const m of batch.proofs) {
    const saturated=m.kind==='linear' && m.slack===0;
    if(m.symmetric.every(v=>covered.has(v)) &&
      (!saturated || m.inequality.terms.every(([v])=>covered.has(v)))) continue;
    if (m.kind === 'difference') {
      const shared = new Set(m.shared);
      const capacity = row => row.vs.filter(v => !shared.has(v)).length;
      const a = rowNumbers.get(m.a.source), b = rowNumbers.get(m.b.source);
      const inside=m.vs.every(v => shared.has(v));
      if(!inside && (!capacity(m.a) || !capacity(m.b))) {
        const [large,small]=capacity(m.a)?[m.a,m.b]:[m.b,m.a];
        const note=[equationNumber(rowNumbers.get(large.source)),' − ',equationNumber(rowNumbers.get(small.source)),
          ' ',cancellationChip([ones(large.vs),small.vs.map(v=>[v,-1])])];
        add(ones(m.vs),'=',m.value ? m.vs.length : 0,note);
      } else {
        // A single bound saturates the target; the other direction is its capacity.
        const useLower=inside===Boolean(m.value);
        const bound=useLower
          ? add(ones(m.shared),'≥',m.low,['max(0, ',equationNumber(a),` − ${capacity(m.a)}, `,equationNumber(b),` − ${capacity(m.b)})`])
          : add(ones(m.shared),'≤',m.high,[`min(${m.shared.length}, `,equationNumber(a),', ',equationNumber(b),')']);
        if (!inside) {
          const row = m.vs.every(v => m.a.vs.includes(v)) ? a : b;
          add(ones(m.vs),m.value?'≥':'≤',m.value?m.lower:m.upper,
            [equationNumber(row),' − ',equationNumber(bound.id)]);
        }
      }
    } else if (m.kind === 'resolution') {
      const numbers = [];
      for (const n of m.nodes) {
        const terms = [...ones(n.positive),...n.negative.map(v => [v,-1])];
        const rhs=1-n.negative.length;
        if (n.row && terms.length===n.row.vs.length && (n.positive.length?n.row.rhs:-n.row.rhs)===rhs) {
          numbers.push(rowNumbers.get(n.row.source));
          continue;
        }
        const note = n.row ? [equationNumber(rowNumbers.get(n.row.source)),`，取区外${n.positive.length?'上':'下'}界`]
          : [equationNumber(numbers[n.from[0]]),'、',equationNumber(numbers[n.from[1]]),' 取整消去 ',chip(n.pivot)];
        numbers.push(add(terms,'≥',rhs,note).id);
      }
    } else if (m.inequality) {
      const inequality=format.simplifyInequality(m.inequality);
      const labels = new Map();
      const visit = r => {
        if (labels.has(r)) return labels.get(r);
        let ref;
        if (r.row) {
          ref={id:rowNumbers.get(r.row.source),k:r.k,exact:true};
        } else if (r.kind==='sum') {
          const parts=format.summands(r), refs=parts.map(visit);
          const sign=refs.every(ref=>ref.exact)?'=':'≤';
          const reflected=format.relation(sign,r.rhs).constantFirst;
          const note=[...arithmetic(refs,reflected),' ',cancellationChip(parts.map(part=>part.terms),reflected)];
          ref={...add(r.terms,sign,r.rhs,note),k:1};
        } else {
          const a=visit(r.a), reflected=format.relation('≤',r.rhs).constantFirst;
          const note=[...arithmetic([a],reflected),` ÷ 2，系数与常数${format.rounding(reflected)}`];
          ref={...add(r.terms,'≤',r.rhs,note),k:1};
        }
        labels.set(r,ref);
        return ref;
      };
      visit(inequality);
    }
    const group=m.symmetric.filter(v=>!m.vs.includes(v) && !covered.has(v));
    if(group.length) add(ones(group),'=',m.value?group.length:0,['与 ',chip(m.vs),' 等价']);
    }
    const numbering=new Map(format.usedLines(lines).map((id,i)=>[id,i+1]));
    for(const [i,line] of [...list.children].entries()) {
      if(!numbering.has(i+1)) line.remove();
      else for(const number of line.querySelectorAll('[data-equation]')) {
        number.textContent=String(numbering.get(Number(number.dataset.equation)));
      }
    }
    return list;
  }

  function display(a, weak) {
    if(!proofVisible) return;
    proofMode=weak?'focus':'hint';
    updateProofButtons();
    const panel=$('proof'), m=a.move;
    const selectedClues=m?.sources.length;
    if(game.selectedClues!==selectedClues) {
      game.selectedClues=selectedClues;
      showVerification();
    }
    clearProofHover();
    panel.replaceChildren();
    if (!m) {
      game.highlight = null;
      panel.textContent = a.status === 'confirmed' && game.manual?.done ? '本轮已标记完毕，可以开格并插旗。'
        : a.status === 'confirmed' ? '本轮已无新的确定格。'
        : a.status === 'error' ? '推理提示计算失败，请重试。'
        : a.status === 'minimum-unavailable' ? '本次未能完成最少线索验证。'
        : a.status === 'batch-unavailable' ? '本次未能为这组线索的全部结论写出技巧证明。' : '现有技巧未找到下一步。';
    } else {
      const sources=[...new Set([...a.prior.flatMap(p=>p.sources),...m.sources])];
      const safe=m.safe.filter(v=>!game.manual?.marked.has(v));
      const mines=m.mines.filter(v=>!game.manual?.marked.has(v) && !game.flags.has(v));
      const weights=new Map(), stepsList=weak?null:steps(m,weights);
      game.highlight = {sources,safe:weak?[]:safe,mines:weak?[]:mines,weights};
      const card=element('article','proof-card');
      const top=element('div','proof-top');
      top.append(element('h3','',weak?'相关线索':'本步结论'));
      if (!weak) {
        for(const [vs,kind,label] of [[safe,'safe','安全'],[mines,'mine','必雷']]) if(vs.length) {
          const targets=element('div',`proof-chips targets ${kind}`);
          targets.append(element('strong','target-label',label),...regionChips(vs,label,weights));
          top.append(targets);
        }
      }
      const body=element('div','proof-body'), clues=element('div','proof-chips clues');
      const tokens=ss=>ss.slice().sort((a,b)=>a-b).map(s=>chip(s,s<0?'总雷数':`${coord(s)} · ${game.visible[s]}`));
      clues.append(...tokens(weak?sources:m.sources));
      body.append(element('p','proof-caption',`最少 ${m.sources.length} 条线索`));
      if (weak) body.append(clues);
      if (!weak) {
        body.append(stepsList);
        if(a.prior.length) {
          const prior=element('div','proof-detail');
          const toggle=element('button','proof-detail-toggle','本步之前证实的旗子');
          toggle.type='button';
          toggle.setAttribute('aria-controls','priorProof');
          toggle.setAttribute('aria-expanded','false');
          const fold=element('div','prior-fold');
          fold.id='priorProof';
          fold.inert=true;
          const content=element('div','prior-content');
          toggle.onclick=()=>{
            fold.inert=!fold.inert;
            toggle.setAttribute('aria-expanded',String(!fold.inert));
          };
          fold.append(content);
          for(const p of a.prior) {
            const previousWeights=new Map(), previousSteps=steps(p,previousWeights);
            const targets=element('div','proof-chips targets mine');
            targets.append(element('strong','target-label','必雷'),...regionChips(p.mines,'必雷',previousWeights));
            content.append(targets,previousSteps);
          }
          prior.append(toggle,fold);
          body.append(prior);
        }
      }
      card.append(top,body);
      panel.append(card);
    }
    panel.scrollTop=0;
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
    if (!ready() || pending) return;
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
    if(!ready() || auto || pending && !proofRequest) return;
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
    if(!ready() || auto || pending) return;
    dismissSearchResult();
    clearSelection();
    if(mode) {
      if(!compactReason.matches && reasonCollapsed) setReasonCollapsed(false);
      proofMode=mode;
      proofReturn=trigger;
    }
    clearHint(!!mode || proofVisible);
    render();
    if(compactReason.matches && mode==='hint') $('closeProof').focus({preventScroll:true});
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
  }

  function layoutRadial(name) {
    const flower=$(`${name}Flower`),launcher=$(`${name}Menu`);
    const items=[...flower.querySelectorAll('.petal,.mark-option')].filter(item=>!item.hidden);
    if(!items.length) return;
    const dock=$('toolDock'), dockRect=dock.getBoundingClientRect();
    const dockButtonRect=button=>{
      const left=dockRect.left+button.offsetLeft, top=dockRect.top+button.offsetTop;
      const width=button.offsetWidth, height=button.offsetHeight;
      return {left,top,width,height,right:left+width,bottom:top+height};
    };
    const anchor=dockButtonRect(launcher);
    const viewport=document.documentElement;
    const originX=anchor.left+anchor.width/2, originY=anchor.top+anchor.height/2;
    const obstacles=[...dock.querySelectorAll('.launcher')].filter(item=>item!==launcher && !item.hidden).map(dockButtonRect);
    const kind=name==='reason'?'reason':name==='mark'&&!editing?'ring':name==='selection'?'selection':'fan';
    const positioned=radialLayout.arrange(items.map(item=>({item,width:item.offsetWidth,height:item.offsetHeight})),{
      width:viewport.clientWidth,height:viewport.clientHeight,originX,originY,obstacles,launcher:anchor,kind
    });
    // A fixed element's origin may include a reserved scrollbar gutter.
    const frame=flower.getBoundingClientRect(), style=getComputedStyle(flower);
    const [movingX=0,movingY=0]=style.translate.split(' ').map(value=>parseFloat(value)||0);
    const frameX=frame.left-movingX-parseFloat(style.left);
    const frameY=frame.top-movingY-parseFloat(style.top);
    flower.style.left=`${originX-frameX}px`;
    flower.style.top=`${originY-frameY}px`;
    for(const point of positioned.items) {
      point.item.style.setProperty('--x',`${point.x}px`);
      point.item.style.setProperty('--y',`${point.y}px`);
    }
    for(const element of [flower,launcher]) {
      element.style.setProperty('--menu-x',`${positioned.center.x}px`);
      element.style.setProperty('--menu-y',`${positioned.center.y}px`);
    }
    const track=flower.querySelector('.radial-track');
    if(track) {
      const mark=positioned.items;
      const launcherPoint={x:0,y:0};
      if(kind==='ring' || kind==='selection') {
        const id=kind==='ring'?'inkTrack':'selectionTrack';
        track.querySelector(`#${id}`).setAttribute('d',radialLayout.ringArcPath(mark));
      } else if(name==='reason') {
        track.querySelector('#reasonTrack')?.setAttribute('d',radialLayout.semicirclePath(mark));
      } else {
        const path=track.querySelector('path:not([id])')??track.querySelector('#redInkTrack');
        const ordered=radialLayout.orderAlongArc(mark,launcherPoint);
        path?.setAttribute('d',radialLayout.pathThrough(ordered,launcherPoint));
      }
      const coords=[[launcherPoint.x,launcherPoint.y],...positioned.items.map(point=>[point.x,point.y])];
      const xs=coords.map(point=>point[0]),ys=coords.map(point=>point[1]);
      const left=Math.min(...xs)-12,top=Math.min(...ys)-12,width=Math.max(...xs)-left+12,height=Math.max(...ys)-top+12;
      track.setAttribute('viewBox',`${left} ${top} ${width} ${height}`);
      track.style.left=`${left}px`;track.style.top=`${top}px`;track.style.width=`${width}px`;track.style.height=`${height}px`;
      track.style.transformOrigin=`${-left}px ${-top}px`;
    }
  }

  let radialLayoutFrame=0;
  const refreshOpenRadials=()=>{
    cancelAnimationFrame(radialLayoutFrame);
    radialLayoutFrame=requestAnimationFrame(()=>{
      for(const name of ['mark','selection','reason']) if(!$(`${name}Flower`).inert) layoutRadial(name);
    });
  };
  addEventListener('resize',refreshOpenRadials);
  window.visualViewport?.addEventListener('resize',refreshOpenRadials);

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
    syncReasonLayout();
  }

  function setReasonCollapsed(collapsed, focus=false) {
    if(collapsed && !compactReason.matches) clearProofHover();
    reasonCollapsed=collapsed;
    reasonLayout.classList.toggle('reason-collapsed',collapsed);
    openReasonPanel.inert=!collapsed;
    openReasonPanel.setAttribute('aria-expanded',String(!collapsed));
    syncReasonLayout();
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
    $('gameMode').setAttribute('aria-pressed',String(!next));
    $('editMode').setAttribute('aria-pressed',String(next));
    $('settings').hidden=next;
    if(next) setRadial('selection',false);
    $('selectionMenu').hidden=next;
    for(const id of ['editorSettings','editTools','playPosition']) $(id).hidden=!next;
  }

  function copyPosition(g) {
    const position=seeds.decode(seeds.encode(g));
    position.notes[1]=[...g.notes.layers.blue];
    position.notes[2]=[...g.notes.layers.archivedBlue];
    return position;
  }

  function mountDraft(position) {
    draft=position;
    $('editWidth').value=position.board.w;
    $('editHeight').value=position.board.h;
    $('draftMines').max=position.visible.length;
    $('draftMines').value=position.board.mines;
    draftMinesValid=true;
    $('mineTools').hidden=position.numbers;
    $('numberTools').hidden=!position.numbers;
    for(const button of $('editTools').querySelectorAll('[data-draft]')) button.setAttribute('aria-pressed',String((button.dataset.draft==='numbers')===position.numbers));
    mount(position);
  }

  function switchMode(next) {
    if(editing===next || worker || pending || auto) return;
    if(next) {
      let position=draft;
      if(!position) try {
        const w=$('width').valueAsNumber, h=$('height').valueAsNumber;
        position=positionGame(game ? copyPosition(game) : seeds.dimensionsOk(w,h) ? seeds.create(w,h) :
          seeds.create(Number($('width').defaultValue),Number($('height').defaultValue)));
      } catch(error) {say(error instanceof RangeError?'浏览器无法分配此棋盘，请缩小尺寸。':error.message,'error');return;}
      parkedGame=game;
      setMode(next); mountDraft(position);
    } else {setMode(next);draftMinesValid=true;mount(parkedGame);}
    say('');
  }

  function resizeDraft(blank) {
    if(!editing || pending) return;
    try { resizeDraftTo(readDimensions('editWidth','editHeight'),blank); }
    catch(error) {say(error instanceof RangeError?'浏览器无法分配此棋盘，请缩小尺寸。':error.message,'error');}
  }

  function resizeDraftTo({w,h},blank) {
    const old=game.board, translate=i=>{
      const x=i%old.w, y=Math.floor(i/old.w);
      return x<w && y<h ? y*w+x : -1;
    };
    const bits=Array(w*h).fill(0);
    if(!blank) for(let i=0;i<old.bombs.length;i++) {
      const at=translate(i);
      if(at>=0) bits[at]=Number(old.bombs[i])+2*Number(game.visible[i]>=0)+4*Number(game.flags.has(i));
    }
    let next;
    if(game.numbers) {
      const digits=Array(w*h).fill('.'), flags=[];
      if(!blank) for(const [i,n] of game.visible.entries()) {
        const at=translate(i);
        if(at<0) continue;
        if(n>=0) digits[at]=String(n);
        else if(game.flags.has(i)) flags.push(at);
      }
      next=seeds.numbers(w,h,blank?0:Math.min(old.mines,w*h),digits.join(''),flags);
    } else next=seeds.create(w,h,bits.join(''));
    if(!blank) next.notes=noteColors.map(color=>[...game.notes.layers[color]].flatMap(([i,note])=>{
      const at=translate(i);
      return at>=0 ? [[at,note]] : [];
    }));
    mountDraft(positionGame(next));
    say(blank?'已新建空白局面。':'已调整棋盘尺寸。');
  }

  function editCell(i,marking=false,value=digit) {
    if(!editing || pending) return;
    const g=game, {board:b}=g, n=g.visible[i], tool=marking?'flag':g.numbers?'number':editTool;
    g.focus=i;
    if(tool==='flag') {
      if(n>=0) {feedback.sound('click');return;}
      const removed=g.flags.delete(i);
      if(!removed) g.flags.add(i);
      feedback.sound(removed?'erase':'flag');
      refreshDraftMarks();
      render(); return;
    }
    if(tool==='number') {
      if(n===value) {feedback.sound('click');return;}
      g.visible[i]=value;
      feedback.sound(value<0?'erase':'ink');
    } else if(tool==='mine') {
      b.bombs[i]=!b.bombs[i];
      feedback.sound(b.bombs[i]?'ink':'erase');
      const delta=b.bombs[i]?1:-1;
      b.mines+=delta; g.p.mines=b.mines;
      if(b.bombs[i]) g.visible[i]=-1;
      for(const v of b.ns[i]) {
        b.clues[v]+=delta;
        if(g.visible[v]>=0) g.visible[v]=b.clues[v];
      }
      boardSize();
    } else if(b.bombs[i]) {feedback.sound('rejected');say('有雷的格子不能设为已开。','error');return;}
    else {
      if(n>=0) g.visible[i]=-1;
      else engine.reveal(b,g.visible,i,g.flags);
      feedback.sound(n>=0?'erase':'open');
    }
    if(n<0 && g.visible[i]>=0) discardOpenedMarks(g,g.visible.flatMap((value,cell)=>value>=0?[cell]:[]));
    b.opening=g.visible.flatMap((v,at)=>v>=0?[at]:[]);
    b.first=b.opening[0]??0;
    g.opened=g.visible.filter(value=>value>=0).length;
    g.verification=g.current=g.witness=undefined;
    scheduleVerification(); render(); say('');
  }

  function discardOpenedMarks(g,cells) {
    if(!cells.length) return;
    input.endStroke();
    for(const i of cells) g.flags.delete(i);
    g.notes.discardCells(cells);
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
    if(!parkedGame) return;
    mountDraft(positionGame(copyPosition(parkedGame)));
    say('已复制当前游戏局面。');
  };
  $('editTools').onclick=e=>{
    const mode=e.target.closest('[data-draft]')?.dataset.draft;
    if(mode) {
      if((mode==='numbers')===game.numbers) return;
      const {w,h,mines}=game.board;
      if(mode==='numbers') {
        const position=seeds.numbers(w,h,mines,game.visible.map(n=>n<0?'.':n).join(''),[...game.flags]);
        position.notes=noteColors.map(color=>[...game.notes.layers[color]]);
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
    draftMinesValid=Number.isInteger(value) && value>=0 && value<=game.visible.length;
    if(draftMinesValid) game.board.mines=game.p.mines=value;
    game.witness=game.current=game.verification=undefined;
    boardSize(); render(); scheduleVerification(); controls();
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
    if(!editing || pending || $('playPosition').disabled) return;
    try {
      const g=await prepareGame(copyPosition(game),undefined,game.witness);
      setMode(false);
      parkedGame=undefined;
      mount(g);
      say('已将编辑局面载入游戏。','success');
    } catch(error) {say(error.message,'error');}
  };
  $('expandPosition').onclick=async()=>{
    const g=game;
    if(!g || g.current?.status!=='blocked' || pending || worker || auto) return;
    const board=g.numbers?g.witness:g.board;
    if(!board) return;
    dismissSearchResult();
    const result=await ask('expand',{board,visible:g.visible,flags:editing?[]:g.flags});
    if(g!==game) return;
    if(result?.status!=='expanded') {say('未能确定最少开扩格数，局面未改变。','error');return;}
    g.manual=null;
    g.notes.discardConfirmations();
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
    if(!dialog.open || dialog.classList.contains('is-closing') || button.hidden || seedImport || pending) return;
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

  const input = makeBoardInput({$,icon,say,sound:feedback.sound,canAct:()=>!!game && !worker && !pending && !auto && (editing || ready()),getGame:()=>game,changed:(cells,kind)=>{
    if(game) {
      dismissSearchResult();
      if(editing) refreshDraftMarks();
      render();
      if(cells.length) feedback.tile(editing?'ink':'blue',buttons[cells.at(-1)]);
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
  $('cancel').onclick = () => { finishWorker(); saySearch(`已取消生成。${game ? '当前棋局已保留。' : ''}`); };
  $('useCandidate').onclick = () => {
    if(!generationCandidate) return;
    const candidate=generationCandidate, wasSearching=!!worker;
    finishWorker();
    const {text,shortfall}=generationProgress(candidate.progress,candidate.report);
    const message=wasSearching?'已停止搜索并采用候选。':'已采用候选。';
    mountGenerated(candidate,candidate.p,`${message}${text}`,shortfall);
    $('board').querySelector('[tabindex="0"]')?.focus({preventScroll:true});
  };
  $('restart').onclick = async () => {
    if (!game || worker || pending && !auto) return;
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
    if (!ready() || auto || pending) return;
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
    focusedSelection=selectionTarget(e.target);
    updateProofPreview();
  });
  selectionReadout.addEventListener('focusout',e=>{
    focusedSelection=selectionTarget(e.relatedTarget);
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
  let flagDrag, inkDrag, skipDragClick=false;
  board.addEventListener('touchstart',e=>{
    if(input.writing && e.target.closest('[data-cell]')) e.preventDefault();
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
    if(!ready() || pending || auto || !$('markFlower').inert) return;
    const from=game.flags.has(i)?i:undefined;
    if(game.visible[i]<0 && from===undefined) return;
    flagDrag={id:e.pointerId,x:e.clientX,y:e.clientY,from,game};
  });
  board.addEventListener('pointermove',e=>{
    if(inkDrag?.id===e.pointerId) {moveInk(e);return;}
    const drag=flagDrag;
    if(drag?.id!==e.pointerId || drag.game!==game) return;
    if(!drag.ghost) {
      if(!e.buttons || Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<8) return;
      // 越过拖动阈值后再捕获指针，让直接点按仍落在原格子上。
      dismissSearchResult();
      board.setPointerCapture(e.pointerId);
      drag.ghost=element('span','drag-flag');
      drag.ghost.innerHTML=icon('flag');
      drag.ghost.setAttribute('aria-hidden','true');
      viewport.append(drag.ghost);
    }
    drag.ghost.style.transform=`translate(${e.clientX}px,${e.clientY}px) translate(-50%,-50%)`;
  });
  function stopFlagDrag(e,drop=false) {
    const drag=flagDrag;
    if(drag?.id!==e.pointerId) return;
    flagDrag=null;
    if(!drag.ghost) return;
    drag.ghost.remove();
    skipDragClick=true;
    if(!drop || drag.game!==game || !ready() || pending || auto || input.writing) return;
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
    if(e.detail && skipDragClick) {skipDragClick=false;return;}
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
      if(inkDrag) return;
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
      case 'ArrowDown': if(i+w<buttons.length) n+=w; break;
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
    game.focus=n; buttons[i].tabIndex=-1; buttons[n].tabIndex=0; buttons[n].focus();
  });
  setInterval(time,250);
  controls();
})();
