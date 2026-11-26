(() => {
  'use strict';
  const engine = makeMinesEngine();
  const format = makeProofFormat();
  const seeds = makePositionSeeds(engine.adj);
  const $ = id => document.getElementById(id);
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
  let game, worker, auto = false, run = 0, buttons = [];
  let editing=false, parkedGame, draft, editTool='mine';
  let digit=1, draftMinesValid=true;
  let playWorker, pending;
  let verificationWorker, verificationTimer;
  let draftMarkJob, draftMarkJudgment;
  const proofKinds=['cancelled','positive','negative','element'];
  const proofTargets=new WeakMap(), proofRows=new WeakMap();
  let hoveredProof, focusedProof, pinnedProof;
  let activeProofRow;
  let activeAreaPreview = null;

  const say = (text, tone = '') => { $('status').textContent = text; $('status').dataset.tone = tone; };
  const icon = id => `<svg class="icon" aria-hidden="true"><use href="#${id}"/></svg>`;
  const coord = i => format.coordinate(i,game.board.w);
  const source = s => s === -1 ? '总雷数' : coord(s);

  function batchControls() {
    const batch=game?.manual, complete=!!batch?.done, live=ready();
    const locked = auto || !!pending;
    const commit=$('commitMarks');
    const canCommit=live && complete;
    if(!canCommit && document.activeElement===commit) commit.parentElement.focus({preventScroll:true});
    commit.classList.toggle('is-inactive',!canCommit);
    commit.setAttribute('aria-hidden',String(!canCommit));
    commit.disabled=locked || !canCommit;
    const progress=$('roundProgress');
    const showProgress=live && !!batch?.marked.size;
    progress.classList.toggle('is-inactive',!showProgress);
    progress.setAttribute('aria-hidden',String(!showProgress));
    progress.max=batch?.total || 1;
    progress.value=batch?.marked.size || 0;
    progress.toggleAttribute('data-complete',complete);
    const text=$('roundText');
    const message=!showProgress?'':`本轮已确认 ${batch.marked.size} / ${batch.total} 格${complete?'，可以开格并插旗。':''}`;
    if(text.textContent!==message) text.textContent=message;
    text.hidden=!showProgress;
    text.toggleAttribute('data-complete',complete);
    // 标齐后，求解一步直接提交这一批；未标齐时才执行下一条推导。
    $('apply').disabled = locked || !live;
  }

  function controls() {
    const live = game?.state === 'playing', locked = !!worker || auto || !!pending;
    for (const id of fields) $(id).disabled = !!worker;
    $('generate').disabled = !!worker || !!pending && !auto;
    const cancel=$('cancel'), canCancel=!!worker;
    cancel.classList.toggle('is-inactive',!canCancel);
    cancel.setAttribute('aria-hidden',String(!canCancel));
    cancel.disabled=!canCancel;
    for (const id of ['gameMode','editMode','importPosition']) $(id).disabled = locked;
    $('exportPosition').disabled = locked || !game;
    $('playPosition').disabled = locked || !game || game.board.mines===game.visible.length || !!(game.numbers && !game.witness);
    $('draftMines').disabled=locked;
    $('exportPosition').disabled ||= editing && !draftMinesValid;
    $('expandPosition').disabled=locked;
    batchControls();
    for (const control of $('editorSettings').elements) control.disabled = locked;
    $('copyGamePosition').disabled = locked || !parkedGame;
    for (const button of $('editTools').querySelectorAll('button')) button.disabled = locked;
    $('reasonMenu').classList.toggle('is-inactive',editing);
    $('restart').hidden = editing;
    $('gameTime').hidden = editing;
    $('board').setAttribute('aria-busy',String(!!pending));
    for (const id of ['focus', 'hint', 'answers']) $(id).disabled = locked || !live;
    $('reasonMenu').disabled = editing || !game || !!worker;
    $('markMenu').disabled = !game || !!worker || !!pending || auto || !editing && !live;
    $('restart').disabled = !!worker || !!pending && !auto || !game;
    $('solve').disabled = !!worker || !live || (!!pending && !auto);
    $('solve').innerHTML = auto ? `${icon('stopIcon')}停止求解` : `${icon('play')}自动求解`;
    $('reasonMenu').innerHTML=icon(auto?'stopIcon':'hintIcon');
    $('reasonMenu').title=auto?'停止求解':'推理工具';
    $('reasonMenu').setAttribute('aria-label',$('reasonMenu').title);
    $('answers').setAttribute('aria-pressed',String(!!game?.answers));
    $('answers').querySelector('span').textContent = game?.answers ? '隐藏答案' : '展示答案';
  }

  function showDifficultyDefaults() {
    for (const [id,value] of Object.entries(engine.difficultyDefaults())) {
      $(id).placeholder=`默认 ${value}${id==='minMultiPercent'?'%':''}`;
    }
  }

  function generationProgress({tried,passed,closest,target}) {
    const progress=`已搜索 ${tried} 轮 · ${passed} 局通过技巧验证`;
    if(!closest) return progress;
    const {average, multiPercent, peak}=closest;
    const metrics=[['平均线索',average,target.average,''],['多线索步骤',multiPercent,target.multiPercent,'%'],
      ['峰值线索',peak,target.peak,'']];
    const display=(value,suffix)=>`${Number(value.toFixed(2))}${suffix}`;
    const summary=metrics.map(([name,actual,,suffix])=>`${name} ${display(actual,suffix)}`).join('、');
    const missing=metrics.filter(([,actual,goal])=>actual<goal).map(([name,,goal,suffix])=>`${name}需 ≥ ${goal}${suffix}`).join('、');
    return `${progress}。最接近候选：${summary}。${missing ? `未达标：${missing}。` : ''}`;
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
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    return {p: {w,h,minAverage,minMultiPercent,minPeakClues}, seed};
  }

  function cancelPlayRequest() {
    if (!pending) return;
    playWorker.terminate(); playWorker = null;
    pending(null); pending = null;
  }

  function stopAuto() {
    if (auto && proofVisible && proofPanel.querySelector('.proof-pending')) clearHint();
    auto = false; run++;
    cancelPlayRequest();
    controls();
  }
  function finishWorker() { worker?.terminate(); worker = null; controls(); }

  function background(code) {
    const url = URL.createObjectURL(new Blob([`${makeMinesEngine.toString()}\n${code}`],{type:'text/javascript'}));
    try { return new Worker(url); }
    finally { URL.revokeObjectURL(url); }
  }

  function generate(e) {
    e?.preventDefault();
    if (worker || pending && !auto) return;
    let job;
    try { job = readSettings(); } catch (error) { say(error.message, 'error'); return; }
    stopAuto();
    try { worker = background(`onmessage = ({data:{p,seed}}) => {
        try {
          let updated = -Infinity, reportedCandidate = false;
          for (const result of makeMinesEngine().generate(p,seed)) {
            if (result.board) { postMessage({result}); return; }
            const now = performance.now();
            if (now - updated >= 200 || result.closest && !reportedCandidate) {
              postMessage({progress:result});
              updated = now;
              reportedCandidate ||= !!result.closest;
            }
          }
        }
        catch (error) { postMessage({error:error.message}); }
      };`); }
    catch { say('浏览器无法启动生成任务。请用 Edge 或 Chrome 打开本页。', 'error'); return; }
    controls();
    say('正在构造开局');
    const task = worker;
    worker.onmessage = ({data}) => {
      if (task !== worker) return;
      if (data.progress) {
        say(generationProgress(data.progress));
        return;
      }
      finishWorker();
      if (data.error) { say(`本次生成中止：${data.error}`, 'error'); return; }
      const r = data.result;
      if (!r.report.openingMinimum) { say('没有通过首步最少线索验证，未发放该局。','error'); return; }
      const position=positionGame({board:r.board},job.p);
      position.openingVerification=verificationSummary(r.report);
      mount(position);
      say(`三项难度达标 · 技巧通关验证通过 · 搜索 ${r.tried} 轮`, 'success');
    };
    worker.onerror = () => {
      if (task !== worker) return;
      finishWorker(); say(`生成任务无法运行。${game ? '当前棋局已保留。' : ''}`, 'error');
    };
    worker.postMessage(job);
  }

  const noteColors=['red','blue','archivedBlue'];

  function positionGame({board,visible=engine.opening(board),flags=[],notes=[],numbers=false},p={}) {
    const opened=visible.filter(n=>n>=0).length;
    const history=makeMarkHistory();
    for (const [i,color] of noteColors.entries()) {
      for(const [cell,mark] of notes[i]??[]) history.layers[color].set(cell,
        color==='red' && mark.symbol==='s'?{...mark,symbol:'/'}:mark);
    }
    return {board,original:board,originalVisible:visible,originalFlags:[...flags],originalNotes:notes,p:{...p,w:board.w,h:board.h,mines:board.mines},
      numbers,visible,flags:new Set(flags),notes:history,proven:new Set(),opened,
      state:opened===visible.length-board.mines?'won':'playing',started:null,ended:null,highlight:null,focus:board.first,
      judgment:null,answers:false};
  }

  function mount(position) {
    stopAuto();
    game=position;
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
    const weight=Math.max(1.2,Math.min(3,tile*.067));
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
    return Number.isFinite(left+top+dx+dy) ? {root,width,boardHeight,tile,dx,dy,left,top} : null;
  }

  function paintProofAreas() {
    if(!activeAreaPreview || !game || !buttons.length) { proofDrawing.replaceChildren(); return; }
    const geo=proofGeometry();
    if(!geo) return;
    const {w,h}=game.board, {width,boardHeight,tile,dx,dy,left,top}=geo;
    const gapX=Math.max(0,dx-tile), gapY=Math.max(0,dy-tile);
    const originX=left-tile/2-gapX/2, originY=top-tile/2-gapY/2;
    const point=([x,y])=>[originX+x*dx,originY+y*dy];
    const edgeKey=(x,y)=>`${x},${y}`;
    const boundaryLoops=cells=>{
      const set=new Set(cells), edges=[];
      for(const i of set) {
        const x=i%w,y=Math.floor(i/w);
        if(y===0 || !set.has(i-w)) edges.push({x,y,d:0});
        if(x===w-1 || !set.has(i+1)) edges.push({x:x+1,y,d:1});
        if(y===h-1 || !set.has(i+w)) edges.push({x:x+1,y:y+1,d:2});
        if(x===0 || !set.has(i-1)) edges.push({x,y:y+1,d:3});
      }
      const outgoing=new Map();
      edges.forEach((edge,index)=>{
        const key=edgeKey(edge.x,edge.y), list=outgoing.get(key)??[];
        list.push(index); outgoing.set(key,list);
      });
      const used=new Set(), loops=[];
      for(let start=0;start<edges.length;start++) {
        if(used.has(start)) continue;
        const first=edges[start], ring=[[first.x,first.y]];
        let edgeIndex=start, closed=false;
        while(!used.has(edgeIndex)) {
          used.add(edgeIndex);
          const edge=edges[edgeIndex];
          const x=edge.x+(edge.d===0?1:edge.d===2?-1:0);
          const y=edge.y+(edge.d===1?1:edge.d===3?-1:0);
          ring.push([x,y]);
          const candidates=outgoing.get(edgeKey(x,y))??[];
          if(!candidates.length) break;
          // At a diagonal contact take the left turn, joining the two cells.
          edgeIndex=candidates.find(i=>(edges[i].d-edge.d+4)%4===3)??candidates[0];
          if(edgeIndex===start) {closed=true;break;}
        }
        if(closed && ring.length>=5) loops.push(ring);
      }
      return loops;
    };
    const roundedPath=ring=>{
      const walk=ring.slice(0,-1);
      const points=walk.filter(([x,y],i)=>{
        const [px,py]=walk[(i+walk.length-1)%walk.length], [nx,ny]=walk[(i+1)%walk.length];
        return x-px!==nx-x || y-py!==ny-y;
      }).map(point);
      if(points.length<4) return '';
      const radius=tile*.18;
      const toward=(p,q,d)=>{const length=Math.hypot(q[0]-p[0],q[1]-p[1])||1;return [p[0]+(q[0]-p[0])*d/length,p[1]+(q[1]-p[1])*d/length];};
      const corners=points.map((p,i)=>({p,start:toward(p,points[(i+points.length-1)%points.length],radius),end:toward(p,points[(i+1)%points.length],radius)}));
      let d=`M${corners[0].start[0]},${corners[0].start[1]}`;
      for(let i=0;i<corners.length;i++) {
        const corner=corners[i], next=corners[(i+1)%corners.length];
        d+=`Q${corner.p[0]},${corner.p[1]} ${corner.end[0]},${corner.end[1]}L${next.start[0]},${next.start[1]}`;
      }
      return d+'Z';
    };
    const paths=document.createDocumentFragment();
    for(const [i,kind] of proofKinds.entries()) {
      const cells=activeAreaPreview.areas[i];
      if(!cells?.size) continue;
      const rings=boundaryLoops(cells).map(roundedPath).filter(Boolean);
      const path=(cls,d)=>{
        const outline=document.createElementNS(proofDrawing.namespaceURI,'path');
        outline.setAttribute('class',cls);
        outline.setAttribute('d',d);
        outline.setAttribute('fill-rule','evenodd');
        paths.append(outline);
      };
      path(kind,rings.join(''));
      if(kind==='element') path('element-hatch',rings.join(''));
      for(const d of rings) path(`${kind} boundary`,d);
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
      if (proofClues.has(i)) marks.push('clue');
      const answer=game.answers && game.judgment?.state[i];
      if (proofSafe.has(i) || answer==='safe') marks.push('target-safe');
      if (proofMines.has(i) || answer==='mine') marks.push('target-mine');
      let body = mine ? icon('mine')+(marked?`<span class="edit-flag">${icon('flag')}</span>`:'') : marked ? icon('flag') : n > 0 || n===0 && editing && game.numbers ? `<span class="cell-number">${n}</span>` : '';
      const confirmed=game.manual?.marked.get(i);
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
  }

  function updateProofPreview() {
    const target=hoveredProof??focusedProof??pinnedProof;
    const row=target?.closest('.proof-line');
    if(row!==activeProofRow) {
      activeProofRow?.classList.remove('proof-active');
      row?.classList.add('proof-active');
      activeProofRow=row;
    }
    const next=(proofTargets.get(target)??proofRows.get(target))??null;
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

  function proofPreview(areas,total=false) {
    return {areas:areas.map(vs=>new Set(vs)),cells:new Set(areas.flat()),total};
  }

  const proofPanel=$('proof');
  const reasonSlot=proofPanel.closest('.reason-slot');
  const reasonLayout=reasonSlot.parentElement;
  const reasonContent=reasonSlot.querySelector('.reason-content');
  const proofPane=$('proofPane'), reasonStatus=$('reasonStatus');
  const openReasonPanel=$('openReasonPanel');
  const header=viewport.querySelector('header');
  const compactReason=matchMedia('(max-width: 760px), (pointer: coarse) and (max-width: 1000px)');
  let proofVisible=false, reasonCollapsed=false, proofReturn;

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
    const row=includeRow && target?.closest?.('.proof-line');
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
      hoveredProof=focusedProof=undefined;
    }
    if(pinnedProof?.classList.contains('cancellation-chip')) pinnedProof.setAttribute('aria-pressed','false');
    pinnedProof=pinnedProof===target?undefined:target;
    if(pinnedProof?.classList.contains('cancellation-chip')) pinnedProof.setAttribute('aria-pressed','true');
    updateProofPreview();
  },true);

  function clearHint(keepProof=false) {
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
    const g=game;
    g.answers=!g.answers; controls(); render();
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
    if(!g.manual) return;
    const updated=makeManualBatch(g.judgment.state,g.flags,engine.confirmationTargets);
    for(const kind of ['mine','safe']) updated.record(g.manual.cells(kind),kind);
    g.manual=updated;
  }

  async function recordManual(g,cells,kind,from) {
    const task=run;
    if(g.judgment?.status!=='complete') say('正在核对当前局面…');
    const judgment=await judge(g);
    if(task!==run || g!==game || !ready()) return;
    if(judgment?.status!=='complete') {
      say(judgment?.status==='invalid'?'当前线索互相矛盾。':'未能核对当前局面。','error'); return;
    }
    const batch=g.manual??makeManualBatch(judgment.state,g.flags,engine.confirmationTargets);
    const added=cells.filter(i=>!batch.marked.has(i));
    const wasDone=batch.done;
    const result=batch.record(cells,kind);
    if(result.wrong!==undefined) {
      feedback.tile('rejected',buttons[result.wrong]);
      feedback.sound('rejected');
      const cell=coord(result.wrong);
      say(kind==='mine'?`无法插旗：${cell} 可能安全。`:`无法开格：${cell} 可能有雷。`,'rejected'); return;
    }
    for(const i of cells) feedback.clearRejection(buttons[i]);
    g.manual=batch;
    if(from!==undefined) removeFlag(g,from);
    showMarks(g,added.filter(i=>batch.marked.has(i)),wasDone);
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
    const task=run;
    const safe=g.manual.cells('safe'), mines=g.manual.cells('mine');
    const proven=new Set([...g.proven,...mines]);
    const flags=new Set([...g.flags,...mines]);
    for(const v of safe) flags.delete(v);
    if(safe.length) {
      say('正在开格并插旗…');
      const result=await ask('advance',{board:g.board,p:g.p,visible:g.visible,cells:safe,
        proven:new Set([...proven].filter(v=>flags.has(v))),flags,allowUnsolved:true,exact:true});
      if(task!==run || g!==game || !ready()) return false;
      if(result?.opened!==safe.length) {
        say('未能更新棋盘，红色标记已保留。','error'); return false;
      }
      Object.assign(g,{board:result.board,visible:result.visible,opened:g.opened+result.opened,judgment:null});
    }
    feedback.handoff(inkDrawing);
    g.proven=proven;
    g.flags=flags;
    discardOpenedMarks(g,safe);
    g.manual=null;
    g.current=g.verification=undefined; scheduleVerification();
    const won=g.opened===g.visible.length-g.board.mines;
    clearHint(auto && !won && proofVisible);
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
    } else if(marking && g.flags.has(i)) {
      removeFlag(g,i);
      g.current=undefined; scheduleVerification();
      say(`已撤销 ${coord(i)} 的旗子。`);
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

  function chip(indices, label, {clueRegion, description} = {}) {
    const vs = Array.isArray(indices) ? indices : [indices];
    const {w,h} = game.board;
    const text = label ?? (vs[0] === -1 ? '总雷数' : format.label(vs,w,h,game.visible));
    const button = element('button','proof-cell',text);
    button.type = 'button';
    if (clueRegion) button.classList.add('clue-region');
    const total = vs[0] === -1;
    proofTargets.set(button,proofPreview([[],[],[],total?[]:vs],total));
    if (description) {
      button.title = description;
      button.setAttribute('aria-label',description);
    } else if (vs.length > 1) button.title = `${vs.length} 格的雷数`;
    button.onclick = () => {
      if (total) { $('totalMines').scrollIntoView({block:'nearest'}); return; }
      buttons[game.focus].tabIndex = -1;
      game.focus = vs[0];
      buttons[game.focus].tabIndex = 0;
      buttons[game.focus].focus();
    };
    return button;
  }

  function regionChips(vs,kind) {
    const {w,h}=game.board;
    return format.regions(vs,w,h,game.visible).map(group=>{
      const text=format.label(group,w,h,game.visible);
      return chip(group,text,{description:`${text}：${group.length} 格${kind}`});
    });
  }

  function cancellationChip(inputs, reflected=false) {
    const {cancelled,positive,negative}=format.cancellation(inputs,reflected);
    if (!cancelled.length) return '';
    const preview=element('button','proof-cell cancellation-chip','相消');
    preview.type='button';
    preview.title=`灰纹：相消 ${cancelled.length} 格；紫：正项 ${positive.length} 格；黄：负项 ${negative.length} 格`;
    preview.setAttribute('aria-label',preview.title);
    proofTargets.set(preview,proofPreview([cancelled,positive,negative]));
    preview.setAttribute('aria-pressed','false');
    return preview;
  }

  function steps(batch) {
    const list = element('ol','proof-steps'), rows = new Map(), emitted = new Map(), lines = [];
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
      const line = element('li','proof-line'), formula = element('div','formula');
      for(const [v,value] of fresh) {
        line.classList.add(value?'conclusion-mine':'conclusion-safe');
        covered.add(v);
      }
      const id=list.children.length+1;
      const marker=equationNumber(id);
      marker.classList.add('equation-marker');
      if (sourceRow) {
        const s=sourceRow.source, clueRegion=s>=0, name=clueRegion?coord(s):'全盘';
        const scope=clueRegion?`${name} 的邻域`:name;
        formula.append(chip(sourceRow.vs,name,{clueRegion,
          description:`${scope}：${sourceRow.vs.length} 个格子计入本式`}),element('span','operator',`${sign} ${rhs}`));
      } else {
        terms.sort((a,b)=>Number(b.coefficient>0)-Number(a.coefficient>0));
        if (constantFirst) formula.append(element('span','operator',`${constant} ${comparison}`));
        if (!terms.length) formula.append('0');
        for (const [i,{coefficient,cells}] of terms.entries()) {
          const token = element('span','formula-term');
          if (i || coefficient < 0) token.append(element('span','operator',coefficient < 0 ? '−' : '+'));
          if (Math.abs(coefficient) !== 1) token.append(element('span','operator',`${Math.abs(coefficient)}·`));
          token.append(chip(cells));
          formula.append(token);
        }
        if (!constantFirst) formula.append(element('span','operator',`${comparison} ${constant}`));
      }
      const displayedAreas = [
        [],
        terms.filter(term=>term.coefficient>0).flatMap(term=>term.cells),
        terms.filter(term=>term.coefficient<0).flatMap(term=>term.cells)
      ];
      proofRows.set(line,proofPreview(displayedAreas));
      line.append(marker,formula);
      if (note) {
        const small = element('small','proof-note');
        small.append(...(Array.isArray(note) ? note : [note]));
        line.append(small);
      }
      list.append(line);
      lines.push({keep:fresh.length>0,refs:[...line.querySelectorAll('.proof-note [data-equation]')]
        .map(number=>Number(number.dataset.equation))});
      const ref={id,reflected:constantFirst,exact:comparison==='=',flipped};
      emitted.set(key,ref);
      return ref;
    }
    for (const row of rows.values()) {
      const shown = row.source < 0 ? game.board.mines : game.visible[row.source];
      const clue = chip(row.source,`${source(row.source)} · ${shown}`);
      const note = [clue,shown === row.rhs ? '' : ` − ${shown-row.rhs} 雷`];
      if ([...game.manual?.marked??[]].some(([v,kind])=>kind==='safe' &&
        (row.source<0 || game.board.ns[row.source].includes(v)))) note.push('，已确认安全格计 0');
      rowNumbers.set(row.source,add(ones(row.vs),'=',row.rhs,note,row).id);
    }
    for(const m of batch.proofs) {
    if(m.symmetric.every(v=>covered.has(v))) continue;
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
    const panel=$('proof'), m=a.move;
    clearProofHover();
    panel.replaceChildren();
    if (!m) {
      game.highlight = null;
      panel.textContent = a.status === 'confirmed' ? '本轮已无新的确定格。'
        : a.status === 'error' ? '推理提示计算失败，请重试。'
        : a.status === 'minimum-unavailable' ? '本次未能完成最少线索验证。'
        : a.status === 'batch-unavailable' ? '本次未能为这组线索的全部结论写出技巧证明。' : '现有技巧未找到下一步。';
    } else {
      const sources=[...new Set([...a.prior.flatMap(p=>p.sources),...m.sources])];
      const safe=m.safe.filter(v=>!game.manual?.marked.has(v));
      const mines=m.mines.filter(v=>!game.manual?.marked.has(v) && !game.flags.has(v));
      game.highlight = {sources,safe:weak?[]:safe,mines:weak?[]:mines};
      const card=element('article','proof-card');
      const top=element('div','proof-top');
      top.append(element('h3','',weak?'相关线索':'本步结论'));
      if (!weak) {
        for(const [vs,kind,label] of [[safe,'safe','安全'],[mines,'mine','必雷']]) if(vs.length) {
          const targets=element('div',`proof-chips targets ${kind}`);
          targets.append(element('strong','target-label',label),...regionChips(vs,label));
          top.append(targets);
        }
      }
      const body=element('div','proof-body'), clues=element('div','proof-chips clues');
      const tokens=ss=>ss.slice().sort((a,b)=>a-b).map(s=>chip(s,s<0?'总雷数':`${coord(s)} · ${game.visible[s]}`));
      clues.append(...tokens(weak?sources:m.sources));
      body.append(element('p','proof-caption',`最少 ${m.sources.length} 条线索`));
      if (weak) body.append(clues);
      if (!weak) {
        body.append(steps(m));
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
            const targets=element('div','proof-chips targets mine');
            targets.append(element('strong','target-label','必雷'),...regionChips(p.mines,'必雷'));
            content.append(targets,steps(p));
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
    display(a,false);
    if(!a.move) return false;
    const judgment=await judge(g);
    if(task!==run || g!==game || !ready()) return false;
    if(judgment?.status!=='complete') {say('未能核对当前局面。','error');return false;}
    const {safe,mines}=a.move;
    if(safe.some(v=>judgment.state[v]!=='safe') || mines.some(v=>judgment.state[v]!=='mine')) {
      say('推导未通过核对，红色标记未改变。','error');return false;
    }
    g.manual??=makeManualBatch(judgment.state,g.flags,engine.confirmationTargets);
    const added=[...safe,...mines].filter(i=>!g.manual.marked.has(i));
    const wasDone=g.manual.done;
    g.manual.record(safe,'safe'); g.manual.record(mines,'mine');
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
    auto = true;
    const task=++run, g=game;
    if(!proofVisible) {
      showPendingProof();
      setProofVisible(true);
    }
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

  async function requestHint(show, trigger, selectStep=false) {
    if (!ready() || auto || pending) return;
    if (!compactReason.matches && reasonCollapsed) setReasonCollapsed(false);
    const task = run;
    proofReturn=trigger;
    clearHint(true); render();
    if(compactReason.matches && trigger===$('hint')) $('closeProof').focus({preventScroll:true});
    const a = await next();
    if (task === run && ready() && a && (!selectStep || proofVisible)) {
      if(selectStep && a.move) {
        game.selectedClues=a.move.sources.length;
        showVerification();
      }
      show(a);
    }
  }

  function showReason(open,focus=false) {
    if(open) input.close();
    setRadial('reason',open);
    if(focus) $(open?'closeReason':'reasonMenu').focus({preventScroll:true});
  }

  function setRadial(name,open) {
    const flower=$(`${name}Flower`), launcher=$(`${name}Menu`);
    flower.inert=!open;
    flower.classList.toggle('expanded',open);
    launcher.setAttribute('aria-expanded',String(open));
  }

  function setProofVisible(visible) {
    if(!visible && proofPane.contains(document.activeElement)) focusProofReturn();
    proofVisible=visible;
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
      if(n>=0) return;
      if(!g.flags.delete(i)) g.flags.add(i);
      refreshDraftMarks();
      render(); return;
    }
    if(tool==='number') {
      if(n===value) return;
      g.visible[i]=value;
    } else if(tool==='mine') {
      b.bombs[i]=!b.bombs[i];
      const delta=b.bombs[i]?1:-1;
      b.mines+=delta; g.p.mines=b.mines;
      if(b.bombs[i]) g.visible[i]=-1;
      for(const v of b.ns[i]) {
        b.clues[v]+=delta;
        if(g.visible[v]>=0) g.visible[v]=b.clues[v];
      }
      boardSize();
    } else if(b.bombs[i]) {say('有雷的格子不能设为已开。','error');return;}
    else {
      g.visible[i]=n>=0?-1:b.clues[i];
    }
    if(n<0 && g.visible[i]>=0) discardOpenedMarks(g,[i]);
    b.opening=g.visible.flatMap((v,at)=>v>=0?[at]:[]);
    b.first=b.opening[0]??0;
    g.opened=b.opening.length;
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
    for(const item of $('editTools').querySelectorAll('button')) item.setAttribute('aria-pressed',String(item===button));
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
    const result=await ask('expand',{board,visible:g.visible,flags:editing?[]:g.flags});
    if(g!==game) return;
    if(result?.status!=='expanded') {say('未能确定最少开扩格数，局面未改变。','error');return;}
    g.manual=null;
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

  const input = makeBoardInput({$,icon,say,canAct:()=>!!game && !worker && !pending && !auto && (editing || ready()),getGame:()=>game,changed:i=>{
    if(game) {
      if(editing) refreshDraftMarks();
      render(); feedback.tile(editing?'ink':'blue',buttons[i]); feedback.sound('ink');
    }
  },
    menu:setRadial,closeReason:()=>showReason(false)});
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
  $('cancel').onclick = () => { finishWorker(); say(`已取消生成。${game ? '当前棋局已保留。' : ''}`); };
  $('restart').onclick = async () => {
    if (!game || worker || pending && !auto) return;
    stopAuto();
    const {original,p,originalVisible,originalFlags,originalNotes}=game;
    try {
      mount(await prepareGame({board:original,visible:originalVisible,flags:originalFlags,notes:originalNotes},p));
      say(game.state === 'won' ? '首开通关 · 所有安全格已打开' : '已恢复原始开局。');
    } catch(error) {say(error.message,'error');}
  };
  $('focus').onclick = () => requestHint(a=>display(a,true),$('focus'),true);
  $('hint').onclick = () => requestHint(a=>display(a,false),$('hint'),true);
  $('apply').onclick = () => {
    if (!ready() || auto || pending) return;
    if (manualStepAction(game?.manual)==='commit') void commitBatch(game);
    else void requestHint(stageStep,$('apply'));
  };
  $('commitMarks').onclick = () => {if(!auto) void commitBatch(game);};
  $('solve').onclick = solve;
  $('answers').onclick = toggleAnswers;
  $('reasonMenu').onclick = ()=>{if(auto) pauseSolve();else showReason($('reasonFlower').inert,true);};
  $('closeReason').onclick = ()=>showReason(false,true);
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
    if(input.writing) {
      if(input.startStroke(i)) {
        inkDrag={id:e.pointerId,x:e.clientX,y:e.clientY,spacing:Math.max(1,cell.offsetWidth/4)};
        skipDragClick=true;
        board.setPointerCapture(e.pointerId);
        cell.focus({preventScroll:true});
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
      // Keep taps on the original cell; capture only after a drag starts.
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
    } else if(!game.flags.has(i)) {
      clearHint(); game.focus=i;
      void recordManual(game,[i],'mine',drag.from);
    }
  }
  document.addEventListener('pointerup',e=>{stopInk(e,true);stopFlagDrag(e,true);});
  document.addEventListener('pointercancel',e=>{stopInk(e);stopFlagDrag(e);});
  board.addEventListener('lostpointercapture',e=>{if(e.target===board) {stopInk(e);stopFlagDrag(e);}});
  board.addEventListener('click',e=>{
    if(e.detail && skipDragClick) {skipDragClick=false;return;}
    const b=e.target.closest('[data-cell]'); if(!b) return;
    const i=Number(b.dataset.cell);
    if(input.stamp(i)) return;
    (editing?editCell:play)(i,e.shiftKey);
  });
  board.addEventListener('contextmenu',e=>{
    const b=e.target.closest('[data-cell]'); if (b) {
      e.preventDefault();
      if(inkDrag) return;
      const i=Number(b.dataset.cell);
      if(input.erase(i)) return;
      (editing?editCell:play)(i,true);
    }
  });
  board.addEventListener('keydown',e=>{
    const b=e.target.closest('[data-cell]'); if (!b || !game) return;
    const i=Number(b.dataset.cell), w=game.board.w;
    if(editing && game.numbers && (/^[0-8]$/.test(e.key) || ['Delete','Backspace'].includes(e.key))) {
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
        if(!input.writing) (editing?editCell:play)(i,true);
        return;
      default: return;
    }
    e.preventDefault(); game.focus=n; buttons[i].tabIndex=-1; buttons[n].tabIndex=0; buttons[n].focus();
  });
  setInterval(time,250);
  controls();
})();
