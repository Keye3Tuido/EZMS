// 表单、工具可用性和状态卡片。应用提供状态及需要触发的界面更新。
function makeControlsView({$,fields,icon}) {
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

  function showSearchControls(searching,candidate) {
    const cancel=$('cancel');
    cancel.classList.toggle('is-inactive',!searching);
    cancel.setAttribute('aria-hidden',String(!searching));
    cancel.disabled=!searching;
    const useCandidate=$('useCandidate');
    useCandidate.disabled=!candidate;
    useCandidate.textContent=searching?'停止并采用候选':'采用候选';
  }

  function controls({game,editing,auto,busy,searching,candidate,hasParkedGame,draftMinesValid,proofPending},
    {batchControls,updateSelectionAxes,selectionHistoryControls,updateSolveControl}) {
    const live = game?.state === 'playing', locked = searching || auto || busy;
    for (const id of fields) $(id).disabled = searching;
    $('generate').disabled = searching || busy && !auto;
    showSearchControls(searching,candidate);
    for (const id of ['gameMode','editMode','importPosition']) $(id).disabled = locked;
    $('exportPosition').disabled = locked || !game;
    $('playPosition').disabled = locked || !game || game.board.mines===game.visible.length || !!(game.numbers && !game.witness);
    $('draftMines').disabled=locked;
    $('exportPosition').disabled ||= editing && !draftMinesValid;
    $('expandPosition').disabled=locked;
    batchControls();
    for (const control of $('editorSettings').elements) control.disabled = locked;
    $('copyGamePosition').disabled = locked || !hasParkedGame;
    for (const button of $('editTools').querySelectorAll('button'))
      button.disabled = locked && !(editing && button.matches('[data-draft], [data-edit]'));
    $('reasonMenu').classList.toggle('is-inactive',editing);
    $('restart').hidden = editing;
    $('gameTime').hidden = editing;
    $('board').setAttribute('aria-busy',String(busy));
    $('answers').disabled=locked || !live;
    for(const id of ['focus','hint']) $(id).disabled=searching || auto || !live || busy && !proofPending;
    $('reasonMenu').disabled = editing || !game || searching;
    $('selectionMenu').disabled = editing || !game || locked;
    updateSelectionAxes();
    selectionHistoryControls();
    $('markMenu').disabled = !game || searching || busy || auto || !editing && !live;
    $('restart').disabled = searching || busy && !auto || !game;
    updateSolveControl(live);
    $('reasonMenu').innerHTML=icon('hintIcon');
    $('reasonMenu').title='推理工具';
    $('reasonMenu').setAttribute('aria-label','推理工具');
    $('answers').setAttribute('aria-pressed',String(!!game?.answers));
    $('answers').querySelector('span').textContent = game?.answers ? '隐藏答案' : '展示答案';
  }

  function showMode(next,closeSelection) {
    $('gameMode').setAttribute('aria-pressed',String(!next));
    $('editMode').setAttribute('aria-pressed',String(next));
    $('settings').hidden=next;
    if(next) closeSelection();
    $('selectionMenu').hidden=next;
    for(const id of ['editorSettings','editTools','playPosition']) $(id).hidden=!next;
  }

  function showDraft(position) {
    $('editWidth').value=position.board.w;
    $('editHeight').value=position.board.h;
    $('draftMines').max=position.visible.length;
    $('draftMines').value=position.board.mines;
    $('mineTools').hidden=position.numbers;
    $('numberTools').hidden=!position.numbers;
    for(const button of $('editTools').querySelectorAll('[data-draft]')) button.setAttribute('aria-pressed',String((button.dataset.draft==='numbers')===position.numbers));
  }

  return {updateOperationCard,say,saySearch,showSearchControls,controls,showMode,showDraft};
}

if(typeof module!=='undefined') module.exports=makeControlsView;
