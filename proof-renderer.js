'use strict';

function makeProofRenderer({element,format,equivalentGroups,proofTargets,proofRows,focusBoardCell,scrollToTotal}) {
  function proofPreview(areas,total=false,weights) {
    return {areas:areas.map(vs=>new Set(vs)),cells:new Set(areas.flat()),total,weights};
  }

  function signedProofPreview(terms,weights) {
    const positive=terms.filter(term=>term.coefficient>0).flatMap(term=>term.cells);
    const negative=terms.filter(term=>term.coefficient<0).flatMap(term=>term.cells);
    return proofPreview([[],positive,negative],false,weights);
  }

  function chip(game,indices, label, {clueRegion, description, weights, focusCell, total = indices === -1} = {}) {
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
    button.onclick = () => total ? scrollToTotal() : focusBoardCell(focusCell ?? vs[0]);
    return button;
  }

  function regionChips(game,vs,kind,weights) {
    const {w,h}=game.board;
    return format.regions(vs,w,h,game.visible).map(group=>{
      const text=format.label(group,w,h,game.visible);
      return chip(game,group,text,{description:`${text}：${group.length} 格${kind}`,weights});
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

  function steps(game,batch,conclusionWeights=new Map()) {
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
    const groups = equivalentGroups([...rows.values()]);
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
        token.append(chip(game,cells,undefined,{weights}));
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
        chainRow(aResult,'≥',[constant,...b.map(()=>0)].join(' + '));
        chainRow(aResult,'=',String(constant));
        appendDerived(aResult,'mine',terms,weights,
          ['由 ',equationNumber(sourceId),`，减项非负，正项至多为 ${constant}`],[sourceId]);
      }
      if(fresh.some(([,value])=>value===0)) {
        const reversedTerms=terms.map(term=>({...term,coefficient:-term.coefficient}));
        const reversedWeights=new Map([...weights].map(([v,weight])=>[v,-weight]));
        const bResult=element('div','formula formula-chain');
        chainRow(bResult,'',...termElements(b,reversedWeights));
        chainRow(bResult,'=',...termElements(a,reversedWeights),element('span','operator',`− ${constant}`));
        const upperBounds=a.map(({coefficient,cells})=>coefficient*cells.length);
        chainRow(bResult,'≤',`${upperBounds.join(' + ')} − ${constant}`);
        chainRow(bResult,'=','0');
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
      chainRow(formula,'',chip(game,cells,undefined,{weights}));
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
        const s=sourceRow.source, clueRegion=s>=0, name=clueRegion?format.coordinate(s,game.board.w):'全盘';
        const scope=clueRegion?`${name} 的邻域`:name;
        formula.append(chip(game,sourceRow.vs,name,{clueRegion,total:!clueRegion,focusCell:clueRegion?s:undefined,
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
      if (shown!==row.rhs) details.push(`${shown} − ${shown-row.rhs}（扣除已知雷）`);
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
          : [equationNumber(numbers[n.from[0]]),'、',equationNumber(numbers[n.from[1]]),' 取整消去 ',chip(game,n.pivot)];
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
    if(group.length) add(ones(group),'=',m.value?group.length:0,['与 ',chip(game,m.vs),' 等价']);
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

  return {steps,chip,regionChips,proofPreview};
}

if(typeof module!=='undefined') module.exports=makeProofRenderer;
