(() => {
  'use strict';
  const engine = makeMinesEngine();
  const format = makeProofFormat();
  const seeds = makePositionSeeds(engine.adj);
  const $ = id => document.getElementById(id);
  const inkDrawing=document.createElementNS('http://www.w3.org/2000/svg','svg');
  inkDrawing.classList.add('board-ink');
  inkDrawing.setAttribute('aria-hidden','true');
  let paintedInk='';
  const fields = ['width', 'height', 'minAverage', 'minMultiPercent', 'minPeakClues'];
  let game, worker, auto = false, run = 0, buttons = [];
  let editing=false, parkedGame, draft, editTool='mine';
  let digit=1, draftMinesValid=true;
  let playWorker, pending;
  let ratingWorker, ratingTimer;
  const proofAreaClasses = ['proof-cancelled','proof-positive','proof-negative'];
  let clearAreaPreview;

  const say = (text, tone = '') => { $('status').textContent = text; $('status').dataset.tone = tone; };
  const icon = id => `<svg class="icon" aria-hidden="true"><use href="#${id}"/></svg>`;
  const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
  const animate=(node,frames,options)=>{if(!reducedMotion.matches) node.animate(frames,options);};
  const coord = i => format.coordinate(i,game.board.w);
  const source = s => s === -1 ? '总雷数' : coord(s);

  function batchControls() {
    const complete = !!game?.manual?.done, live = ready();
    const locked = auto || !!pending;
    $('commitMarks').hidden = !live || !complete;
    $('commitMarks').disabled = locked;
    $('apply').disabled = locked || !live || complete;
  }

  function controls() {
    const live = game?.state === 'playing', locked = !!worker || auto || !!pending;
    for (const id of fields) $(id).disabled = !!worker;
    $('generate').disabled = !!worker;
    $('cancel').hidden = !worker;
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
    $('toolDock').hidden = editing;
    $('restart').hidden = editing;
    $('gameTime').hidden = editing;
    $('board').setAttribute('aria-busy',String(!!pending));
    for (const id of ['focus', 'hint', 'answers']) $(id).disabled = locked || !live;
    for (const id of ['reasonMenu','markMenu']) $(id).disabled = !game || !!worker;
    $('restart').disabled = !!worker || !game;
    $('solve').disabled = !!worker || !live || (!!pending && !auto);
    $('solve').innerHTML = auto ? `${icon('stopIcon')}停止求解` : `${icon('play')}自动求解`;
    $('reasonMenu').innerHTML=icon(auto?'stopIcon':'hintIcon');
    $('reasonMenu').title=auto?'停止求解':'推理工具';
    $('reasonMenu').setAttribute('aria-label',$('reasonMenu').title);
    $('answers').setAttribute('aria-pressed',String(!!game?.answers));
    $('answers').querySelector('span').textContent = game?.answers ? '隐藏答案' : '展示答案';
  }

  function showDifficultyDefaults() {
    const sizes=['width','height'].map(id=>$(id).valueAsNumber);
    const valid=sizes.every(n=>Number.isInteger(n) && n>=2 && n<=24) && sizes.some(n=>n>=3);
    for (const [id,value] of Object.entries(engine.difficultyDefaults(...sizes))) {
      $(id).placeholder=valid?`默认 ${value}${id==='minMultiPercent'?'%':''}`:'';
    }
  }

  function readSettings() {
    const integer = (id, lo, hi, name) => {
      const v = $(id).valueAsNumber;
      if (!Number.isInteger(v) || v < lo || v > hi) { $(id).focus(); throw Error(`${name}须为 ${lo}–${hi} 的整数。`); }
      return v;
    };
    const optional = (id, condition, error) => {
      const input = $(id), v = input.valueAsNumber;
      if (input.value === '' && !input.validity.badInput) return undefined;
      if (Number.isFinite(v) && condition(v)) return v;
      $('difficultySettings').open = true;
      input.focus(); throw Error(error);
    };
    const w = integer('width', 2, 24, '宽度'), h = integer('height', 2, 24, '高度');
    if (w===2 && h===2) throw Error('2 × 2 的每格都与其余三格相邻，有雷时无法推出下一格安全。请将至少一边设为 3 或更大。');
    const minAverage = optional('minAverage', v=>v>=1, '平均最少线索下限须至少为 1。');
    const minMultiPercent = optional('minMultiPercent', v=>v>=0 && v<=100, '多线索步骤占比须为 0–100%。');
    const minPeakClues = optional('minPeakClues', v=>Number.isSafeInteger(v) && v>=1, '峰值线索数下限须为正整数。');
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    return {p: {w,h,minAverage,minMultiPercent,minPeakClues}, seed};
  }

  function stopAuto() {
    auto = false; run++;
    if (pending) {
      playWorker.terminate(); playWorker = null;
      pending(null); pending = null;
    }
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
    if (worker) return;
    let job;
    try { job = readSettings(); } catch (error) { say(error.message, 'error'); return; }
    stopAuto();
    try { worker = background(`onmessage = ({data:{p,seed}}) => {
        try {
          let updated = -Infinity;
          for (const result of makeMinesEngine().generate(p,seed)) {
            if (result.board) { postMessage({result}); return; }
            const now = performance.now();
            if (now - updated >= 200) { postMessage({progress:result}); updated = now; }
          }
        }
        catch (error) { postMessage({error:error.message}); }
      };`); }
    catch { say('浏览器无法启动生成任务。请用 Edge 或 Chrome 打开本页。', 'error'); return; }
    controls();
    say(`正在构造开局 · 种子 ${job.seed}`);
    const task = worker;
    worker.onmessage = ({data}) => {
      if (task !== worker) return;
      if (data.progress) {
        const {tried,passed,closest}=data.progress;
        const rating=closest ? ` · 最接近：平均 ${closest.averageClues.toFixed(2)} 条 / 多线索 ${stepShare(closest)} / 峰值 ${closest.clues} 条` : '';
        say(`种子 ${job.seed} · 已搜索 ${tried} 轮 · ${passed} 局通过技巧验证${rating}`);
        return;
      }
      finishWorker();
      if (data.error) { say(`本次生成中止：${data.error}`, 'error'); return; }
      const r = data.result;
      if (!r.report.openingMinimum) { say('没有通过首步最少线索验证，未发放该局。','error'); return; }
      install(r.board, job.p, r.report, job.seed);
      say(`三项难度达标 · 技巧通关验证通过 · 搜索 ${r.tried} 轮`, 'success');
    };
    worker.onerror = () => {
      if (task !== worker) return;
      finishWorker(); say(`生成任务无法运行。${game ? '当前棋局已保留。' : ''}`, 'error');
    };
    worker.postMessage(job);
  }

  const stepShare=report=>`${(100*report.advancedDensity).toFixed(1)}%（${report.multiSteps}/${report.steps} 步）`;

  function positionGame({board,visible=engine.opening(board),flags=[],notes=[[],[]],numbers=false},p={},report,seed) {
    const opened=visible.filter(n=>n>=0).length;
    const history=makeMarkHistory();
    for (const [i,color] of ['red','blue'].entries()) history.layers[color]=new Map(notes[i]);
    return {board,original:board,originalFlags:[...flags],originalNotes:notes,p:{...p,w:board.w,h:board.h,mines:board.mines},
      seed,numbers,visible,flags:new Set(flags),notes:history,proven:new Set(),opened,
      state:opened===visible.length-board.mines?'won':'playing',started:null,ended:null,highlight:null,focus:board.first,
      judgment:null,answers:false,rating:report,ratingScope:'开局',initialRating:report};
  }

  function install(board,p,report,seed) {
    mount(positionGame({board},p,report,seed));
  }

  function mount(position) {
    stopAuto();
    clearProofHover();
    game=position;
    if(game) game.highlight=null;
    input.reset(); showReason(false);
    $('proof').textContent = '';
    $('proofPane').hidden = true;
    $('routeRating').open = !!position?.rating;
    $('generationSeed').hidden = game?.seed==null || editing;
    $('generationSeedValue').textContent = game?.seed??'';
    $('boardSeed').textContent = game?.seed==null || editing ? '' : `开局给出 ${game.original.opening.length} 格 · 评级 v${engine.version}`;
    scheduleRating();
    const root = $('board');
    $('emptyBoard').hidden = !!game;
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
    const grid = [axis(''),...Array.from({length:board.w},(_, i)=>axis(String.fromCharCode(65+i)))];
    for (let y = 0; y < board.h; y++) grid.push(axis(y+1),...buttons.slice(y*board.w,(y+1)*board.w));
    root.replaceChildren(...grid,inkDrawing);
    render(); controls();
  }

  function boardSize() {
    const {board}=game;
    $('size').textContent = `${board.w} × ${board.h} · `;
    const total = document.createElement('span'); total.id = 'totalMines'; total.textContent = `${board.mines} 雷`;
    $('size').append(total);
  }

  function ratingStatus(report) {
    if(report.status==='passed') return report.steps ? '无猜验证通过' : '所有安全格已开';
    return ({stuck:'技巧推导卡住，未证实无猜可解','minimum-unavailable':'未能证实最少线索','batch-unavailable':'未能证实完整推导',
      invalid:'局面无效', 'no-safe-cell':'局面至少需要一个安全格', error:'验证未完成'})[report.status]??'验证未完成';
  }

  function showRating() {
    const report=game?.rating;
    const current=game?.current;
    const count=n=>n==null?'—':`${current.partial?'≥ ':''}${n}`;
    const texts={deducible:current?.clues?'有确定结论':'有确定结论，尚无可展示的最少线索推导',blocked:'无可解格',
      invalid:'数字与总雷数互相矛盾',budget:'尚未完成验证',finished:'所有安全格已开',error:'验证未完成',
      'invalid-total':'请输入有效的总雷数','no-safe-cell':'局面至少需要一个安全格'};
    $('currentStatus').textContent=game?(current?texts[current.status]:'正在验证当前线索…'):'暂无棋局';
    $('rating').dataset.state=current?.status??'';
    $('currentSafe').textContent=count(current?.safe);
    $('currentMines').textContent=count(current?.mines);
    $('currentClues').textContent=current?.clues??'—';
    $('expandPosition').hidden=current?.status!=='blocked' || !!(game.numbers && !game.witness);
    const rated=report?.steps>0;
    const scope=editing?'当前局面':game?.ratingScope;
    $('ratingStatus').textContent=game?`${scope} · ${report?ratingStatus(report):game.numbers?'按可行排雷布局预览':'正在验证剩余解法…'}`:'暂无棋局';
    $('openingClues').textContent = rated && report.openingMinimum ? `${report.openingClues} 条` : '—';
    $('openingDepth').textContent = rated ? report.openingDepth : '—';
    $('openingRecursive').textContent = !rated ? '—' : !report.openingRecursiveComplete ? '未完成'
      : report.openingRecursiveMin===report.openingRecursive ? report.openingRecursive : `${report.openingRecursiveMin}–${report.openingRecursive}`;
    $('bottlenecks').textContent = rated ? report.bottlenecks : '—';
    $('clueCount').textContent = rated ? report.clues : '—';
    $('averageClues').textContent = rated && report.status==='passed' ? `${report.averageClues.toFixed(2)} 条` : '—';
    $('averageEnumerationDepth').textContent = !rated || report.averageEnumerationDepth==null ? '—' : report.averageEnumerationDepth.toFixed(2);
    $('multiDensity').textContent = rated && report.status==='passed' ? stepShare(report) : '—';
  }

  function time() {
    $('time').textContent = game?.started == null ? '0' : String(Math.floor(((game.ended ?? Date.now()) - game.started)/1000));
  }

  function confirmedInk(g,i) {
    const kind=g.manual?.marked.get(i);
    return kind?{symbol:kind==='mine'?'x':'/',level:0}:g.notes.layers.red.get(i);
  }

  function paintInk() {
    if(!game || !buttons.length) return;
    const {w}=game.board, root=$('board'), style=getComputedStyle(root);
    const [axis,tile]=style.gridTemplateColumns.split(' ').map(parseFloat);
    const [axisY,height]=style.gridTemplateRows.split(' ').map(parseFloat);
    const dx=tile+parseFloat(style.columnGap),dy=height+parseFloat(style.rowGap);
    const left=axis+dx-tile/2, top=axisY+dy-height/2;
    if(!Number.isFinite(left+top)) return;
    const layers=[['red',new Map(game.notes.layers.red)],['blue',game.notes.layers.blue]];
    for(const i of game.manual?.marked.keys()??[]) layers[0][1].set(i,confirmedInk(game,i));
    const {width,height:boardHeight}=root.getBoundingClientRect();
    const key=JSON.stringify([w,width,boardHeight,tile,height,dx,dy,left,top,...layers.map(([,ink])=>[...ink])]);
    if(key===paintedInk) return;
    paintedInk=key;
    const center=i=>[left+i%w*dx,top+Math.floor(i/w)*dy];
    const paths=[];
    const draw=(color,d,weight)=>{
      const path=document.createElementNS(inkDrawing.namespaceURI,'path');
      path.setAttribute('class',color);
      path.setAttribute('d',d);
      path.setAttribute('stroke-width',weight);
      paths.push(path);
    };
    const weight=Math.max(1.2,Math.min(3,tile*.067));
    for(const [color,ink] of layers) {
      const lines=new Map();
      for(const [i,{symbol,level}] of ink) {
        if(symbol==='x') {
          const [x,y]=center(i), r=tile*(color==='red'?.36:.29);
          draw(color,`M${x-r},${y-r}L${x+r},${y+r}M${x-r},${y+r}L${x+r},${y-r}`,weight);
        } else if(symbol==='/' || symbol==='//') {
          const group=symbol==='/'?0:level;
          if(!lines.has(group)) lines.set(group,[]);
          lines.get(group).push(i);
        }
      }
      for(const [rank,cells] of lines) for(const {cells:trail,closed} of inkTrails(cells,w)) {
        const points=trail.map(center);
        const overlaps=color==='blue' && !rank && trail.some(i=>layers[0][1].get(i)?.symbol==='/');
        for(const shift of rank?[-tile*.09,tile*.09]:[overlaps?tile*.13:0]) {
          draw(color,inkPath(points,tile,shift,closed),weight*(rank?.78:1));
        }
      }
    }
    inkDrawing.setAttribute('viewBox',`0 0 ${width} ${boardHeight}`);
    inkDrawing.replaceChildren(...paths);
  }
  new ResizeObserver(paintInk).observe($('board'));

  function render() {
    const {board,visible,flags,highlight,state,focus} = game;
    batchControls();
    for (const [i,b] of buttons.entries()) {
      const n = visible[i], mine=editing && !game.numbers && board.bombs[i];
      const marked = flags.has(i) || (!editing && state === 'won' && n < 0);
      const label = mine ? (marked?'雷，有旗':'雷') : n >= 0 ? (n || '空白') : marked ? '旗' : '未开';
      const marks = ['cell', n >= 0 ? 'open' : 'covered'];
      if (board.opening.includes(i)) marks.push('first');
      if (n > 0) marks.push(`n${n}`);
      if (marked) marks.push('flagged');
      if (mine) marks.push('edit-mine');
      if (highlight?.sources.includes(i)) marks.push('clue');
      const answer=game.answers && game.judgment?.state[i];
      if (highlight?.safe.includes(i) || answer==='safe') marks.push('target-safe');
      if (highlight?.mines.includes(i) || answer==='mine') marks.push('target-mine');
      let body = mine ? icon('mine')+(marked?`<span class="edit-flag">${icon('flag')}</span>`:'') : marked ? icon('flag') : n > 0 || n===0 && editing && game.numbers ? String(n) : '';
      const confirmed=game.manual?.marked.get(i);
      const red=confirmedInk(game,i);
      const blue=game.notes.layers.blue.get(i);
      for(const [color,m] of [['red',red],['blue',blue]]) {
        if(m && !['x','/','//'].includes(m.symbol)) body+=`<span class="cell-note ${color}">${m.symbol}</span>`;
        if(m?.level>1) body+=`<sub class="ink-rank">${m.level}</sub>`;
      }
      if (b.classList.contains('proof-hover')) marks.push('proof-hover');
      for (const cls of proofAreaClasses) if (b.classList.contains(cls)) marks.push(cls);
      const opening=b.classList.contains('covered') && n>=0;
      const flagPlaced=b.classList.contains('cell') && marked && !b.classList.contains('flagged');
      if (b.className !== marks.join(' ')) b.className = marks.join(' ');
      if(opening) animate(b,[{scale:.87,opacity:.64},{scale:1.025,opacity:1,offset:.72},{scale:1,opacity:1}],{duration:190,easing:'ease-out'});
      if (b.dataset.body !== body) { b.innerHTML = body; b.dataset.body = body; }
      if(flagPlaced && !mine) animate(b.querySelector('.icon'),[{scale:.75,opacity:.6},{scale:1.1,opacity:1,offset:.72},{scale:1,opacity:1}],{duration:170,easing:'ease-out'});
      b.tabIndex = i === focus ? 0 : -1;
      b.setAttribute('aria-label',`${coord(i)} ${label}${board.opening.includes(i) ? '，开局给出' : ''}${confirmed==='mine'?'，已确认有雷':confirmed==='safe'?'，已确认安全':''}${blue?`，蓝色 ${blue.symbol}${blue.level>1?` ${blue.level} 层`:''}`:''}`);
    }
    $('remaining').textContent = !editing && state === 'won' ? '0' : board.mines-flags.size;
    $('totalMines').classList.toggle('clue-total', !!highlight?.sources.includes(-1));
    paintInk();
    time();
  }

  function clearProofHover() {
    clearAreaPreview?.();
    for (const node of document.querySelectorAll('.proof-hover')) node.classList.remove('proof-hover');
  }

  function clearHint() { game.highlight = null; clearProofHover(); $('proof').replaceChildren(); }
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
  }

  function removeFlag(g,i) {
    g.flags.delete(i);
    g.current=g.rating=undefined;g.ratingScope='当前局面';scheduleRating();
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
    const result=batch.record(cells,kind);
    if(result.wrong!==undefined) {
      say(`标错了：${coord(result.wrong)} 在当前线索下可能${kind==='mine'?'安全':'有雷'}。`,'error'); return;
    }
    g.manual=batch;
    if(from!==undefined) removeFlag(g,from);
    showMarks(g);
  }

  function markProgress(g) {
    const {marked,total,done}=g.manual;
    say(done?(auto?'本轮已标齐，即将开格并插旗。':'本轮已标齐，可以开格并插旗。'): `本轮已确认 ${marked.size} / ${total} 格`);
  }

  function showMarks(g) {
    g.started??=Date.now();
    markProgress(g);
    render();
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
    g.proven=proven;
    g.flags=flags;
    g.manual=null;
    g.current=g.rating=undefined;g.ratingScope='当前局面';scheduleRating();
    if(g.opened===g.visible.length-g.board.mines) finish();
    else say(`本轮已打开 ${safe.length} 格，插旗 ${mines.length} 格。`,'success');
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
      confirmed:game.manual ? [...game.manual.marked.keys()] : undefined});
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
    const highlighted = total ? [$('totalMines')] : vs.map(v => buttons[v]);
    let hovered = false, focused = false;
    const glow = () => { for (const node of highlighted) node.classList.toggle('proof-hover',hovered || focused); };
    button.onpointerenter = () => { hovered = true; glow(); };
    button.onpointerleave = () => { hovered = false; glow(); };
    button.onfocus = () => { focused = true; glow(); };
    button.onblur = () => { focused = false; glow(); };
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
    preview.title=`灰纹：相消 ${cancelled.length} 格；蓝：正项 ${positive.length} 格；橙：负项 ${negative.length} 格`;
    preview.setAttribute('aria-label',preview.title);
    const areas=[cancelled,positive,negative].map((vs,i)=>[vs.map(v=>buttons[v]),proofAreaClasses[i]]);
    let pinned=false;
    const paint=show=>{
      for (const [nodes,cls] of areas) for (const node of nodes) node.classList.toggle(cls,show);
    };
    const hide=()=>{
      if(clearAreaPreview!==hide) return;
      paint(false);
      pinned=false;
      preview.setAttribute('aria-pressed','false');
      clearAreaPreview=null;
    };
    const show=()=>{
      if(clearAreaPreview===hide) return;
      clearAreaPreview?.();
      clearAreaPreview=hide;
      paint(true);
    };
    preview.onpointerenter=show;
    preview.onpointerleave=()=>{if(!pinned&&!preview.matches(':focus-visible')) hide();};
    preview.onfocus=()=>{if(preview.matches(':focus-visible')) show();};
    preview.onblur=()=>{if(pinned||!preview.matches(':hover')) hide();};
    preview.setAttribute('aria-pressed','false');
    preview.onclick=()=>{
      if(pinned) { hide(); return; }
      show();
      pinned=true;
      preview.setAttribute('aria-pressed','true');
    };
    return preview;
  }

  function steps(batch) {
    const list = element('ol','proof-steps'), rows = new Map(), emitted = new Map();
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
    const equationNumber = id => element('span','equation-number',String(id));
    function arithmetic(refs, reflected=false) {
      return format.referenceTerms(refs,reflected).flatMap(({id,operator,factor},i)=>{
        const term=element('span','equation-ref');
        term.append(factor,equationNumber(id));
        const prefix=operator ? `${i?' ':''}${operator}${i?' ':''}` : '';
        return [prefix,term];
      });
    }
    function add(raw, sign, rhs, note, conclusion, sourceRow) {
      const {w,h}=game.board;
      const grouping=conclusion ? format.conclusionGroups(raw,groups,w,h,game.visible) : groups;
      const {terms,sign:comparison,constant,constantFirst}=format.comparison(raw,sign,rhs,grouping);
      const key=JSON.stringify([raw.slice().sort(([a],[b])=>a-b),comparison,constant,constantFirst]);
      if(emitted.has(key)) {
        const ref=emitted.get(key);
        if(conclusion) list.children[ref.id-1].classList.add(`conclusion-${conclusion}`);
        return ref;
      }
      const line = element('li','proof-line'), formula = element('div','formula');
      const id=list.children.length+1;
      const marker=equationNumber(id);
      marker.classList.add('equation-marker');
      if(conclusion) line.classList.add(`conclusion-${conclusion}`);
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
      line.append(marker,formula);
      if (note) {
        const small = element('small','proof-note');
        small.append(...(Array.isArray(note) ? note : [note]));
        line.append(small);
      }
      list.append(line);
      const ref={id,reflected:constantFirst,exact:comparison==='='};
      emitted.set(key,ref);
      return ref;
    }
    for (const row of rows.values()) {
      const shown = row.source < 0 ? game.board.mines : game.visible[row.source];
      const clue = chip(row.source,`${source(row.source)} · ${shown}`);
      const note = [clue,shown === row.rhs ? '' : ` − ${shown-row.rhs} 雷`];
      rowNumbers.set(row.source,add(ones(row.vs),'=',row.rhs,note,null,row).id);
    }
    for(const m of batch.proofs) {
    const conclusion=m.value?'mine':'safe';
    if(m.kind==='count') {
      list.children[rowNumbers.get(m.row.source)-1].classList.add(`conclusion-${conclusion}`);
    } else if (m.kind === 'difference') {
      const shared = new Set(m.shared);
      const capacity = row => row.vs.filter(v => !shared.has(v)).length;
      const a = rowNumbers.get(m.a.source), b = rowNumbers.get(m.b.source);
      const inside=m.vs.every(v => shared.has(v));
      if(!inside && (!capacity(m.a) || !capacity(m.b))) {
        const [large,small]=capacity(m.a)?[m.a,m.b]:[m.b,m.a];
        const note=[equationNumber(rowNumbers.get(large.source)),' − ',equationNumber(rowNumbers.get(small.source)),
          ' ',cancellationChip([ones(large.vs),small.vs.map(v=>[v,-1])])];
        add(ones(m.vs),'=',m.value ? m.vs.length : 0,note,conclusion);
      } else {
        // A single bound saturates the target; the other direction is its capacity.
        const useLower=inside===Boolean(m.value);
        const bound=useLower
          ? add(ones(m.shared),'≥',m.low,['max(0, ',equationNumber(a),` − ${capacity(m.a)}, `,equationNumber(b),` − ${capacity(m.b)})`],inside?conclusion:null)
          : add(ones(m.shared),'≤',m.high,[`min(${m.shared.length}, `,equationNumber(a),', ',equationNumber(b),')'],inside?conclusion:null);
        const finish=bound=>add(ones(m.vs),'=',m.value ? m.vs.length : 0,
          [equationNumber(bound.id),m.value?`，至多 ${m.vs.length} 雷`:'，雷数非负'],conclusion);
        if (inside) finish(bound);
        else {
          const row = m.vs.every(v => m.a.vs.includes(v)) ? a : b;
          const next=add(ones(m.vs),m.value?'≥':'≤',m.value?m.lower:m.upper,
            [equationNumber(row),' − ',equationNumber(bound.id)],conclusion);
          finish(next);
        }
      }
    } else if (m.kind === 'resolution') {
      const numbers = [];
      for (const n of m.nodes) {
        const terms = [...ones(n.positive),...n.negative.map(v => [v,-1])];
        const note = n.row ? [equationNumber(rowNumbers.get(n.row.source)),`，取区外${n.positive.length?'上':'下'}界`]
          : [equationNumber(numbers[n.from[0]]),'、',equationNumber(numbers[n.from[1]]),' 取整消去 ',chip(n.pivot)];
        numbers.push(add(terms,'≥',1-n.negative.length,note,n===m.nodes.at(-1)?conclusion:null).id);
      }
      add(ones(m.vs),'=',m.value ? m.vs.length : 0,
        [equationNumber(numbers.at(-1)),m.value?'，二元上界':'，二元下界'],conclusion);
    } else if (m.inequality) {
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
          ref={...add(r.terms,sign,r.rhs,note,r===m.inequality?conclusion:null),k:1};
        } else {
          const a=visit(r.a), reflected=format.relation('≤',r.rhs).constantFirst;
          const note=[...arithmetic([a],reflected),` ÷ 2，${format.rounding(reflected)}`];
          ref={...add(r.terms,'≤',r.rhs,note,r===m.inequality?conclusion:null),k:1};
        }
        labels.set(r,ref);
        return ref;
      };
      const {id:final,reflected,exact}=visit(m.inequality);
      const bound=format.weightedBound(m,reflected,exact);
      if (bound) {
        const extremum=reflected?'上界':'下界';
        const notes=m.slack?null:format.extremumNotes(bound,m.value);
        const basis=notes?notes.capacity:[equationNumber(final),`，其余项取${extremum}`];
        const limit=add(bound.terms,bound.sign,bound.rhs,basis);
        const deduction=notes?`，${notes.deduction}`:'，每格权重超过余量';
        add(ones(m.vs),'=',m.value ? m.vs.length : 0,
          [...(m.slack?[]:[equationNumber(final),'、']),equationNumber(limit.id),deduction],conclusion);
      }
    }
    if(m.symmetric.some(v=>!m.vs.includes(v))) {
      const group=m.symmetric.filter(v=>!m.vs.includes(v));
      add(ones(group),'=',m.value?group.length:0,['与 ',chip(m.vs),' 等价'],conclusion);
    }
    }
    return list;
  }

  function display(a, weak) {
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
      body.append(element('p','proof-caption',weak?'在棋盘上查看高亮数字':
        `最少 ${m.sources.length} 条线索`));
      if (weak) body.append(clues);
      if (!weak) {
        body.append(steps(m));
        if(a.prior.length) {
          const prior=element('details','proof-detail');
          prior.append(element('summary','', '本步之前证实的旗子'));
          for(const p of a.prior) {
            const targets=element('div','proof-chips targets mine');
            targets.append(element('strong','target-label','必雷'),...regionChips(p.mines,'必雷'));
            prior.append(targets,steps(p));
          }
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
    const before=g.manual.marked.size;
    g.manual.record(safe,'safe'); g.manual.record(mines,'mine');
    if(g.manual.marked.size===before) return false;
    showMarks(g);
    return true;
  }

  function pauseSolve() {
    stopAuto();
    if(game.manual?.marked.size) markProgress(game);
    else say('已停止自动求解。');
  }

  async function solve() {
    if (auto) { pauseSolve(); return; }
    if (!ready() || pending) return;
    auto = true;
    const task=++run, g=game;
    showProof();
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

  async function requestHint(show) {
    if (!ready() || auto || pending) return;
    const task = run;
    showProof();
    clearHint(); render();
    $('proof').textContent = '正在推理…';
    const a = await next();
    if (task === run && ready() && a) show(a);
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

  function showProof() {
    const wasHidden=$('proofPane').hidden;
    $('proofPane').hidden=false;
    if(wasHidden) animate($('proofPane'),[{opacity:0,translate:'0 6px'},{opacity:1,translate:'0 0'}],{duration:180,easing:'ease-out'});
    document.querySelector('.layout').scrollIntoView({block:'nearest'});
  }

  function setMode(next) {
    editing=next;
    $('gameMode').setAttribute('aria-pressed',String(!next));
    $('editMode').setAttribute('aria-pressed',String(next));
    $('settings').hidden=next;
    for(const id of ['editorSettings','editTools','playPosition']) $(id).hidden=!next;
  }

  function copyPosition(g) {return seeds.decode(seeds.encode(g));}

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
    setMode(next);
    if(editing) {
      parkedGame=game;
      const w=$('width').valueAsNumber, h=$('height').valueAsNumber;
      mountDraft(draft??positionGame(game ? copyPosition(game) : seeds.create(
        seeds.sizeOk(w)?w:Number($('width').defaultValue),seeds.sizeOk(h)?h:Number($('height').defaultValue))));
    } else {draftMinesValid=true; mount(parkedGame);}
    say('');
  }

  function resizeDraft(blank) {
    if(!editing || pending || !$('editorSettings').reportValidity()) return;
    const w=$('editWidth').valueAsNumber, h=$('editHeight').valueAsNumber;
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
    if(!blank) next.notes=['red','blue'].map(color=>[...game.notes.layers[color]].flatMap(([i,note])=>{
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
      g.current=g.rating=undefined; scheduleRating();
      render(); return;
    }
    if(tool==='number') {
      if(n===value) return;
      g.visible[i]=value;
      if(value>=0) g.flags.delete(i);
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
      if(n<0) g.flags.delete(i);
    }
    b.opening=g.visible.flatMap((v,at)=>v>=0?[at]:[]);
    b.first=b.opening[0]??0;
    g.opened=b.opening.length;
    g.rating=g.current=g.witness=undefined;
    scheduleRating(); render(); say('');
  }

  async function acceptPosition(position) {
    if(editing) mountDraft(positionGame(position));
    else {
      if(position.board.mines===position.visible.length) throw Error('游戏局面至少需要一个安全格。');
      if(position.numbers) {
        const {board,visible}=position;
        const result=await ask('materialize',{p:board,visible});
        if(!result?.board) throw Error(result?.status==='invalid'?'数字与总雷数互相矛盾。':'尚未找到可行的雷布局。');
        position={...position,numbers:false,board:result.board};
      }
      mount(positionGame(position));
    }
    say('已导入局面。','success');
  }

  function scheduleRating() {
    clearTimeout(ratingTimer);
    ratingWorker?.terminate();
    ratingWorker=null;
    const g=game;
    if(!g || g.current && g.rating) {showRating();return;}
    if(editing && g.numbers && !draftMinesValid) {
      g.current={status:'invalid-total'}; showRating(); controls(); return;
    }
    if(g.board.mines===g.visible.length && (!g.numbers || !g.opened)) {
      g.current=g.rating={status:'no-safe-cell'}; showRating(); controls(); return;
    }
    showRating();
    ratingTimer=setTimeout(()=>{
      try {
        const task=ratingWorker=background(`const engine = makeMinesEngine();
          onmessage = ({data:{board,p,visible,proven,flags,numbers,hasRating,opening}}) => {
            try {
              const current=engine.inspect(p,visible,proven,flags,{opening});
              const witness=numbers && current.status!=='invalid'?engine.publicBoard(p,visible).board:null;
              postMessage({current,witness});
              if(!hasRating) {
                const model=numbers?witness:board;
                const snapshot=model && {...model,opening:visible.flatMap((v,i)=>v>=0?[i]:[])};
                postMessage({report:snapshot?engine.verify(snapshot,p,{marks:proven,flags,certify:true,allowEmpty:true,
                  ...(opening?{}:{visible,rate:false})}):{status:current.status}});
              }
              postMessage({done:true});
            } catch {postMessage({error:true,done:true});}
          };`);
        const receive=({current,witness,report,error,done})=>{
          if(task!==ratingWorker || g!==game) return;
          if(done) {task.terminate(); ratingWorker=null;}
          if(current) {g.current=current;g.witness=witness;}
          if(report) {
            g.rating=report;
            if(!editing && g.ratingScope==='开局') g.initialRating=report;
          }
          if(error) {g.current??={status:'error'};g.rating??={status:'error'};}
          showRating(); controls();
        };
        task.onmessage=({data})=>receive(data);
        task.onerror=()=>receive({error:true,done:true});
        task.postMessage({p:g.p,board:g.board,visible:g.visible,proven:[...g.proven],flags:[...g.flags],numbers:g.numbers,
          hasRating:!!g.rating,opening:editing || g.opened===g.original.opening.length});
      } catch {
        ratingWorker?.terminate(); ratingWorker=null;
        g.current??={status:'error'}; g.rating??={status:'error'}; showRating(); controls();
      }
    },160);
  }

  function seedFeedback(text,tone='') {
    $('seedFeedback').textContent=text;
    $('seedFeedback').dataset.tone=tone;
  }

  function seedDialog(importing) {
    const box=$('positionSeedText');
    $('seedDialogTitle').textContent=importing?'导入局面种子':'导出局面种子';
    $('confirmImport').hidden=!importing;
    $('copyPosition').hidden=importing;
    box.readOnly=!importing;
    box.value=importing?'':seeds.encode(game);
    seedFeedback('');
    $('seedDialog').showModal();
    box.focus();
    if(!importing) box.select();
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
        const position=seeds.numbers(w,h,mines,game.visible.map(n=>n<0?'.':n).join(''),[...game.flags],
          ['red','blue'].map(color=>[...game.notes.layers[color]]));
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
    game.witness=game.current=game.rating=undefined;
    boardSize(); render(); scheduleRating(); controls();
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
  $('playPosition').onclick=()=>{
    const position=copyPosition(game);
    if(position.numbers) {position.board=game.witness;position.numbers=false;}
    if(position.board.mines===position.visible.length) {say('游戏局面至少需要一个安全格。','error');return;}
    const report=game.rating?.status==='error'?undefined:game.rating;
    setMode(false);
    parkedGame=undefined;
    mount(positionGame(position,{},report));
    say('已将编辑局面载入游戏。','success');
  };
  $('expandPosition').onclick=async()=>{
    const g=game;
    if(!g || g.current?.status!=='blocked' || pending || worker || auto) return;
    const board=g.numbers?g.witness:g.board;
    if(!board) return;
    const result=await ask('expand',{board,visible:g.visible,flags:g.flags});
    if(g!==game) return;
    if(result?.status!=='expanded') {say('未能确定最少开扩格数，局面未改变。','error');return;}
    g.manual=null;
    g.visible=result.visible; g.opened+=result.cells.length;
    for(const v of result.cells) g.flags.delete(v);
    if(editing) {
      g.board.opening=g.visible.flatMap((n,i)=>n>=0?[i]:[]);
      g.board.first=g.board.opening[0]??0;
    } else {
      clearHint();
      g.started??=Date.now();
      if(g.opened===g.visible.length-g.board.mines) finish();
    }
    g.rating=g.current=g.judgment=g.witness=undefined; g.ratingScope='当前局面';
    scheduleRating(); render();
    say(`已开扩 ${result.cells.length} 格 · ${result.cells.map(coord).join('、')}`,'success');
    if(g.answers && ready()) void judge(g);
  };
  $('importPosition').onclick=()=>seedDialog(true);
  $('exportPosition').onclick=()=>seedDialog(false);
  $('seedForm').onsubmit=async e=>{
    e.preventDefault();
    if($('confirmImport').hidden || pending) return;
    $('confirmImport').disabled=true;
    try {await acceptPosition(seeds.decode($('positionSeedText').value));$('seedDialog').close();}
    catch(error) {seedFeedback(error.message,'error');}
    finally {$('confirmImport').disabled=false;}
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

  const input = makeBoardInput({$,icon,say,canAct:()=>ready()&&!pending&&!auto,getGame:()=>game,changed:()=>{if(game) render();},
    menu:setRadial,closeReason:()=>showReason(false)});
  $('settings').addEventListener('submit',generate);
  for (const id of ['width','height']) $(id).addEventListener('input',showDifficultyDefaults);
  showDifficultyDefaults();
  $('cancel').onclick = () => { finishWorker(); say(`已取消生成。${game ? '当前棋局已保留。' : ''}`); };
  $('restart').onclick = () => {
    if (!game || worker) return;
    const {original,p,initialRating,seed,originalFlags,originalNotes}=game;
    mount(positionGame({board:original,flags:originalFlags,notes:originalNotes},p,initialRating,seed));
    say(game.state === 'won' ? '首开通关 · 所有安全格已打开' : '已恢复原始开局。');
  };
  $('focus').onclick = () => requestHint(a=>display(a,true));
  $('hint').onclick = () => requestHint(a=>display(a,false));
  $('apply').onclick = () => requestHint(stageStep);
  $('commitMarks').onclick = () => {if(!auto) void commitBatch(game);};
  $('solve').onclick = solve;
  $('answers').onclick = toggleAnswers;
  $('reasonMenu').onclick = ()=>{if(auto) pauseSolve();else showReason($('reasonFlower').inert,true);};
  $('closeReason').onclick = ()=>showReason(false,true);
  $('closeProof').onclick = ()=>{clearHint();$('proofPane').hidden=true;render();$('reasonMenu').focus({preventScroll:true});};
  document.addEventListener('keydown',e=>{
    if(e.key!=='Escape') return;
    if(!$('reasonFlower').inert) showReason(false,true);
    else if(!$('markFlower').inert || input.writing) {input.close();$('markMenu').focus({preventScroll:true});}
  });

  const board = $('board');
  let flagDrag, skipDragClick=false;
  board.addEventListener('pointerdown',e=>{
    if(!e.isPrimary || e.button!==0) return;
    flagDrag=null; skipDragClick=false;
    if(!ready() || pending || auto || input.writing || !$('markFlower').inert) return;
    const cell=e.target.closest('[data-cell]');
    if(!cell) return;
    const i=Number(cell.dataset.cell), from=game.flags.has(i)?i:undefined;
    if(game.visible[i]<0 && from===undefined) return;
    flagDrag={id:e.pointerId,x:e.clientX,y:e.clientY,from,game};
  });
  board.addEventListener('pointermove',e=>{
    const drag=flagDrag;
    if(drag?.id!==e.pointerId || drag.game!==game) return;
    if(!drag.ghost) {
      if(!e.buttons || Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<8) return;
      // Keep taps on the original cell; capture only after a drag starts.
      board.setPointerCapture(e.pointerId);
      drag.ghost=element('span','drag-flag');
      drag.ghost.innerHTML=icon('flag');
      drag.ghost.setAttribute('aria-hidden','true');
      document.body.append(drag.ghost);
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
    const cell=document.elementFromPoint(e.clientX,e.clientY)?.closest('#board [data-cell]');
    const i=cell?Number(cell.dataset.cell):undefined;
    if(i===undefined || game.visible[i]>=0) {
      if(drag.from!==undefined) play(drag.from,true);
    } else if(!game.flags.has(i)) {
      clearHint(); game.focus=i;
      void recordManual(game,[i],'mine',drag.from);
    }
  }
  document.addEventListener('pointerup',e=>stopFlagDrag(e,true));
  document.addEventListener('pointercancel',stopFlagDrag);
  board.addEventListener('click',e=>{
    if(e.detail && skipDragClick) {skipDragClick=false;return;}
    const b=e.target.closest('[data-cell]'); if(!b) return;
    const i=Number(b.dataset.cell);
    if(!editing && input.stamp(i)) return;
    (editing?editCell:play)(i,e.shiftKey);
  });
  board.addEventListener('contextmenu',e=>{
    const b=e.target.closest('[data-cell]'); if (b) {
      e.preventDefault();
      const i=Number(b.dataset.cell);
      if(!editing && input.erase(i)) return;
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
        if(editing || !input.writing) (editing?editCell:play)(i,true);
        return;
      default: return;
    }
    e.preventDefault(); game.focus=n; buttons[i].tabIndex=-1; buttons[n].tabIndex=0; buttons[n].focus();
  });
  setInterval(time,250);
  controls();
})();
