// 棋盘节点、坐标轴、计时和格子渲染。
function makeBoardView({$,format,icon,element,feedback,overlays,inkGlyph,selectBoardRectangle}) {
  let buttons=[], selectionAxes=[];
  const {proofDrawing,inkDrawing,confirmedInk,coefficientDepth}=overlays;

  function mount(game) {
    selectionAxes=[];
    const root = $('board');
    root.parentElement.hidden = !game;
    root.hidden = !game;
    if(!game) {
      $('size').textContent='—'; $('remaining').textContent='—'; time(game);
      root.replaceChildren(); buttons=[]; return;
    }
    const {board}=game;
    showSize(game);
    root.style.setProperty('--cols',board.w);
    root.style.setProperty('--rows',board.h);
    buttons = Array.from({length:board.w*board.h}, (_,i) => {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.cell = i;
      return b;
    });
    function axis(text,label,left,top,right,bottom) {
      const button=element('button','axis',text);
      button.type='button';
      button.setAttribute('aria-label',label);
      button.onclick=()=>selectBoardRectangle(left,top,right,bottom);
      selectionAxes.push(button);
      return button;
    }
    const grid=document.createDocumentFragment();
    const corner=axis('','选择全盘',0,0,board.w,board.h);
    corner.innerHTML=icon('selectBoardIcon');
    grid.append(corner);
    for(let x=0;x<board.w;x++) {
      const column=format.column(x);
      grid.append(axis(column,`选择 ${column} 列`,x,0,x+1,board.h));
    }
    for(let y=0;y<board.h;y++) {
      grid.append(axis(y+1,`选择第 ${y+1} 行`,0,y,board.w,y+1));
      for(let x=0;x<board.w;x++) grid.append(buttons[y*board.w+x]);
    }
    root.replaceChildren(grid,proofDrawing,inkDrawing);
  }

  function showSize(game) {
    const {board}=game;
    $('size').textContent = `${board.w} × ${board.h} · `;
    const total = document.createElement('span'); total.id = 'totalMines'; total.textContent = `${board.mines} 雷`;
    $('size').append(total);
  }

  function time(game) {
    $('time').textContent = game?.started == null ? '0' : String(Math.floor(((game.ended ?? Date.now()) - game.started)/1000));
  }

  function render(game,editing,highlight,activeSelectionClues) {
    const {board,visible,flags,state,focus} = game;
    const first=new Set(board.opening), proofClues=new Set(highlight?.sources);
    const proofSafe=new Set(highlight?.safe), proofMines=new Set(highlight?.mines);
    let revealed=0;
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
      const red=n<0?confirmedInk(game,i,editing):undefined;
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
      b.setAttribute('aria-label',`${format.coordinate(i,board.w)} ${label}${first.has(i) ? '，开局给出' : ''}${confirmed==='mine'?'，已确认有雷':confirmed==='safe'?'，已确认安全':red?`，红色笔记：${red.symbol==='x'?'雷':'安全'}`:''}${blue?`，蓝色 ${blue.symbol}${blue.level>1?` ${blue.level} 层`:''}`:''}${archived?`，绿色持久标${archived.symbol==='o'?'雷':'安全'}`:''}`);
    }
    $('remaining').textContent = !editing && state === 'won' ? '0' : board.mines-flags.size;
    $('totalMines').classList.toggle('clue-total', !!highlight?.sources.includes(-1));
    overlays.paintInk(game,editing);
    time(game);
  }

  function updateAxes(active,disabled) {
    $('board').classList.toggle('selecting',active);
    for(const axis of selectionAxes) {
      axis.disabled=disabled;
      axis.setAttribute('aria-hidden',String(!active));
    }
  }

  return {mount,render,showSize,time,updateAxes,get buttons() {return buttons;}};
}
