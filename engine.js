function makeMinesEngine() {
  'use strict';
  const version = 21;
  const range = n => Array.from({length:n}, (_, i) => i);
  const adj = (w,h) => range(w*h).map(i => {
    const ns=[], x=i%w, y=Math.floor(i/w);
    for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
      if((dx||dy) && x+dx>=0 && x+dx<w && y+dy>=0 && y+dy<h) ns.push(i+dy*w+dx);
    }
    return ns;
  });

  function random(seed) {
    let s=seed>>>0;
    return n => {
      s=(s+0x9e3779b9)>>>0;
      let x=Math.imul(s^(s>>>16),0x21f0aaad);
      x=Math.imul(x^(x>>>15),0x735a2d97);
      return Math.floor(((x^(x>>>15))>>>0)/4294967296*n);
    };
  }

  function candidate({w,h,mines,start,safe}, seed, ns=adj(w,h)) {
    const r=random(seed), first=start==='random' ? r(w*h) : Math.floor(h/2)*w+Math.floor(w/2);
    const blocked=new Set([first,...(safe==='zero'?ns[first]:[])]);
    const pool=range(w*h).filter(i=>!blocked.has(i));
    if(!Number.isInteger(mines) || mines<0 || mines>pool.length) return null;
    const bombs=Array(w*h).fill(false);
    for(let k=0;k<mines;k++) {
      const j=k+r(pool.length-k);
      [pool[k],pool[j]]=[pool[j],pool[k]];
      bombs[pool[k]]=true;
    }
    return {w,h,mines,first,seed,ns,bombs,clues:ns.map(row=>row.reduce((sum,i)=>sum+Number(bombs[i]),0))};
  }

  function reveal(board, visible, i, flags=new Set()) {
    if(board.bombs[i] || flags.has(i) || visible[i]>=0) return 0;
    const queue=[i];
    visible[i]=board.clues[i];
    for(let j=0;j<queue.length;j++) if(visible[queue[j]]===0) {
      for(const v of board.ns[queue[j]]) if(visible[v]<0 && !flags.has(v)) {
        visible[v]=board.clues[v];
        queue.push(v);
      }
    }
    return queue.length;
  }

  function opening(board) {
    const visible=Array(board.bombs.length).fill(-1);
    if(board.opening) {
      // Preprinted clues are individual givens.
      for(const i of board.opening) {
        if(!Number.isInteger(i) || i<0 || i>=visible.length || board.bombs[i]) throw Error('Invalid opening cell');
        visible[i]=board.clues[i];
      }
    } else reveal(board,visible,board.first);
    return visible;
  }

  function numberAction(ns, visible, flags, i, markOnly=false, confirmed) {
    const clue=visible[i];
    if(clue<0) return null;
    const covered=ns[i].filter(v=>visible[v]<0 && confirmed?.get(v)!=='safe');
    const cells=covered.filter(v=>!flags.has(v) && confirmed?.get(v)!=='mine');
    if(!cells.length) return null;
    if(covered.length===clue) return {kind:'flag',cells};
    if(!markOnly && covered.length-cells.length===clue) return {kind:'open',cells};
    return null;
  }

  function split(a,b) {
    const A=[],B=[],I=[];
    let i=0,j=0;
    while(i<a.length && j<b.length) {
      if(a[i]===b[j]) { I.push(a[i++]); j++; }
      else if(a[i]<b[j]) A.push(a[i++]);
      else B.push(b[j++]);
    }
    return [A.concat(a.slice(i)),B.concat(b.slice(j)),I];
  }

  function equivalentGroups(rows) {
    const memberships=new Map();
    for(const [i,row] of rows.entries()) for(const v of row.vs) {
      if(!memberships.has(v)) memberships.set(v,[]);
      memberships.get(v).push(i);
    }
    const groups=new Map();
    for(const [v,ids] of memberships) {
      const key=ids.join(',');
      if(!groups.has(key)) groups.set(key,[]);
      groups.get(key).push(v);
    }
    return [...groups.values()].map(vs=>vs.sort((a,b)=>a-b));
  }

  function weightedProof(local,step) {
    const groups=equivalentGroups(local);
    const groupOf=new Map(groups.flatMap((vs,i)=>vs.map(v=>[v,i])));
    const spans=terms=>terms.reduce((n,[i])=>n+groups[i].length,0);
    const expanded=new Map();
    function publicRow(row) {
      if(!expanded.has(row)) expanded.set(row,{...row,
        terms:row.terms.flatMap(([i,c])=>groups[i].map(v=>[v,c])).sort((a,b)=>a[0]-b[0]),
        ...(row.a?{a:publicRow(row.a)}:{}),...(row.b?{b:publicRow(row.b)}:{})});
      return expanded.get(row);
    }
    const bases=local.flatMap(row=>[1,-1].map(k=>({
      kind:'equation', row, k, sources:[row.source],
      terms:[...new Set(row.vs.map(v=>groupOf.get(v)))].sort((a,b)=>a-b).map(i=>[i,k]), rhs:k*row.rhs
    })));
    const stored=[], cuts=[], seen=new Set(), seenCuts=new Set();
    let remaining=14000;
    function inspect(row,level) {
      const min=row.terms.reduce((s,[i,c])=>s+groups[i].length*Math.min(0,c),0), slack=row.rhs-min;
      for(const value of [0,1]) {
        const vs=row.terms.filter(([,c])=>Number(c<0)===value && Math.abs(c)>slack).flatMap(([i])=>groups[i]).sort((a,b)=>a-b);
        if(vs.length) {
          const move=step(vs,value,level,{kind:level===3?'cut':'linear',sources:row.sources,inequality:publicRow(row),min,slack});
          if(move) return move;
        }
      }
      return null;
    }
    function combine(a,b) {
      const terms=[];
      let i=0,j=0,overlap=false;
      while(i<a.terms.length || j<b.terms.length) {
        const x=a.terms[i],y=b.terms[j];
        if(!y || (x && x[0]<y[0])) {terms.push(x);i++;}
        else if(!x || x[0]>y[0]) {terms.push(y);j++;}
        else {if(x[1]+y[1]) terms.push([x[0],x[1]+y[1]]);i++;j++;overlap=true;}
      }
      if(!overlap || !terms.length || spans(terms)>16) return null;
      return {kind:'sum',a,b,terms,rhs:a.rhs+b.rhs,sources:[...new Set([...a.sources,...b.sources])]};
    }
    function explore(a,b,save) {
      const row=combine(a,b);
      if(!row) return null;
      const key=`${row.terms}:${row.rhs}`;
      if(seen.has(key)) return null;
      seen.add(key);
      const move=inspect(row,2);
      if(move) return move;
      if(save && stored.length<192 && row.sources.length>1 && spans(row.terms)<=12) stored.push(row);
      // Floor half the coefficients using x >= 0, then floor the RHS using integrality.
      if(cuts.length<128 && row.terms.some(([,c])=>c%2)) {
        const terms=row.terms.map(([v,c])=>[v,Math.floor(c/2)]).filter(([,c])=>c);
        const rhs=Math.floor(row.rhs/2), cutKey=`${terms}:${rhs}`;
        if(terms.length && !seenCuts.has(cutKey)) {
          seenCuts.add(cutKey);cuts.push({kind:'floor',a:row,terms,rhs,sources:row.sources});
        }
      }
      return null;
    }
    for(let i=0;i<bases.length && remaining>0;i++) for(let j=i+1;j<bases.length && remaining>0;j++,remaining--) {
      const move=explore(bases[i],bases[j],true);if(move) return move;
    }
    for(const a of stored) for(let j=0;j<bases.length && remaining>0;j++,remaining--) {
      const move=explore(a,bases[j],false);if(move) return move;
    }
    remaining=9000;
    const partners=[...bases,...stored,...cuts];
    for(const cut of cuts) for(const row of partners) {
      if(--remaining<0) break;
      if(cut===row) continue;
      const joined=combine(cut,row), move=joined && inspect(joined,3);
      if(move) return move;
    }
    // Prefer tight short inequalities, and extend only through shared cells.
    // This searches proof expressions, not layouts or variable assignments.
    const incident=new Map();
    for(const row of bases) for(const [v] of row.terms) {
      if(!incident.has(v)) incident.set(v,[]);
      incident.get(v).push(row);
    }
    const rank=r=>r.rhs-r.terms.reduce((s,[,c])=>s+Math.min(0,c),0)+r.terms.length*.22;
    let layer=[...stored,...cuts];
    for(let size=3;size<=6 && layer.length;size++) {
      const next=[];
      layer.sort((a,b)=>rank(a)-rank(b));
      for(const a of layer.slice(0,64)) {
        const candidates=new Set(a.terms.flatMap(([v])=>incident.get(v)));
        for(const b of candidates) {
          if(a.sources.includes(b.row.source)) continue;
          const row=combine(a,b);
          if(!row) continue;
          const level=a.kind==='floor'||a.cut?3:2;
          const key=`${level}:${row.terms}:${row.rhs}`;
          if(seen.has(key)) continue;
          seen.add(key);
          const move=inspect(row,level);
          if(move) return move;
          row.cut=level===3;
          next.push(row);
        }
      }
      layer=next;
    }
    return null;
  }

  function eachSubset(items,count,visit,chosen=[],start=0) {
    if(!count) return visit(chosen);
    for(let i=start;i<=items.length-count;i++) {
      chosen.push(items[i]);
      const stop=eachSubset(items,count-1,visit,chosen,i+1);
      chosen.pop();
      if(stop) return stop;
    }
    return null;
  }

  // Each clause is the inequality “at least one of these literals is true”.
  // Adding two clauses with opposite pivot literals and rounding gives their resolvent.
  function resolution(rows,step,{target,budget=14000}={}) {
    const usable=rows.filter(r=>r.vs.length<=8);
    const vars=[...new Set(usable.flatMap(r=>r.vs))];
    if(!vars.length || target!==undefined && !vars.includes(target)) return null;
    const bits=new Map(vars.map((v,i)=>[v,1n<<BigInt(i)]));
    const literals=(mask)=>vars.filter(v=>mask&bits.get(v));
    const initial=[];
    for(const row of usable) for(const value of [0,1]) {
      const size=value ? row.vs.length-row.rhs+1 : row.rhs+1;
      eachSubset(row.vs,size,vs=>{
        const mask=vs.reduce((m,v)=>m|bits.get(v),0n);
        initial.push({pos:value?mask:0n,neg:value?0n:mask,row,depth:0});
      });
    }
    const lim={left:budget};
    function eliminate(protect) {
      let clauses=initial.slice();
      const remaining=vars.filter(v=>v!==protect);
      while(remaining.length && lim.left>0) {
        const incidence=new Map(remaining.map(v=>[v,[0,0]]));
        for(const row of clauses) for(const v of remaining) {
          const bit=bits.get(v);
          if(row.pos&bit) incidence.get(v)[0]++;
          if(row.neg&bit) incidence.get(v)[1]++;
        }
        let pivot, score=Infinity;
        for(const [v,[pos,neg]] of incidence) {
          const cost=pos*neg;
          if(cost<score) {pivot=v;score=cost;}
        }
        if(score>lim.left) {lim.left=0;return null;}
        if(clauses.length>1100) return null;
        remaining.splice(remaining.indexOf(pivot),1);
        const bit=bits.get(pivot), pos=[],neg=[], kept=[];
        for(const clause of clauses) {
          if(clause.pos&bit) pos.push(clause);
          else if(clause.neg&bit) neg.push(clause);
          else kept.push(clause);
        }
        for(const a of pos) for(const b of neg) {
          if(--lim.left<0) return null;
          const pos=(a.pos|b.pos)^bit, neg=(a.neg|b.neg)^bit;
          if(pos&neg) continue;
          const mask=pos|neg;
          const unit=mask!==0n && (mask&(mask-1n))===0n;
          if(unit && (target===undefined || mask===bits.get(target))) {
            return {pos,neg,pivot,a,b,depth:1+Math.max(a.depth,b.depth)};
          }
          if(mask===0n || kept.some(c=>(c.pos&pos)===c.pos && (c.neg&neg)===c.neg)) continue;
          for(let i=kept.length-1;i>=0;i--) {
            const c=kept[i];
            if((c.pos&pos)===pos && (c.neg&neg)===neg) kept.splice(i,1);
          }
          kept.push({pos,neg,pivot,a,b,depth:1+Math.max(a.depth,b.depth)});
        }
        clauses=kept;
      }
      const bit=bits.get(protect);
      return clauses.find(c=>(c.pos|c.neg)===bit)??null;
    }
    const order=target===undefined?[undefined,...vars]:[target];
    for(const v of order) {
      if(lim.left<=0) break;
      const proved=eliminate(v);
      if(!proved) continue;
      const sources=new Set(), nodes=[], ids=new Map();
      function add(c) {
        if(ids.has(c)) return ids.get(c);
        const from=c.row ? null : [add(c.a),add(c.b)];
        if(c.row) sources.add(c.row.source);
        const id=nodes.length;
        ids.set(c,id);
        nodes.push({positive:literals(c.pos),negative:literals(c.neg),from,pivot:c.pivot,row:c.row});
        return id;
      }
      add(proved);
      return step(literals(proved.pos|proved.neg),Number(!!proved.pos),3,
        {kind:'resolution',sources:[...sources],nodes,depth:proved.depth});
    }
    return null;
  }

  function constraints(p,visible,marks,ns,knownSafe) {
    const n=ns.length;
    const rows=[], local=[], unknown=[], frontier=new Set(), seen=new Map();
    let invalid=false;
    function add(vs,rhs,source) {
      if(rhs<0 || rhs>vs.length) { invalid=true; return; }
      if(!vs.length) return;
      const key=vs.join(',');
      if(seen.has(key)) { if(seen.get(key).rhs!==rhs) invalid=true; return; }
      const row={vs,rhs,source};
      seen.set(key,row); rows.push(row);
      if(source!==-1) { local.push(row); for(const v of vs) frontier.add(v); }
    }
    for(let i=0;i<n;i++) {
      if(visible[i]>=0) {
        let rhs=visible[i];
        const vs=[];
        for(const v of ns[i]) if(marks.has(v)) rhs--; else if(visible[v]<0 && !knownSafe?.has(v)) vs.push(v);
        add(vs,rhs,i);
      } else if(!marks.has(i) && !knownSafe?.has(i)) unknown.push(i);
    }
    add(unknown,p.mines-marks.size,-1);
    return {rows,local,unknown,frontier,invalid};
  }

  function elementary(rows,step) {
    for(const row of rows) if(row.rhs===0 || row.rhs===row.vs.length) {
      const m=step(row.vs,Number(row.rhs!==0),0,{kind:'count',sources:[row.source],row});
      if(m) return m;
    }
    for(let i=0;i<rows.length;i++) for(let j=i+1;j<rows.length;j++) {
      const a=rows[i],b=rows[j];
      const [A,B,I]=split(a.vs,b.vs);
      if(!I.length) continue;
      const low=Math.max(0,a.rhs-A.length,b.rhs-B.length), high=Math.min(I.length,a.rhs,b.rhs);
      if(low>high) continue;
      for(const [vs,l,u] of [[A,a.rhs-high,a.rhs-low],[B,b.rhs-high,b.rhs-low],[I,low,high]]) {
        if(!vs.length || u!==0 && l!==vs.length) continue;
        const m=step(vs,Number(u!==0),1,
          {kind:'difference',sources:[a.source,b.source],a,b,shared:I,low,high,lower:l,upper:u});
        if(m) return m;
      }
    }

    return null;
  }

  function cycleProof(local,step) {
    if(local.length<6) return null;
    const incident=new Map();
    for(const row of local) for(const v of row.vs) {
      if(!incident.has(v)) incident.set(v,[]);
      incident.get(v).push(row);
    }
    const seen=new Set();
    for(const first of local) {
      if(seen.has(first)) continue;
      const component=[first], links=new Map();
      seen.add(first);
      for(const row of component) {
        const shared=new Set(row.vs.flatMap(v=>incident.get(v)));
        shared.delete(row);
        links.set(row,shared);
        for(const other of shared) if(!seen.has(other)) {
          seen.add(other);
          component.push(other);
        }
      }
      if(component.length<6 || component.length%2 || component.some(row=>links.get(row).size!==2)) continue;
      const ordered=[first];
      while(ordered.length<component.length) {
        ordered.push([...links.get(ordered.at(-1))].find(row=>row!==first && row!==ordered.at(-2)));
      }
      for(const direction of [1,-1]) {
        let sum;
        for(const [i,row] of ordered.entries()) {
          const k=i%2?-direction:direction;
          const b={kind:'equation',row,k,terms:row.vs.map(v=>[v,k]),rhs:k*row.rhs,sources:[row.source]};
          if(!sum) {sum=b;continue;}
          const terms=new Map(sum.terms);
          for(const [v,c] of b.terms) terms.set(v,(terms.get(v)??0)+c);
          sum={kind:'sum',a:sum,b,terms:[...terms].filter(([,c])=>c).sort(([a],[b])=>a-b),
            rhs:sum.rhs+b.rhs,sources:[...sum.sources,row.source]};
        }
        const min=sum.terms.reduce((s,[,c])=>s+Math.min(0,c),0);
        if(sum.rhs!==min) continue;
        for(const value of [0,1]) {
          const vs=sum.terms.filter(([,c])=>Number(c<0)===value).map(([v])=>v);
          if(!vs.length) continue;
          const move=step(vs,value,2,{kind:'linear',sources:sum.sources,inequality:sum,min,slack:0});
          if(move) return move;
        }
        break;
      }
    }
    return null;
  }

  function totalProof(rows,step,target) {
    const total=rows.find(r=>r.source===-1), local=rows.filter(r=>r.source!==-1);
    if(!total || !local.length) return null;
    const r=random(7+Number(target??0));
    for(const direction of [-1,1]) for(let trial=0;trial<10;trial++) {
      const coeff=new Int16Array(total.vs.at(-1)+1), weights=new Int8Array(local.length);
      for(const v of total.vs) coeff[v]=direction;
      let slack=direction*total.rhs-(direction<0?-total.vs.length:0);
      const order=range(local.length);
      for(let pass=0;pass<7;pass++) {
        for(let i=order.length-1;i>0;i--) {const j=r(i+1);[order[i],order[j]]=[order[j],order[i]];}
        for(const i of order) {
          const row=local[i], old=weights[i];
          let best=old, score=slack;
          for(const weight of [0,-direction,direction]) {
            const delta=weight-old;
            const next=slack+delta*row.rhs+row.vs.reduce((s,v)=>s+Math.min(0,coeff[v])-Math.min(0,coeff[v]+delta),0);
            if(next<score || next===score && (trial===0?weight===0:r(2)===0)) {score=next;best=weight;}
          }
          slack=score; weights[i]=best;
          for(const v of row.vs) coeff[v]+=best-old;
          if(!weights.some(Boolean) || slack<0 || !(target===undefined?coeff.some(c=>Math.abs(c)>slack):Math.abs(coeff[target])>slack)) continue;
          const terms=total.vs.flatMap(v=>coeff[v]?[[v,coeff[v]]]:[]);
          const eq=(row,k)=>({kind:'equation',row,k,terms:row.vs.map(v=>[v,k]),rhs:k*row.rhs,sources:[row.source]});
          let sum=eq(total,direction);
          for(const [j,k] of weights.entries()) if(k) {
            const b=eq(local[j],k), all=new Map(sum.terms);
            for(const [v,c] of b.terms) all.set(v,(all.get(v)??0)+c);
            sum={kind:'sum',a:sum,b,terms:[...all].filter(([,c])=>c).sort(([a],[b])=>a-b),rhs:sum.rhs+b.rhs,sources:[...sum.sources,local[j].source]};
          }
          const min=sum.rhs-slack;
          for(const value of [0,1]) {
            const vs=terms.filter(([,c])=>Number(c<0)===value && Math.abs(c)>slack).map(([v])=>v);
            if(vs.length) {
              const move=step(vs,value,2,{kind:'linear',sources:sum.sources,inequality:sum,min,slack});
              if(move) return move;
            }
          }
        }
      }
    }
    return null;
  }

  function analyze(p,visible,marks,options={}) {
    const ns=options.ns??adj(p.w,p.h);
    const {rows,local,frontier,invalid}=constraints(p,visible,marks,ns,options.knownSafe);
    const result=(status,move=null)=>({status,move,frontier:frontier.size});
    const step=(vs,value,level,proof)=>vs.some(v=>!options.skip?.has(v)) ? result('move',{vs,value,level,...proof}) : null;
    if(invalid) return result('invalid');
    const move=elementary(rows,step) || cycleProof(local,step) || weightedProof(local,step) || resolution(local,step,{budget:9000}) ||
      (options.useTotal && totalProof(rows,step));
    return move || result('stuck');
  }

  // Verify the support of an already established conclusion. An opposing
  // witness must violate at least one clue in every possible proof of it.
  function minimumProof(p,visible,marks,move,{ns=adj(p.w,p.h),budget=120000,
    target=move.vs[0],value=move.value,alternative=false,knownSafe}={}) {
    const {rows,unknown,frontier}=constraints(p,visible,marks,ns,knownSafe);
    if(!alternative && move.sources.length===1) return {...move,minimum:true};
    let left=budget;
    const bits=rows.map((_,i)=>1n<<BigInt(i));
    const full=bits.reduce((a,b)=>a|b,0n);
    const support=(alternative?[]:move.sources).reduce((mask,s)=>mask|bits[rows.findIndex(row=>row.source===s)],0n);
    const conflicts=[];
    const degree=new Int16Array(visible.length);
    for(const row of rows) if(row.source!==-1) for(const v of row.vs) degree[v]++;
    const order=[...frontier].sort((a,b)=>degree[b]-degree[a]||a-b);
    const free=unknown.filter(v=>!frontier.has(v) && v!==target);
    const total=rows.at(-1)?.source===-1 ? rows.at(-1) : null;
    const totalBit=total ? bits.at(-1) : 0n;
    let witness;
    const checked=new Map();
    function possible(selected) {
      if(checked.has(selected)) {
        const cached=checked.get(selected);
        if(cached) witness=cached;
        return !!cached;
      }
      const equations=rows.filter((r,i)=>r!==total && (selected&bits[i]));
      const active=selected&totalBit ? [...equations,total] : equations;
      const used=new Set(equations.flatMap(r=>r.vs));
      const variables=order.filter(v=>v!==target && used.has(v));
      const unused=order.filter(v=>v!==target && !used.has(v)).concat(free);
      const values=new Int8Array(visible.length).fill(-1), trail=[];
      function assign(v,x) {values[v]=x;trail.push(v);}
      function undo(mark) {while(trail.length>mark) values[trail.pop()]=-1;}
      assign(target,1-value);
      function search() {
        if(--left<0) return null;
        const mark=trail.length;
        let changed;
        do {
          changed=false;
          for(const row of active) {
            let left=row.rhs, free=0;
            for(const v of row.vs) if(values[v]<0) free++; else left-=values[v];
            if(left<0 || left>free) {undo(mark);return false;}
            if(free && (left===0 || left===free)) {
              for(const v of row.vs) if(values[v]<0) assign(v,Number(left!==0));
              changed=true;
            }
          }
        } while(changed);
        const v=variables.find(v=>values[v]<0);
        if(v===undefined) {
          let remaining=p.mines-marks.size-unknown.filter(v=>values[v]===1).length;
          for(const v of unused) if(values[v]<0) values[v]=Number(remaining-->0);
          witness=values;
          return true;
        }
        const first=witness?.[v]??0;
        for(const x of [first,1-first]) {
          const fork=trail.length;
          assign(v,x);
          const found=search();
          if(found!==false) return found;
          undo(fork);
        }
        undo(mark);
        return false;
      }
      const result=search();
      if(result!==null) checked.set(selected,result?witness:null);
      return result;
    }
    function excludeWitness() {
      let differs=0n;
      for(let i=0;i<rows.length;i++) {
        const row=rows[i];
        if(row.vs.reduce((sum,v)=>sum+witness[v],0)!==row.rhs) differs|=bits[i];
      }
      if(!differs) throw Error('Proof disagrees with a public layout');
      if(conflicts.some(c=>(c&differs)===c)) return;
      for(let i=conflicts.length-1;i>=0;i--) if((conflicts[i]&differs)===differs) conflicts.splice(i,1);
      conflicts.push(differs);
    }
    let mandatory=0n;
    for(let i=0;i<rows.length;i++) if((alternative?full:support)&bits[i]) {
      if(possible(full^bits[i])) {
        excludeWitness();
        mandatory|=bits[i];
      }
      if(left<0) return {...move,minimum:false};
    }
    if(!alternative && mandatory===support) return {...move,minimum:true};
    const count=mask=>{let n=0;for(;mask;mask&=mask-1n) n++;return n;};
    function hit(selected,remaining) {
      if(--left<0) return null;
      let choice=0n, width=Infinity;
      const uncovered=conflicts.filter(c=>!(c&selected));
      if(!uncovered.length) return selected;
      if(!remaining) return null;
      let disjoint=0, used=0n;
      for(const c of uncovered) {
        if(!(used&c)) {used|=c;disjoint++;}
        if(disjoint>remaining) return null;
        const size=count(c);
        if(size<width) {width=size;choice=c;}
      }
      for(let c=choice;c;c&=c-1n) {
        const next=hit(selected|(c&-c),remaining-1);
        if(next!==null || left<0) return next;
      }
      return null;
    }
    const weight=count(mandatory);
    for(let size=weight;size<move.sources.length && left>=0;size++) {
      while(left>=0) {
        const selected=hit(mandatory,size-weight);
        if(selected===null) break;
        const found=possible(selected);
        if(found===null) break;
        if(found) {excludeWitness();continue;}
        const subset=rows.filter((_,i)=>selected&bits[i]);
        const shorter=targetProof(subset,target,value);
        return shorter ? {...shorter,minimum:true} : {...move,minimum:false,proofUnavailable:true};
      }
    }
    return {...move,minimum:left>=0};
  }

  function targetProof(rows,target,value) {
    const step=(vs,v,level,proof)=>v===value && vs.includes(target)?{vs,value,level,...proof}:null;
    return elementary(rows,step) || cycleProof(rows.filter(row=>row.source!==-1),step) ||
      weightedProof(rows,step) || totalProof(rows,step,target) || resolution(rows,step,{target,budget:120000});
  }

  function minimizeMove(p,visible,marks,move,ns,judgment,{minimumBudget=120000,skip,knownSafe}={}) {
    // The elementary pass checks every one- and two-row deduction first.
    if(move.level<=1) return {...move,minimum:true,positionMinimum:true};
    let best=minimumProof(p,visible,marks,move,{ns,budget:minimumBudget,target:move.vs.find(v=>!skip?.has(v)),knownSafe});
    if(best.minimum && best.sources.length<=2) return {...best,positionMinimum:true};
    const context=constraints(p,visible,marks,ns,knownSafe);
    judgment??=classifyRows(visible,context,minimumBudget,true);
    let minimum=best.minimum && judgment.status==='complete';
    const {rows,unknown}=context;
    const groups=equivalentGroups(rows);
    const grouped=new Set(groups.flat());
    const rest=unknown.filter(v=>!grouped.has(v));
    if(rest.length) groups.push(rest);
    for(const group of groups) {
      if(!minimum || best.sources.length<=2) break;
      if(group.includes(best.vs.find(v=>!skip?.has(v)))) continue;
      const v=group.find(v=>!skip?.has(v));
      if(v===undefined) continue;
      const state=judgment.state[v];
      if(state!=='safe' && state!=='mine') continue;
      const check=minimumProof(p,visible,marks,best,{ns,target:v,value:Number(state==='mine'),alternative:true,budget:minimumBudget,knownSafe});
      minimum &&= check.minimum;
      if(check.sources.length<best.sources.length) best=check;
    }
    return {...best,positionMinimum:minimum || best.sources.length<=2};
  }

  function openingProof(p,visible,move,ns,judgment=classify(p,visible,{nodeBudget:120000}),options) {
    const best=minimizeMove(p,visible,new Set(),move,ns,judgment,options);
    return {...best,openingMinimum:best.positionMinimum};
  }

  function batchMove(p,visible,marks,move,ns,budget=120000,knownSafe) {
    const context=constraints(p,visible,marks,ns,knownSafe);
    const rows=context.rows.filter(r=>move.sources.includes(r.source));
    const local=rows.filter(r=>r.source!==-1), frontier=new Set(local.flatMap(r=>r.vs));
    const {unknown}=context;
    const judged=classifyRows(visible,{rows,local,frontier,unknown},budget,true);
    if(judged.status!=='complete') return null;
    const safe=unknown.filter(v=>judged.state[v]==='safe'), mines=unknown.filter(v=>judged.state[v]==='mine');
    const groups=equivalentGroups(rows), equivalent=new Map(groups.flatMap(g=>g.map(v=>[v,g])));
    const symmetric=[...new Set(move.vs.flatMap(v=>equivalent.get(v)??[v]))].sort((a,b)=>a-b);
    const proofs=[{...move,symmetric}], covered=new Set(symmetric);
    for(const group of groups) {
      const v=group[0], state=judged.state[v];
      if(state!=='safe' && state!=='mine' || group.every(i=>covered.has(i))) continue;
      const value=Number(state==='mine'), target=group.find(i=>!covered.has(i));
      const proof=targetProof(rows,target,value);
      if(!proof) return null;
      const symmetric=[...new Set(proof.vs.flatMap(i=>equivalent.get(i)??[i]))].sort((a,b)=>a-b);
      for(const i of symmetric) covered.add(i);
      proofs.push({...proof,symmetric});
    }
    return covered.size===safe.length+mines.length ? {...move,safe,mines,proofs} : null;
  }

  function mirroredBatch(p,visible,marks,base,ns,skip) {
    const {w,h}=p;
    const reflections=[(x,y)=>[w-1-x,y],(x,y)=>[x,h-1-y],(x,y)=>[w-1-x,h-1-y]];
    if(w===h) reflections.push((x,y)=>[y,x],(x,y)=>[w-1-y,h-1-x],(x,y)=>[w-1-y,x],(x,y)=>[y,h-1-x]);
    const {rows}=constraints(p,visible,marks,ns);
    for(const reflect of reflections) {
      const map=v=>{
        if(v<0) return v;
        const [x,y]=reflect(v%w,Math.floor(v/w));
        return y*w+x;
      };
      if(!visible.every((n,v)=>n===visible[map(v)] && marks.has(v)===marks.has(map(v)))) continue;
      const sources=base.sources.map(map), subset=rows.filter(r=>sources.includes(r.source));
      if(subset.length!==sources.length) continue;
      for(const [cells,value] of [[base.safe,0],[base.mines,1]]) {
        const target=cells.map(map).find(v=>!skip.has(v));
        if(target===undefined) continue;
        const proof=targetProof(subset,target,value);
        if(proof && proof.sources.length===base.sources.length) {
          // A symmetry preserves the minimum clue count on this public position.
          const batch=batchMove(p,visible,marks,{...proof,minimum:true,positionMinimum:true},ns);
          if(batch) return batch;
        }
      }
    }
    return null;
  }

  // Classify the current public position, independently of the hidden witness.
  function classify(p,visible,{nodeBudget=35000,proven=new Set()}={}) {
    return classifyRows(visible,constraints(p,visible,proven,adj(p.w,p.h)),nodeBudget);
  }

  function classifyRows(visible,{rows,local,unknown,frontier,invalid},nodeBudget,grouped=false,witnessOnly=false) {
    const n=visible.length, total=rows.find(row=>row.source===-1);
    const state=visible.map(x=>x<0?'unknown':'open');
    let nodes=0, branchDepth=0, depth=Infinity, maxDepth=0;
    const result=status=>({status,state,nodes,depth:Number.isFinite(depth)?depth:0,maxDepth});
    if(invalid) return result('invalid');
    const values=new Int8Array(n).fill(-1), trail=[];
    const degree=new Int16Array(n);
    for(const row of local) for(const v of row.vs) degree[v]++;
    const order=[...frontier].sort((a,b)=>degree[b]-degree[a]||a-b);
    const outside=unknown.filter(v=>!frontier.has(v));
    const possible=new Uint8Array(n);
    let base;
    function assign(v,value) {values[v]=value;trail.push(v);}
    function undo(mark) {while(trail.length>mark) values[trail.pop()]=-1;}
    function propagate() {
      let changed;
      do {
        changed=false;
        for(const row of rows) {
          let left=row.rhs, free=0;
          for(const v of row.vs) if(values[v]<0) free++; else left-=values[v];
          if(left<0||left>free) return false;
          if(free && (left===0||left===free)) {
            for(const v of row.vs) if(values[v]<0) assign(v,Number(left!==0));
            changed=true;
          }
        }
      } while(changed);
      return true;
    }
    function witness() {
      let left=total?.rhs??0;
      if(total) for(const v of unknown) if(values[v]===1) left--;
      // Cells outside the clue frontier are interchangeable apart from the total.
      const first=base===undefined;
      if(first) base=values.slice();
      for(const v of unknown) {
        let value=values[v];
        if(value<0) {
          value=Number(left>0);
          left-=value;
        }
        possible[v]|=1<<value;
        if(first) base[v]=value;
      }
      if(outside.length) {
        let mask=total?0:3;
        for(const v of outside) mask|=possible[v];
        for(const v of outside) possible[v]=mask;
      }
    }
    // null is exhausted, not a contradiction.
    function search(level=0) {
      if(nodes>=nodeBudget) return null;
      nodes++;
      branchDepth=Math.max(level,branchDepth);
      const mark=trail.length;
      let found=false;
      if(propagate()) {
        const v=order.find(i=>values[i]<0);
        if(v===undefined) {witness();found=true;}
        else for(const value of [base?.[v]??0,1-(base?.[v]??0)]) {
          const fork=trail.length;
          assign(v,value);
          found=search(level+1);
          undo(fork);
          if(found!==false) break;
        }
      }
      undo(mark);
      return found;
    }
    const first=search();
    if(!first) return result(first===null?'budget':'invalid');
    if(witnessOnly) return {...result('complete'),bombs:Array.from(base,x=>x===1)};
    let exhausted=false;
    // Start with the witness's safe cells. A counterexample can remove many
    // candidates at once, and the same witnesses also classify forced mines.
    const targets=(grouped?equivalentGroups(local):order.map(v=>[v])).concat(outside.length?[outside]:[])
      .sort(([a],[b])=>base[a]-base[b]);
    for(const group of targets) {
      const v=group[0];
      if(grouped) {
        let mask=0;
        for(const i of group) mask|=possible[i];
        for(const i of group) possible[i]=mask;
      }
      if(possible[v]===3) continue;
      assign(v,1-base[v]);
      branchDepth=0;
      const found=search(); undo(0);
      if(found===false) {
        depth=Math.min(depth,branchDepth);
        maxDepth=Math.max(maxDepth,branchDepth);
        const kind=base[v]?'mine':'safe';
        for(const i of group) state[i]=kind;
      }
      if(found===null) {exhausted=true;break;}
    }
    for(const v of unknown) if(possible[v]===3) state[v]='either';
    return result(exhausted?'budget':'complete');
  }

  function gate(classification,cells) {
    if(classification.status==='invalid') return {status:'invalid'};
    const blocked=cells.find(v=>['mine','either'].includes(classification.state[v]));
    if(blocked!==undefined) return {status:'blocked',cell:blocked};
    return {status:cells.every(v=>classification.state[v]==='safe')?'safe':'unknown'};
  }

  function compareDifficulty(a,b) {
    const spread=r=>r.sections.filter(s=>s.advanced>0).length;
    return b.averageClues-a.averageClues || b.advancedDensity-a.advancedDensity || spread(b)-spread(a) || b.clues-a.clues ||
      b.multiSteps-a.multiSteps || a.longestShallowRun-b.longestShallowRun;
  }

  function compareOpening(a,b) {
    return compareDifficulty(a,b) ||
      b.openingClues-a.openingClues || Number(b.openingMinimum)-Number(a.openingMinimum) ||
      b.openingDepth-a.openingDepth || a.firstOpened-b.firstOpened;
  }

  // The caller has proved all targets safe, either by techniques or by gate().
  function advance(board,p,visible,cells,marks,{allowUnsolved=false,exact=false,flags=marks}={}) {
    const show=witness=>{
      const next=visible.slice();
      let opened=0;
      for(const v of cells) {
        if(!exact) opened+=reveal(witness,next,v);
        else if(next[v]<0 && !witness.bombs[v]) {next[v]=witness.clues[v];opened++;}
      }
      return {board:witness,visible:next,opened};
    };
    const fallback=show(board);
    const base=verify(board,p,{visible:fallback.visible,marks,flags,certify:true});
    const unchanged=base.status==='passed' || (allowUnsolved && base.status!=='invalid') ? fallback : null;
    // Swap cells outside the frontier to preserve every public equation.
    const {unknown,frontier}=constraints(p,visible,new Set(),board.ns);
    const targets=new Set(cells), near=new Set(cells.flatMap(v=>board.ns[v]));
    const pool=unknown.filter(v=>!frontier.has(v) && !targets.has(v) && !marks?.has(v));
    const mined=pool.filter(v=>board.bombs[v]), empty=pool.filter(v=>!board.bombs[v]);
    if(!mined.length || !empty.length) return unchanged;
    const nearby=pool.filter(v=>near.has(v) && (board.bombs[v]?empty:mined).some(i=>!near.has(i)));
    if(!nearby.length) return unchanged;
    const randomize=random(board.seed+visible.filter(v=>v>=0).length*31+cells[0]);
    const attempts=Math.min(nearby.length,4);
    for(let j=0;j<attempts;j++) {
      const a=nearby.splice(randomize(nearby.length),1)[0];
      const opposite=(board.bombs[a]?empty:mined).filter(v=>!near.has(v));
      const b=opposite[randomize(opposite.length)];
      const bombs=board.bombs.slice();
      [bombs[a],bombs[b]]=[bombs[b],bombs[a]];
      const changed={...board,bombs,clues:board.ns.map(row=>row.reduce((sum,v)=>sum+Number(bombs[v]),0))};
      const next=show(changed);
      const report=verify(changed,p,{visible:next.visible,marks,flags,certify:true});
      if(report.status==='passed' && (base.status!=='passed' || compareDifficulty(base,report)>=0)) return next;
    }
    return unchanged;
  }

  function proofDepth(m) {
    if(m.kind==='count') return 0;
    if(m.kind==='difference') return 1;
    const depth=r=>r.row ? 0 : 1+Math.max(depth(r.a),r.b ? depth(r.b) : 0);
    return m.depth??depth(m.inequality);
  }

  function confirmationTargets(state,flags) {
    return new Map(state.flatMap((kind,v)=>kind==='safe' || kind==='mine' && !flags.has(v)?[[v,kind]]:[]));
  }

  function verify(board,p,options={}) {
    p={...p,mines:board.mines};
    const visible=options.visible?.slice()??opening(board), marks=new Set(options.marks), {ns}=board;
    const flags=new Set(options.flags??marks);
    const report={steps:0,openingMinimum:true,trace:[]};
    const measureDifficulty=options.measureDifficulty!==false;
    if(measureDifficulty) Object.assign(report,{openingClues:0,openingDepth:0,clues:0,
      averageClues:0,advancedDensity:0,multiSteps:0,longestShallowRun:0,sections:[]});
    let opened=visible.filter(v=>v>=0).length;
    const firstOpened=opened;
    if(measureDifficulty) report.firstOpened=firstOpened;
    if(!opened && !options.allowEmpty) return {...report,status:'invalid'};
    let point, openingPoint, shallowRun=0, peak=0;
    const supports=[];
    const checkpoint=(cells)=>({visible:visible.slice(),marks:[...marks],cells});
    let round;
    const initialConfirmed=new Map(options.confirmed);
    const commitRound=()=>{
      const cells=kind=>[...round.targets].filter(([,state])=>state===kind).map(([v])=>v);
      const commit={safe:cells('safe'),mines:cells('mine')};
      for(const v of commit.mines) {marks.add(v);flags.add(v);}
      for(const v of commit.safe) {visible[v]=board.clues[v];flags.delete(v);opened++;}
      round=undefined;
      return commit;
    };
    while(opened<visible.length-p.mines) {
      if(options.certify && !round) {
        const publicState=classifyRows(visible,constraints(p,visible,new Set(),ns),120000,true);
        if(publicState.status!=='complete') return {...report,status:publicState.status,opened};
        const targets=confirmationTargets(publicState.state,flags);
        const confirmed=new Map([...initialConfirmed].filter(([v,kind])=>targets.get(v)===kind));
        initialConfirmed.clear();
        round={targets,confirmed};
        if(confirmed.size && confirmed.size===targets.size) {commitRound();continue;}
      }
      const a=options.certify ? hint(p,visible,[...marks].filter(v=>flags.has(v)),flags,{
        opening:!options.visible && opened===firstOpened,
        useTotal:options.useTotal,
        confirmed:round.confirmed}) : analyze(p,visible,marks,{ns,useTotal:options.useTotal});
      if(!a.move) {
        const {frontier,unknown}=constraints(p,visible,marks,ns);
        if(options.points) point=checkpoint(frontier.size?[...frontier]:unknown);
        return {...report,status:a.status,opened,...(point?{point}:{}),...(openingPoint?{openingPoint}:{})};
      }
      let m=a.move;
      const used=options.certify?new Set(a.marks):marks;
      if(!report.steps) {
        if(!options.certify && !options.visible) {
          m=openingProof(p,visible,m,ns);
        }
        if(options.certify && !m.positionMinimum) return {...report,status:'minimum-unavailable',opened};
        if(measureDifficulty) {
          report.openingClues=m.sources.length;
          report.openingDepth=proofDepth(m);
        }
        report.openingMinimum=m.openingMinimum??m.sources.length<=2;
        if(options.points && m.level>=2) openingPoint=checkpoint([...constraints(p,visible,marks,ns).frontier]);
      }
      const safe=m.safe??(m.value?[]:m.vs), mines=m.mines??(m.value?m.vs:[]);
      if(safe.some(v=>visible[v]>=0||used.has(v)||board.bombs[v]) ||
        mines.some(v=>visible[v]>=0||used.has(v)||!board.bombs[v]) ||
        (a.prior??[]).some(move=>move.mines.some(v=>!board.bombs[v]))) return {...report,status:'invalid',opened};
      report.steps++;
      if(measureDifficulty || options.points) peak=Math.max(peak,m.sources.length);
      if(measureDifficulty) report.clues=peak;
      if(measureDifficulty && options.certify) {
        const count=m.sources.length;
        supports.push(count);
        report.multiSteps+=Number(count>=3);
        shallowRun=count>=3?0:shallowRun+1;
        report.longestShallowRun=Math.max(report.longestShallowRun,shallowRun);
      }
      if(m.level>=2 && options.points && (!point || m.sources.length>=peak)) {
        point=checkpoint([...new Set(m.sources.flatMap(s=>s<0?m.vs:ns[s]).filter(v=>visible[v]<0 && !marks.has(v)))]);
      }
      let commit;
      if(round) {
        if(safe.some(v=>round.targets.get(v)!=='safe') ||
          mines.some(v=>!flags.has(v) && round.targets.get(v)!=='mine')) return {...report,status:'invalid',opened};
        const fresh=[...safe,...mines].filter(v=>round.targets.has(v) && !round.confirmed.has(v));
        if(!fresh.length) return {...report,status:'batch-unavailable',opened};
        for(const v of fresh) round.confirmed.set(v,round.targets.get(v));
        if(round.confirmed.size===round.targets.size) commit=commitRound();
      } else {
        for(const v of mines) marks.add(v);
        for(const v of safe) opened+=reveal(board,visible,v);
      }
      if(options.trace) report.trace.push({...m,...(commit?{commit}:{})});
    }
    if(supports.length) {
      report.averageClues=supports.reduce((sum,count)=>sum+count,0)/supports.length;
      report.advancedDensity=report.multiSteps/supports.length;
      report.sections=range(3).map(i=>{
        const steps=supports.slice(Math.ceil(i*supports.length/3),Math.ceil((i+1)*supports.length/3));
        return {steps:steps.length,advanced:steps.filter(count=>count>=3).length};
      });
    }
    return {...report,status:'passed',opened,...(point?{point}:{}),...(openingPoint?{openingPoint}:{})};
  }

  function hint(p,visible,proven,flags,{opening=false,minimumBudget=120000,useTotal=true,confirmed,excluded,target}={}) {
    flags=flags instanceof Set?flags:new Set(flags);
    const ns=adj(p.w,p.h), used=new Set(proven), prior=[];
    const skip=new Set(excluded);
    if(skip.size) {
      const base=hint(p,visible,proven,flags,{opening,minimumBudget,useTotal});
      if(!base.move) return base;
      const fresh=m=>m.safe.some(v=>!skip.has(v)) || m.mines.some(v=>!skip.has(v) && !flags.has(v));
      if(fresh(base.move)) return base;
      const marks=new Set(base.marks);
      const context=constraints(p,visible,marks,ns);
      const judgment=classifyRows(visible,context,minimumBudget,true);
      for(const v of flags) if(judgment.state[v]==='mine') skip.add(v);
      const reflected=mirroredBatch(p,visible,marks,base.move,ns,skip);
      if(reflected && fresh(reflected)) return {...base,move:reflected};
      const targets=context.unknown.filter(v=>!skip.has(v) && ['safe','mine'].includes(judgment.state[v]));
      if(!targets.length) return {...base,move:null,status:judgment.status==='complete'?'confirmed':'minimum-unavailable'};
      let move=analyze(p,visible,marks,{ns,useTotal,skip}).move;
      if(!move) for(const target of targets) {
        move=targetProof(context.rows,target,Number(judgment.state[target]==='mine'));
        if(move) break;
      }
      if(!move) return {...base,move:null,status:'stuck'};
      const best=minimizeMove(p,visible,marks,move,ns,judgment,{minimumBudget,skip});
      if(!best.positionMinimum) return {...base,move:null,status:'minimum-unavailable'};
      const batch=batchMove(p,visible,marks,best,ns);
      return batch && fresh(batch) ? {...base,move:batch} : {...base,move:null,status:'batch-unavailable'};
    }
    const knownSafe=new Set();
    for(const [v,kind] of confirmed??[]) {
      if(kind==='mine') used.add(v);
      if(kind==='safe') knownSafe.add(v);
    }
    if(target!==undefined) {
      const context=constraints(p,visible,used,ns,knownSafe);
      const result=(status,move=null,clues)=>({status,move,clues,marks:[...used],prior});
      if(context.invalid) return result('invalid');
      if(!context.unknown.includes(target)) return result('confirmed');
      const judgment=classifyRows(visible,context,minimumBudget,true);
      if(judgment.status==='invalid') return result('invalid');
      const state=judgment.state[target];
      if(state!=='safe' && state!=='mine') return result(judgment.status==='complete'?'target-unfixed':'minimum-unavailable');
      if(flags.has(target) && state==='mine') return result('confirmed');
      const value=Number(state==='mine');
      const move=targetProof(context.rows,target,value);
      if(!move) return result('stuck');
      const best=minimumProof(p,visible,used,move,{ns,target,value,budget:minimumBudget,knownSafe});
      if(!best.minimum) return result('minimum-unavailable');
      const batch=batchMove(p,visible,used,best,ns,minimumBudget,knownSafe);
      return result(batch?'move':'batch-unavailable',batch,best.sources.length);
    }
    while(true) {
      const a=analyze(p,visible,used,{ns,useTotal,knownSafe});
      let judgment;
      if(!a.move && a.status!=='invalid' && (confirmed?.size || confirmed?.length)) {
        const context=constraints(p,visible,used,ns,knownSafe);
        judgment=classifyRows(visible,context,minimumBudget,true);
        const fixed=context.unknown.filter(v=>['safe','mine'].includes(judgment.state[v]));
        if(!fixed.length && judgment.status==='complete') return {...a,status:'confirmed'};
        for(const target of fixed) {
          a.move=targetProof(context.rows,target,Number(judgment.state[target]==='mine'));
          if(a.move) break;
        }
      }
      if(!a.move) return a;
      const options={minimumBudget,knownSafe};
      const m=opening && !used.size && !knownSafe.size ? openingProof(p,visible,a.move,ns,undefined,options) :
        minimizeMove(p,visible,used,a.move,ns,judgment,options);
      if(!m.positionMinimum) return {...a,move:null,status:'minimum-unavailable'};
      const batch=batchMove(p,visible,used,m,ns,minimumBudget,knownSafe);
      if(!batch) return {...a,move:null,status:'batch-unavailable'};
      a.move=batch;
      if(batch.safe.length || batch.mines.some(v=>!flags.has(v))) return {...a,marks:[...used],prior};
      // Player flags may be wrong; use only flags proved from clues.
      prior.push(batch);
      for(const v of batch.mines) used.add(v);
    }
  }

  function publicBoard(p,visible,nodeBudget=150000) {
    const ns=adj(p.w,p.h);
    const result=classifyRows(visible,constraints(p,visible,new Set(),ns),nodeBudget,false,true);
    if(!result.bombs) return {status:result.status};
    const {bombs}=result, opening=visible.flatMap((x,i)=>x>=0?[i]:[]);
    const clues=ns.map(row=>row.reduce((s,v)=>s+Number(bombs[v]),0));
    return {status:'complete',board:{w:p.w,h:p.h,mines:p.mines,ns,bombs,clues,opening,first:opening[0]??0,seed:0}};
  }

  function inspect(p,visible,proven=[],flags=proven,{opening=true,confirmed=[]}={}) {
    flags=new Set(flags);
    const ns=adj(p.w,p.h), context=constraints(p,visible,new Set(),ns);
    const judged=classifyRows(visible,context,150000,true);
    if(judged.status==='invalid') return {status:'invalid'};
    const targets=confirmationTargets(judged.state,flags);
    const known=new Map([...confirmed].filter(([v,kind])=>targets.get(v)===kind));
    const fixed=[...targets.keys()].filter(v=>!known.has(v));
    if(visible.filter(v=>v>=0).length===visible.length-p.mines) return {status:'finished'};
    if(!fixed.length) return judged.status==='complete'?
      {status:targets.size?'confirmed':'blocked',safe:0,mines:0}:{status:'budget'};
    const marks=[...proven].filter(v=>flags.has(v));
    const a=hint(p,visible,marks,flags,{opening,confirmed:known});
    return {status:'deducible',safe:fixed.filter(v=>judged.state[v]==='safe').length, mines:fixed.filter(v=>judged.state[v]==='mine').length,
      clues:a.move?.sources.length,depth:a.move?proofDepth(a.move):undefined,proofStatus:a.status,partial:judged.status!=='complete'};
  }

  function expand(board,visible,flags=[],budget=1000000) {
    flags=new Set(flags);
    const ns=board.ns;
    const check=view=>{
      const context=constraints(board,view,new Set(),ns);
      const result=classifyRows(view,context,Math.max(0,Math.min(150000,budget)),true);
      budget-=Math.max(1,result.nodes);
      if(confirmationTargets(result.state,flags).size) return true;
      return result.status==='complete'?false:null;
    };
    const initial=check(visible);
    if(initial!==false) return {status:initial?'not-blocked':'budget'};
    const choices=visible.flatMap((x,i)=>x<0&&!board.bombs[i]?[i]:[]);
    // Test smaller sets to completion before returning a larger disclosure.
    for(let size=1;size<=choices.length;size++) {
      const selected=eachSubset(choices,size,cells=>{
        const view=visible.slice();
        for(const v of cells) view[v]=board.clues[v];
        if(view.filter(v=>v>=0).length===view.length-board.mines) return {status:'expanded',cells:[...cells],visible:view};
        const next=check(view);
        if(next===null) return {status:'budget'};
        if(next) return {status:'expanded',cells:[...cells],visible:view};
        return null;
      });
      if(selected) return selected;
    }
    return {status:'not-blocked'};
  }

  const openingPlans = [
    {kind:'five-chain', weights:[1,-1,1,-1,1], links:[[0],[1],[2],[3]], ends:[0,4]},
    {kind:'fork', weights:[-1,1,1,1], links:[[0],[0],[0]], ends:[1,2,3]},
    {kind:'long-chain', weights:[1,-1,1,-1], links:[[0],[1],[2]], ends:[0,3]},
  ];

  function sharesCovered(a,b,ns,view) {
    return ns[a].some(v=>view[v]<0 && ns[b].includes(v));
  }

  function seedCycle(p,ns,near,seed,mines,length,interior) {
    if(length>=ns.length-mines || length>mines) return [];
    const r=random(seed), n=ns.length, config={...p,mines}, marks=new Set();
    const allowed=v=>!interior || ns[v].length===8;
    const shared=(a,b)=>ns[a].filter(v=>ns[b].includes(v));
    const links=ns.map((_,a)=>near[a].filter(b=>allowed(b) && shared(a,b).length>=2));
    const shuffle=values=>{
      for(let i=values.length-1;i>0;i--) {
        const j=r(i+1);
        [values[i],values[j]]=[values[j],values[i]];
      }
      return values;
    };
    let budget=4500;
    const starts=[];
    function plant(givens) {
      const opened=new Set(givens), positive=[], negative=[], joints=[];
      const view=Array(n).fill(-1), map=new Int8Array(n).fill(-1);
      const rows=givens.map(v=>ns[v].filter(u=>!opened.has(u)));
      for(let i=0;i<length;i++) {
        const j=(i+1)%length, prev=(i+length-1)%length;
        const joint=rows[i].filter(v=>rows[j].includes(v));
        if(joint.length<2) return;
        joints.push(joint);
        for(const v of rows[i]) if(!rows[j].includes(v) && !rows[prev].includes(v)) {
          (i%2?negative:positive).push(v);
        }
      }
      if(!positive.length || !negative.length) return;
      const safe=r(2)?positive:negative, forced=safe===positive?negative:positive;
      const free=n-length-safe.length-forced.length-joints.reduce((sum,vs)=>sum+vs.length,0);
      // Leave room at both ends of the public mine count outside the cycle.
      const min=Math.max(length,mines-forced.length-free+1);
      const max=Math.min(joints.reduce((sum,vs)=>sum+vs.length-1,0),mines-forced.length-1);
      if(free<2 || min>max) return;
      for(const v of [...givens,...safe]) map[v]=0;
      for(const v of forced) map[v]=1;
      // Each joint can trade one mine in either direction if a clue is removed.
      const spare=[];
      for(const joint of joints) {
        const [mine,empty,...rest]=shuffle(joint);
        map[mine]=1;map[empty]=0;
        spare.push(...rest);
      }
      const extra=min+r(max-min+1)-length;
      for(const [i,v] of shuffle(spare).entries()) map[v]=Number(i<extra);
      for(const v of givens) view[v]=ns[v].filter(u=>map[u]===1).length;
      const context=constraints(config,view,marks,ns);
      if(context.invalid || elementary(context.rows,()=>true)) return;
      const move=cycleProof(context.local,(vs,value,level,proof)=>({vs,value,level,...proof}));
      if(!move) return;
      const judgment=classifyRows(view,context,120000);
      if(judgment.status!=='complete') return;
      const proof=openingProof(config,view,move,ns,judgment);
      if(proof.positionMinimum && proof.sources.length===length) starts.push({map,view,judgment,givens});
    }
    function extend(path) {
      if(--budget<0) return;
      const first=path[0], last=path.at(-1), closes=path.length===length-1;
      if(path.length===length) {plant(path);return;}
      for(const v of shuffle(links[last].filter(v=>!path.includes(v)))) {
        if(closes && !links[v].includes(first) || path.slice(closes?1:0,-1).some(u=>shared(u,v).length)) continue;
        extend([...path,v]);
        if(starts.length || budget<=0) return;
      }
    }
    for(const first of shuffle(range(n).filter(allowed))) {
      extend([first]);
      if(starts.length || budget<=0) break;
    }
    return starts;
  }

  function seedOpening(p,ns,near,seed,mines,plan,interior,compact) {
    const r=random(seed), n=ns.length, config={...p,mines}, marks=new Set();
    const allowed=v=>!interior || ns[v].length===8;
    const first=range(n).filter(allowed);
    if(!first.length) return [];
    const visible=Array(n).fill(-1), core=[first[r(first.length)]];
    for(const links of plan.links) {
      const pool=near[core[links[0]]].filter(v=>allowed(v) && !core.includes(v) &&
        core.every((u,i)=>near[u].includes(v)===links.includes(i)));
      if(!pool.length) return [];
      core.push(pool[r(pool.length)]);
    }
    const validCore=view=>core.slice(1).every((v,j)=>core.slice(0,j+1).every((u,i)=>
      sharesCovered(u,v,ns,view)===plan.links[j].includes(i)));
    const used=new Set(core), weights=new Int8Array(n);
    const ring=[...new Set(core.flatMap(v=>ns[v]))].filter(v=>!used.has(v));
    for(const [i,v] of core.entries()) for(const u of ns[v]) weights[u]+=plan.weights[i];
    for(const v of core) visible[v]=0;
    if(!validCore(visible)) return [];

    const clue=(v,map)=>ns[v].reduce((sum,u)=>sum+Number(map[u]===1),0);
    function evaluate(view,map) {
      let fixed=0, free=0;
      for(const x of map) {fixed+=Number(x===1);free+=Number(x<0);}
      if(fixed>mines || fixed+free<mines) return null;
      const rows=constraints(config,view,marks,ns);
      if(rows.invalid || elementary(rows.rows,()=>true)) return null;
      const judgment=classifyRows(view,rows,6000);
      return judgment.status==='complete' ? judgment : null;
    }
    let best;
    for(let i=0;i<8;i++) {
      const map=new Int8Array(n).fill(-1), view=visible.slice(), sign=r(2)?1:-1, density=20+r(61);
      for(const v of core) map[v]=0;
      // Saturate the signed sum at its lower bound. Only cancelled cells
      // can vary without invalidating the intended deduction.
      for(const v of ring) map[v]=Number(sign*weights[v]<0 || !weights[v] && r(100)<density);
      for(const v of core) view[v]=clue(v,map);
      const judgment=evaluate(view,map);
      if(judgment && (!best || judgment.depth>best.judgment.depth)) best={map,view,judgment,givens:core};
      if(best?.judgment.depth>=(compact?1:7)) break;
    }
    if(!best) return [];

    const qualified=[];
    const layers=compact?1:5;
    for(let layer=0;layer<=layers;layer++) {
      qualified.push(best);
      if(layer===layers) break;
      const {map,view,givens}=best;
      // Start from the proof's tips. Each additional clue commits only
      // its previously unassigned cells and leaves the old numbers intact.
      const tips=[...plan.ends.map(i=>core[i]),...givens.slice(core.length)];
      const pool=[...new Set(tips.flatMap(v=>near[v]))].filter(v=>
        view[v]<0 && map[v]!==1 && ns[v].filter(u=>map[u]<0).length>=3 &&
        tips.some(u=>sharesCovered(v,u,ns,view)));
      let next;
      for(let i=0;i<12 && pool.length;i++) {
        const v=pool[r(pool.length)], state=map.slice(), trial=view.slice(), density=24+r(44);
        state[v]=0;
        for(const u of ns[v]) if(state[u]<0) state[u]=Number(r(100)<density);
        trial[v]=clue(v,state);
        if(!validCore(trial)) continue;
        const judgment=evaluate(trial,state);
        if(!judgment || judgment.depth<best.judgment.depth-1) continue;
        if(!next || judgment.depth>next.judgment.depth || judgment.depth===next.judgment.depth &&
          judgment.maxDepth>next.judgment.maxDepth) next={map:state,view:trial,judgment,givens:[...givens,v]};
      }
      if(!next) break;
      best=next;
    }
    qualified.sort((a,b)=>b.judgment.depth-a.judgment.depth || b.judgment.maxDepth-a.judgment.maxDepth);
    return qualified.filter(item=>{
      const move=analyze(config,item.view,marks,{ns}).move;
      if(move?.sources.length!==core.length || !core.every(v=>move.sources.includes(v))) return false;
      const proof=openingProof(config,item.view,move,ns,item.judgment);
      return proof.positionMinimum && core.every(v=>proof.sources.includes(v));
    });
  }

  function seedCompact(p,ns,seed,mines) {
    const n=ns.length, r=random(seed), config={...p,mines}, marks=new Set();
    const map=new Int8Array(n).fill(-1), view=Array(n).fill(-1), givens=[];
    const largest=ns.reduce((max,row)=>Math.max(max,row.length),0);
    const centers=range(n).filter(v=>ns[v].length>=largest-2);
    // Keep old clues fixed and assign only the newly exposed neighborhood.
    while(givens.length<Math.min(7,n-mines-1)) {
      const choices=givens.length?range(n).filter(v=>view[v]<0 && map[v]!==1):centers;
      if(!choices.length) break;
      const pool=choices.filter(v=>ns[v].some(u=>map[u]<0));
      const cells=pool.length?pool:choices;
      const v=cells[r(cells.length)], ring=ns[v].filter(u=>map[u]<0);
      map[v]=0;
      let free=0, remaining=mines;
      for(const x of map) {free+=Number(x<0);remaining-=Number(x===1);}
      if(remaining<0 || remaining>free) break;
      const lo=Math.max(0,remaining-free+ring.length), hi=Math.min(remaining,ring.length);
      const count=lo+r(hi-lo+1);
      for(let i=0;i<count;i++) map[ring.splice(r(ring.length),1)[0]]=1;
      for(const u of ring) map[u]=0;
      view[v]=ns[v].filter(u=>map[u]===1).length;
      givens.push(v);
      const move=analyze(config,view,marks,{ns}).move;
      if(!move) continue;
      const judgment=classifyRows(view,constraints(config,view,marks,ns),120000);
      if(judgment.status!=='complete') break;
      const proof=openingProof(config,view,move,ns,judgment);
      if(proof.positionMinimum) return [{map,view,givens,judgment}];
      break;
    }
    return [];
  }

  function compactOverlap(p,ns,near,seed,mines,hard) {
    const n=ns.length, r=random(seed), config={...p,mines}, marks=new Set();
    const starts=[];
    for(let trial=0;trial<(hard?64:5);trial++) {
      const givens=[r(n)], signs=[1], size=hard?4+r(5):3+r(3);
      if(size>=n-mines) continue;
      while(givens.length<size) {
        const allowed=[...new Set(givens.flatMap(v=>near[v]))].filter(v=>!givens.includes(v));
        if(!allowed.length) break;
        const v=allowed[r(allowed.length)];
        const parent=hard ? givens.map((u,i)=>({i,n:ns[u].filter(x=>ns[v].includes(x)).length}))
          .sort((a,b)=>b.n-a.n)[0].i : 0;
        givens.push(v);
        signs.push(hard && r(4) ? -signs[parent] : r(2)?1:-1);
      }
      if(givens.length!==size || signs.every(s=>s===1)) continue;
      const weights=new Int8Array(n), map=new Int8Array(n).fill(-1), view=Array(n).fill(-1);
      const ring=[...new Set(givens.flatMap(v=>ns[v]))].filter(v=>!givens.includes(v));
      for(const [i,v] of givens.entries()) {
        map[v]=0;
        for(const u of ns[v]) weights[u]+=signs[i];
      }
      const sign=r(2)?1:-1, variable=ring.filter(v=>weights[v]===0);
      let forced=0;
      for(const v of ring) if(weights[v]!==0) forced+=(map[v]=Number(sign*weights[v]<0));
      // Spending one unit of slack keeps coefficients of magnitude two or
      // more forced, without forcing every cell in the uncancelled region.
      if(hard && r(2) && ring.some(v=>Math.abs(weights[v])>=2)) {
        const unit=ring.filter(v=>Math.abs(weights[v])===1);
        if(unit.length) {
          const v=unit[r(unit.length)];
          forced+=1-2*map[v];
          map[v]=1-map[v];
        }
      }
      const free=n-givens.length-ring.length;
      const lo=Math.max(0,mines-forced-free), hi=Math.min(variable.length,mines-forced);
      if(lo>hi) continue;
      const fill=lo+r(hi-lo+1);
      for(let i=0;i<fill;i++) map[variable.splice(r(variable.length),1)[0]]=1;
      for(const v of variable) map[v]=0;
      for(const v of givens) view[v]=ns[v].filter(u=>map[u]===1).length;
      const context=constraints(config,view,marks,ns);
      if(context.invalid || elementary(context.rows,()=>true)) continue;
      const move=analyze(config,view,marks,{ns}).move;
      if(!move) continue;
      const judgment=classifyRows(view,context,120000);
      if(judgment.status!=='complete') continue;
      const proof=openingProof(config,view,move,ns,judgment);
      if(proof.positionMinimum) starts.push({map,view,givens,judgment,clues:proof.sources.length});
    }
    return hard ? starts.sort((a,b)=>b.clues-a.clues || b.judgment.depth-a.judgment.depth).slice(0,3) : starts;
  }

  function construct(p,seed,ns,mines,openingSeed,continuation,hard) {
    const r=random(seed), n=ns.length;
    const config={...p,mines};
    const number=(state,v)=>ns[v].reduce((a,i)=>a+Number(state[i]===1),0);
    const amountOpen=view=>view.reduce((a,v)=>a+Number(v>=0),0);
    const {givens}=openingSeed;
    let {map,view:visible}=continuation??openingSeed, marks=new Set(continuation?.marks);
    const forks=[];
    let retries=hard?16:10;
    const analyses=new Map();
    function nextMove(view,known) {
      // Different tentative layouts can publish the same clues.
      const key=view.join(',')+':'+[...known].sort((a,b)=>a-b).join(',');
      if(!analyses.has(key)) {
        if(analyses.size>=512) analyses.delete(analyses.keys().next().value);
        analyses.set(key,analyze(config,view,known,{ns}).move);
      }
      return analyses.get(key);
    }

    function commitRing(state,ring,scale) {
      let free=0, remaining=mines;
      for(const v of state) {free+=Number(v<0);remaining-=Number(v===1);}
      if(remaining<0||remaining>free) return false;
      const max=Math.min(remaining,ring.length), min=Math.max(0,remaining-free+ring.length);
      const count=Math.max(min,Math.min(max,Math.round(ring.length*remaining/Math.max(1,free)*scale)));
      for(let k=0;k<count;k++) state[ring.splice(r(ring.length),1)[0]]=1;
      for(const v of ring) state[v]=0;
      return true;
    }

    function directedRings(fixed,view,known,targets,edge,swaps) {
      const fresh=new Set(targets), free=new Set(edge);
      const uncovered=v=>view[v]<0 && !fresh.has(v) && !known.has(v);
      const rows=range(n).filter(v=>view[v]>=0 || fresh.has(v)).map(v=>({v,vs:ns[v].filter(uncovered)}))
        .filter(({vs})=>vs.length>=2);
      const byCell=new Map();
      for(const row of rows) for(const v of row.vs) {
        if(!byCell.has(v)) byCell.set(v,[]);
        byCell.get(v).push(row);
      }
      for(const row of rows) row.links=[...new Set(row.vs.flatMap(v=>byCell.get(v)))];
      const options=new Map(), seen=new Set();
      let budget=hard?900:300;
      const maxSize=hard?6:4;
      // Search clue combinations, then force only the free cells required to reach their bound.
      function expand(group,weights) {
        const key=group.map((row,i)=>[row.v,weights[i]]).sort(([a],[b])=>a-b).join(';');
        if(!budget || seen.has(key)) return;
        seen.add(key);
        budget--;
        if(group.length>=3) {
          const terms=new Map();
          for(const [i,row] of group.entries()) for(const v of row.vs) terms.set(v,(terms.get(v)??0)+weights[i]);
          const force=[];
          for(const [v,c] of terms) if(c) {
            const value=Number(c<0);
            if(swaps.has(v) || free.has(v)) force.push([v,value]);
            else if(fixed[v]>=0 && fixed[v]!==value) {force.length=0;break;}
          }
          if(force.some(([v,value])=>fixed[v]!==value) && canPlant(fixed,force,swaps)) {
            const id=force.sort(([a],[b])=>a-b).join(';');
            if((options.get(id)?.rank??0)<group.length) options.set(id,{force,rank:group.length});
          }
        }
        if(group.length>=maxSize) return;
        const next=new Set(group.flatMap(row=>row.links));
        for(const row of next) if(!group.includes(row)) {
          if(!budget) break;
          for(const sign of [1,-1]) expand([...group,row],[...weights,sign]);
        }
      }
      const starts=rows.filter(row=>fresh.has(row.v));
      if(hard) starts.sort((a,b)=>b.vs.filter(v=>free.has(v)).length-a.vs.filter(v=>free.has(v)).length);
      for(const row of starts) for(const sign of [1,-1]) expand([row],[sign]);
      return [...options.values()].sort((a,b)=>b.rank-a.rank).slice(0,hard?16:8).map(o=>o.force);
    }

    function canPlant(state,force,swaps,plant=false) {
      // Within a group every cell belongs to exactly the same public clues.
      // Preserve its mine count while satisfying the new signed bound.
      const required=new Map(), groups=new Map();
      for(const [v,value] of force) {
        const group=swaps.get(v);
        if(group) groups.set(group,(groups.get(group)??0)+value-state[v]);
        required.set(v,value);
      }
      for(const [group,delta] of groups) if(delta) {
        const eligible=group.filter(v=>!required.has(v) && state[v]===Number(delta>0));
        if(eligible.length<Math.abs(delta)) return false;
        if(plant) for(const v of eligible.slice(0,Math.abs(delta))) state[v]=Number(delta<0);
      }
      if(plant) for(const [v,value] of force) state[v]=value;
      return true;
    }

    function propose(base,view,known,targets,limit,directed=false) {
      const fixed=base.slice();
      for(const v of targets) {
        if(fixed[v]===1) return null;
        fixed[v]=0;
      }
      const edge=[...new Set(targets.flatMap(v=>ns[v]))].filter(v=>fixed[v]<0);
      const options=[], seen=new Set();
      const swaps=new Map();
      if(hard && directed) {
        const exposed=new Set(targets.flatMap(v=>ns[v])), fresh=new Set(targets);
        const rows=constraints(config,view,known,ns).local;
        for(const group of equivalentGroups(rows.map(row=>({vs:row.vs.filter(v=>!fresh.has(v))})))) {
          if(!group.some(v=>exposed.has(v)) || !group.some(v=>fixed[v]===1) || !group.some(v=>fixed[v]===0)) continue;
          for(const v of group) swaps.set(v,group);
        }
      }
      const patterns=directed && (edge.length || swaps.size)?directedRings(fixed,view,known,targets,edge,swaps):[];
      const samples=edge.length || swaps.size?limit:1;
      const trials=samples+patterns.length;
      for(let i=0;i<trials;i++) {
        const state=fixed.slice(), next=view.slice();
        const force=patterns[i-samples]??[];
        if(force.length) canPlant(state,force,swaps,true);
        else if(i && swaps.size) {
          const groups=[...new Set(swaps.values())];
          const group=groups[r(groups.length)], a=group[r(group.length)], b=group.find(v=>state[v]!==state[a]);
          [state[a],state[b]]=[state[b],state[a]];
        }
        const scale=i===0 ? 1 : i===limit-1 ? 0 : .4+r(161)/100;
        if(!commitRing(state,edge.filter(v=>state[v]<0),scale)) continue;
        for(const v of targets) next[v]=number(state,v);
        const key=state.join(',');
        if(seen.has(key)) continue;
        seen.add(key);
        const done=amountOpen(next)===n-mines;
        const move=done?null:nextMove(next,known);
        if(!done && !move) continue;
        options.push({state,next,move});
      }
      return options;
    }

    function preview(option,known,depth) {
      const {next,state}=option;
      const {move}=option;
      if(!move) return 0;
      const count=move.sources.length;
      const score=(count-1)*(count-1);
      if(depth===1) return score;
      if(move.value) {
        known=new Set([...known,...move.vs]);
        const after=nextMove(next,known);
        return after ? score+.85*preview({next,state,move:after},known,depth-1) : score-4;
      }
      const candidates=propose(state,next,known,move.vs,3)??[];
      return candidates.length ? score+.85*Math.max(...candidates.map(c=>preview(c,known,depth-1))) : score-4;
    }

    function rateOption(option,known) {
      if(!option.move) return {score:0};
      const {next,state}=option;
      const judgment=option.move.sources.length>=3 ? classifyRows(next,constraints(config,next,known,ns),16000,true) : undefined;
      if(judgment && judgment.status!=='complete') return {score:-12};
      const proof=minimizeMove(config,next,known,option.move,ns,judgment,{minimumBudget:24000});
      const move=proof.positionMinimum && batchMove(config,next,known,proof,ns,24000);
      if(!move) return {score:-12};
      const added=new Set([...known,...move.mines]);
      const count=move.sources.length;
      const score=2*(count-1)+Number(count>=3)*hard.multi+Math.max(0,count-2)*hard.peak;
      const future=move.safe.length ? propose(state,next,added,move.safe,3) :
        [{move:nextMove(next,added)}].filter(c=>c.move);
      const follow=future?.length ? Math.max(...future.map(c=>c.move?.sources.length??2))-1 : -2;
      return {score:score+follow,verifiedMove:move};
    }

    // Backtrack only tentative continuation rings. The public opening and
    // its verified proof are shared by every continuation.
    let planned;
    for(let step=0;step<n*3;step++) {
      if(amountOpen(visible)===n-mines) {
        // Every remaining cell must be a mine by the public total.
        const bombs=Array.from(map,v=>v!==0);
        if(bombs.filter(Boolean).length!==mines) return null;
        return {w:p.w,h:p.h,ns,mines,seed:openingSeed.seed??seed,first:givens[0],opening:givens,bombs,
          clues:ns.map(row=>row.reduce((a,v)=>a+Number(bombs[v]),0))};
      }
      let move=planned??nextMove(visible,marks);
      if(move && !planned) {
        const first=!continuation && step===0;
        const proof=first?openingProof(config,visible,move,ns,openingSeed.judgment):minimizeMove(config,visible,marks,move,ns);
        move=proof.positionMinimum?batchMove(config,visible,marks,proof,ns):null;
      }
      planned=undefined;
      if(move) {
        for(const v of move.mines) marks.add(v);
        if(!move.safe.length) continue;
        const candidates=propose(map,visible,marks,move.safe,hard?10:7,true);
        const ranked=hard ? candidates.sort((a,b)=>(b.move?.sources.length??2)-(a.move?.sources.length??2))
          .slice(0,7).map(c=>({...c,...rateOption(c,marks)})) :
          candidates.map(c=>({...c,score:preview(c,marks,3)}));
        const [next,...alternatives]=ranked.sort((a,b)=>b.score-a.score);
        if(next) {
          if(alternatives.length && retries) forks.push({alternatives,marks:new Set(marks)});
          map=next.state;visible=next.next;planned=next.verifiedMove;
          continue;
        }
      }
      if(!forks.length || !retries) return null;
      retries--;
      const fork=forks.at(-1), next=fork.alternatives.shift();
      if(!fork.alternatives.length) forks.pop();
      map=next.state;visible=next.next;marks=new Set(fork.marks);planned=next.verifiedMove;
    }
    return null;
  }

  function refine(p,board,report,start,compare,fits,hard,duplicate) {
    const {ns,mines,seed}=board, r=random(seed^0x579a);
    let best={board,report};
    for(let trial=0;trial<5 && !fits(best.report);trial++) {
      const view=opening(best.board), marks=new Set(), checkpoints=[];
      let run=0;
      for(const move of best.report.trace) {
        run=move.sources.length>=3?0:run+1;
        if(run>=2 && move.commit?.safe.length) {
          const map=new Int8Array(ns.length).fill(-1);
          for(const v of marks) map[v]=1;
          for(let v=0;v<ns.length;v++) if(view[v]>=0) {
            map[v]=0;
            for(const u of ns[v]) map[u]=Number(best.board.bombs[u]);
          }
          const free=map.filter(v=>v<0).length;
          if(free>=4 && move.commit.safe.some(v=>ns[v].some(u=>map[u]<0))) {
            checkpoints.push({view:view.slice(),marks:[...marks],map,weight:run*Math.min(free,24)});
          }
        }
        for(const v of move.commit?.mines??[]) marks.add(v);
        for(const v of move.commit?.safe??[]) view[v]=best.board.clues[v];
      }
      if(!checkpoints.length) break;
      checkpoints.sort((a,b)=>b.weight-a.weight);
      const point=checkpoints[r(Math.min(5,checkpoints.length))];
      const candidate=construct(p,r(4294967296),ns,mines,{...start,seed},point,hard);
      if(!candidate || duplicate(candidate)) continue;
      const next=verify(candidate,p,{certify:true,trace:true});
      if(next.status==='passed' && compare(next,best.report)<0) best={board:candidate,report:next};
    }
    return best;
  }

  function standardDifficulty(w,h) {
    const minMultiPercent=Math.min(w,h)<5?0:w*h<=64?10:5;
    return {minAverage:1.2,minMultiPercent,minPeakClues:2};
  }

  // A signed stencil fixes only the cells that survive cancellation.
  // The second shape leaves one extra clue open to constrain later marks.
  const compactStencils=[
    {total:1, weights:[[3,-1],[4,1],[5,-1],[10,1],[14,-1],[16,-1],[20,-1],[22,1],[23,-1]], anchors:[[12,1],[13,0],[18,0]]},
    {total:2, weights:[[1,0],[3,-2],[5,-2],[10,2],[14,-1],[16,-2],[19,-1],[20,-2],[22,2],[23,-2]], anchors:[[12,1],[18,0]]},
  ];

  function* compactCancellation(ns,seed,mines,round,shape) {
    const r=random(seed);
    const rotation=r(4), mirror=r(2);
    const transform=v=>{
      let x=v%5,y=Math.floor(v/5);
      if(mirror) x=4-x;
      for(let i=0;i<rotation;i++) [x,y]=[4-y,x];
      return x+5*y;
    };
    // On a 5x5 board the total can cancel overlapping clues that do not
    // fit the disjoint two-cell joints of the even-ring construction.
    const pattern=compactStencils[shape], stencil=pattern.weights.slice();
    if(round%3===0) {
      const i=r(stencil.length), [v,k]=stencil[i];
      const neighbors=ns[v].filter(u=>!stencil.some(([s])=>s===u));
      if(neighbors.length) stencil[i]=[neighbors[r(neighbors.length)],k];
    }
    const givens=stencil.map(([v])=>transform(v)), revealed=new Set(givens);
    const unknown=range(ns.length).filter(v=>!revealed.has(v));
    const coefficients=new Int8Array(ns.length).fill(pattern.total);
    for(const [i,v] of givens.entries()) for(const u of ns[v]) coefficients[u]+=stencil[i][1];
    const cancelled=unknown.filter(v=>!coefficients[v]);
    const forced=unknown.filter(v=>coefficients[v]);
    if(!forced.length || cancelled.length<5) return;
    const anchors=new Map(pattern.anchors.map(([v,value])=>[transform(v),value])), seen=new Set();
    for(let trial=0;trial<96;trial++) {
      const bombs=Array(ns.length).fill(false), flip=r(2);
      for(const v of forced) bombs[v]=Boolean(Number(coefficients[v]<0)^flip);
      // The overlapping three-clue region gives the batch a first move;
      // the total and surrounding clues are needed for other cells.
      for(const v of cancelled) {
        bombs[v]=Boolean((round%3===0 ? r(2) : anchors.get(v)??r(2))^flip);
      }
      const count=bombs.filter(Boolean).length;
      if(mines!=null && count!==mines || count<2 || count>=unknown.length-1) continue;
      const key=bombs.map(Number).join('');
      if(seen.has(key)) continue;
      seen.add(key);
      const clues=ns.map(row=>row.reduce((sum,v)=>sum+Number(bombs[v]),0));
      const visible=clues.map((clue,v)=>revealed.has(v)?clue:-1);
      const {rows}=constraints({mines:count},visible,new Set(),ns);
      if(rows.length<10 || elementary(rows,()=>true)) continue;
      yield {w:5,h:5,ns,mines:count,seed,first:givens[0],opening:givens,bombs,clues};
    }
  }

  function difficultyDefaults() {
    return {minAverage:2,minMultiPercent:30,minPeakClues:5};
  }

  function* generate(p,seed) {
    const defaults=difficultyDefaults();
    const target={average:p.minAverage??defaults.minAverage,multiPercent:p.minMultiPercent??defaults.minMultiPercent,
      peak:p.minPeakClues??defaults.minPeakClues};
    const area=p.w*p.h, tiny=area===2 || p.w===2 && p.h===2;
    const required=Math.max(target.peak,Math.ceil(target.average),target.multiPercent>0?3:1);
    // Besides opened digits, only the total mine count can add a clue.
    if(area===1 || required>area || tiny && (required>1 || p.mines>0))
      throw Error('该尺寸和难度下限无法构造需要推理的棋局。请调低难度或增大棋盘。');
    const ns=adj(p.w,p.h), r=random(seed), seen=new Set();
    if(tiny) {
      const board=candidate({...p,mines:0},seed,ns);
      board.opening=[board.first];
      const report=verify(board,{...p,mines:0},{certify:true});
      if(report.status!=='passed' || !report.steps) throw Error('未能验证最小棋盘的推理路线。');
      yield {board,report,target,tried:1,passed:1,constructed:1,route:'compact'};
      return;
    }
    const near=ns.map((row,i)=>[...new Set(row.flatMap(v=>ns[v]))].filter(v=>v!==i));
    const plan=openingPlans[(seed>>>0)%openingPlans.length];
    const compact=ns.length<=64 || Math.min(p.w,p.h)<5;
    const multi=target.multiPercent/100;
    const fits=report=>report.averageClues>=target.average && report.advancedDensity>=multi && report.clues>=target.peak;
    const standard=standardDifficulty(p.w,p.h);
    const hard=target.average>standard.minAverage || target.multiPercent>standard.minMultiPercent || target.peak>standard.minPeakClues ?
      {multi:4*multi,peak:target.peak>standard.minPeakClues?.75:0} : null;
    const deficit=r=>Math.max(0,1-r.averageClues/Math.max(1,target.average))+
      (multi>0?Math.max(0,1-r.advancedDensity/multi):0)+
      Math.max(0,1-r.clues/Math.max(1,target.peak));
    const compare=(a,b)=>Number(fits(b))-Number(fits(a)) || deficit(a)-deficit(b) || compareOpening(a,b);
    const min=Math.max(1,Math.ceil(ns.length*.16)), max=Math.max(min,Math.floor(ns.length*.28));
    let passed=0, constructed=0, closest;
    function duplicate(board) {
      const key=board.opening.slice().sort((a,b)=>a-b)+':'+board.bombs.map(Number).join('');
      if(seen.has(key)) return true;
      if(seen.size>=4096) seen.delete(seen.values().next().value);
      seen.add(key);
      return false;
    }
    function record(report) {
      if(!closest || compare(report,closest)<0) closest={...report,trace:[]};
    }
    for(let k=1;;k++) {
      const id=r(4294967296), natural=min+r(max-min+1);
      if(p.w===5 && p.h===5 && target.peak>=10 && target.peak<=11 && k%4!==0) {
        const shape=((seed>>>0)+k-1)%compactStencils.length;
        for(const board of compactCancellation(ns,id,p.mines,k,shape)) {
          constructed++;
          if(duplicate(board)) continue;
          const report=verify(board,p,{certify:true});
          if(report.status!=='passed' || !report.steps) continue;
          passed++;
          if(fits(report)) {
            yield {board,report,target,tried:k,passed,constructed,route:'compact-cancellation'};
            return;
          }
          record(report);
        }
      }
      const dense=random(id^0xd3ab);
      const denseRound=hard && k%4!==0 && k%3!==0;
      const cycleRound=denseRound && target.peak>=6 && Math.min(p.w,p.h)>=5;
      const density=cycleRound ? .34+dense(41)/100 : .23+dense(26)/100;
      const mines=p.mines??(denseRound?Math.round(ns.length*density):natural);
      // Give interior geometry most of the budget without forbidding edge patterns.
      const interior=!compact && k%4!==0;
      const route=compact || k>96 && k%8===0 ? openingPlans[((seed>>>0)+k-1)%openingPlans.length]:plan;
      const directed=hard && k%4!==0 ? hard : null;
      let starts=[];
      if(cycleRound) {
        const length=2*Math.ceil(target.peak/2);
        if(k%4===1) starts=seedCycle(p,ns,near,id,mines,length,false);
        if(!starts.length) starts=seedCycle(p,ns,near,id,mines,length+2*(k%5),k%4===1);
      }
      if(!starts.length && (compact || directed && k%2===0)) starts=compactOverlap(p,ns,near,id,mines,!!directed);
      if(!starts.length && (!compact || k%3===0 || directed)) starts=seedOpening(p,ns,near,id,mines,route,interior,compact);
      if(compact && !starts.length) starts=seedCompact(p,ns,id,mines);
      for(const start of starts) {
        const board=construct(p,id,ns,mines,start,undefined,directed);
        if(!board) continue;
        constructed++;
        if(duplicate(board) || start.givens.some(v=>start.view[v]!==board.clues[v])) continue;
        const report=verify(board,p,{certify:true,trace:true});
        if(report.status==='passed' && report.steps) {
          passed++;
          const candidate=fits(report)?{board,report}:refine(p,board,report,start,compare,fits,directed,duplicate);
          if(fits(candidate.report)) {
            yield {board:candidate.board,report:{...candidate.report,trace:[]},target,tried:k,passed,constructed,route:compact?'compact':route.kind};
            return;
          }
          record(candidate.report);
        }
      }
      const summary=closest && {average:closest.averageClues,multiPercent:closest.advancedDensity*100,peak:closest.clues};
      yield {target,tried:k,passed,constructed,closest:summary};
    }
  }

  return {version,adj,candidate,opening,reveal,numberAction,analyze,equivalentGroups,minimumProof,classify,confirmationTargets,gate,advance,verify,hint,inspect,expand,publicBoard,difficultyDefaults,generate};
}

if(typeof module!=='undefined') module.exports=makeMinesEngine();
