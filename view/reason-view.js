// 推导面板与推理指标，返回棋盘高亮数据供应用转交给棋盘视图。
function makeReasonView({$,element,format,chip,steps,regionChips}) {
  function showVerification(game,editing,selectedClues) {
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

  function display(game,a,weak) {
    const panel=$('proof'), m=a.move;
    panel.replaceChildren();
    let highlight=null;
    if (!m) {
      panel.textContent = a.status === 'confirmed' && game.manual?.done ? '本轮已标记完毕，可以开格并插旗。'
        : a.status === 'confirmed' ? '本轮已无新的确定格。'
        : a.status === 'error' ? '推理提示计算失败，请重试。'
        : a.status === 'minimum-unavailable' ? '本次未能完成最少线索验证。'
        : a.status === 'batch-unavailable' ? '本次未能为这组线索的全部结论写出技巧证明。' : '现有技巧未找到下一步。';
    } else {
      const sources=[...new Set([...a.prior.flatMap(p=>p.sources),...m.sources])];
      const safe=m.safe.filter(v=>!game.manual?.marked.has(v));
      const mines=m.mines.filter(v=>!game.manual?.marked.has(v) && !game.flags.has(v));
      const weights=new Map(), stepsList=weak?null:steps(game,m,weights);
      highlight = {sources,safe:weak?[]:safe,mines:weak?[]:mines,weights};
      const card=element('article','proof-card');
      const top=element('div','proof-top');
      top.append(element('h3','',weak?'相关线索':'本步结论'));
      if (!weak) {
        for(const [vs,kind,label] of [[safe,'safe','安全'],[mines,'mine','必雷']]) if(vs.length) {
          const targets=element('div',`proof-chips targets ${kind}`);
          targets.append(element('strong','target-label',label),...regionChips(game,vs,label,weights));
          top.append(targets);
        }
      }
      const body=element('div','proof-body'), clues=element('div','proof-chips clues');
      const tokens=ss=>ss.slice().sort((a,b)=>a-b).map(s=>chip(game,s,s<0?'总雷数':`${format.coordinate(s,game.board.w)} · ${game.visible[s]}`));
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
            const previousWeights=new Map(), previousSteps=steps(game,p,previousWeights);
            const targets=element('div','proof-chips targets mine');
            targets.append(element('strong','target-label','必雷'),...regionChips(game,p.mines,'必雷',previousWeights));
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
    return highlight;
  }

  return {display,showVerification};
}
