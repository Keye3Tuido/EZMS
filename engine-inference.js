function makeMinesInference(board,model) {
  'use strict';
  const {range,adj,random,reveal,opening}=board;
  const {split,equivalentGroups,constraints,classify,transfer,transferRows,classifyRows}=model;

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

  function overlapProof(local,step,allowBranches=false) {
    if(local.length<(allowBranches?3:6)) return null;
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
        // The ring pass requires the full overlap graph to be a cycle. For
        // branched graphs, only two-region overlaps force opposite signs;
        // higher-order overlaps are accounted for in the final coefficients.
        const shared=new Set(row.vs.flatMap(v=>{
          const memberships=incident.get(v);
          return !allowBranches || memberships.length===2 ? memberships : [];
        }));
        shared.delete(row);
        links.set(row,shared);
        for(const other of shared) if(!seen.has(other)) {
          seen.add(other);
          component.push(other);
        }
      }
      const ring=component.length>=6 && component.length%2===0 && component.every(row=>links.get(row).size===2);
      if(!ring && (!allowBranches || component.length<3)) continue;
      const ordered=[first], signs=new Map([[first,1]]);
      if(ring) {
        while(ordered.length<component.length) {
          const next=[...links.get(ordered.at(-1))].find(row=>row!==first && row!==ordered.at(-2));
          signs.set(next,ordered.length%2?-1:1);
          ordered.push(next);
        }
      } else {
        let valid=true;
        for(const row of ordered) for(const other of links.get(row)) {
          const sign=-signs.get(row);
          if(!signs.has(other)) {signs.set(other,sign);ordered.push(other);}
          else if(signs.get(other)!==sign) valid=false;
        }
        if(!valid) continue;
      }
      for(const direction of [1,-1]) {
        let sum;
        for(const row of ordered) {
          const k=direction*signs.get(row);
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
        // The opposite direction can also attain its minimum only for an empty sum.
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
    const move=elementary(rows,step) || overlapProof(local,step) || weightedProof(local,step) ||
      overlapProof(local,step,true) || resolution(local,step,{budget:9000}) || (options.useTotal && totalProof(rows,step));
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
    const local=rows.filter(row=>row.source!==-1);
    return elementary(rows,step) || overlapProof(local,step) || weightedProof(rows,step) ||
      totalProof(rows,step,target) || overlapProof(local,step,true) || resolution(rows,step,{target,budget:120000});
  }

  // 线索缺失时，沿两块共用的交集交替传递 ±1，直到缺口。若每个交集都能向两侧
  // 调整，所有私有格都需要完整线索图。全盘总雷数最多需在图外调整一格。
  function transferMinimum({rows,local,unknown,frontier},move) {
    const {sources,inequality}=move;
    if(sources.length<3 || sources.length!==local.length || move.kind!=='linear' ||
      move.slack!==0 || !inequality?.terms?.length) return false;
    const bySource=new Set(local.map(row=>row.source));
    if(sources.some(source=>!bySource.has(source)) || new Set(sources).size!==local.length) return false;
    const terms=new Map(inequality.terms), memberships=new Map();
    for(const [i,row] of local.entries()) for(const v of row.vs) {
      if(!memberships.has(v)) memberships.set(v,[]);
      memberships.get(v).push(i);
    }
    const inset=local.map(({rhs,source})=>({rhs,source,vs:[]})), joints=new Map();
    let fixed=0;
    for(const [v,ids] of memberships) {
      if(ids.length===1) {
        if(Math.abs(terms.get(v))!==1) return false;
        const mine=Number(terms.get(v)<0);
        fixed+=mine;
        inset[ids[0]].rhs-=mine;
      } else {
        if(ids.length!==2 || terms.has(v)) return false;
        const key=ids.join(',');
        if(!joints.has(key)) joints.set(key,{ids,size:0});
        joints.get(key).size++;
      }
    }
    let length=0;
    const links=local.map(()=>[]);
    for(const {ids:[a,b],size} of joints.values()) {
      if(size<2) return false;
      links[a].push(b);links[b].push(a);
      inset[a].rhs--;inset[b].rhs--;fixed++;
      for(let k=2;k<size;k++) {
        inset[a].vs.push(length);inset[b].vs.push(length);length++;
      }
    }
    const queue=[0], seen=new Set(queue);
    for(const i of queue) for(const j of links[i]) if(!seen.has(j)) {seen.add(j);queue.push(j);}
    if(seen.size!==local.length || inset.some(row=>row.rhs<0 || row.rhs>row.vs.length)) return false;
    const global=rows.find(row=>row.source===-1), free=unknown.length-frontier.size;
    if(global && free<2) return false;
    const active=inset.filter(row=>row.vs.length), abstractRows=active.slice();
    if(global) length+=free-2;
    const ids=range(length);
    if(global) {
      const rhs=global.rhs-fixed-1;
      if(rhs<0 || rhs>length) return false;
      abstractRows.push({source:-1,rhs,vs:ids});
    }
    return transferRows(ids.map(()=>-1),{rows:abstractRows,local:active,unknown:ids},16000).status==='complete';
  }

  function minimizeMove(p,visible,marks,move,ns,judgment,{minimumBudget=120000,skip,knownSafe}={}) {
    // The elementary pass checks every one- and two-row deduction first.
    if(move.level<=1) return {...move,minimum:true,positionMinimum:true};
    const context=constraints(p,visible,marks,ns,knownSafe);
    if(transferMinimum(context,move)) return {...move,minimum:true,positionMinimum:true};
    let best=minimumProof(p,visible,marks,move,{ns,budget:minimumBudget,target:move.vs.find(v=>!skip?.has(v)),knownSafe});
    if(best.minimum && best.sources.length<=2) return {...best,positionMinimum:true};
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
    // At its minimum, a linear sum fixes all its terms. The proof panel
    // shows the safe and mined cells together on that equation.
    function coverSaturatedSum(proof) {
      if(proof.kind!=='linear' || proof.slack!==0) return;
      for(const [v,c] of proof.inequality.terms) {
        if(judged.state[v]===(c<0?'mine':'safe')) covered.add(v);
      }
    }
    coverSaturatedSum(move);
    for(const group of groups) {
      const v=group[0], state=judged.state[v];
      if(state!=='safe' && state!=='mine' || group.every(i=>covered.has(i))) continue;
      const value=Number(state==='mine'), target=group.find(i=>!covered.has(i));
      const proof=targetProof(rows,target,value);
      if(!proof) return null;
      const symmetric=[...new Set(proof.vs.flatMap(i=>equivalent.get(i)??[i]))].sort((a,b)=>a-b);
      for(const i of symmetric) covered.add(i);
      coverSaturatedSum(proof);
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
  function compareDifficulty(a,b) {
    const spread=r=>r.sections.filter(s=>s.advanced>0).length;
    return b.averageClues-a.averageClues || b.advancedDensity-a.advancedDensity || spread(b)-spread(a) || b.clues-a.clues ||
      b.multiSteps-a.multiSteps || a.longestShallowRun-b.longestShallowRun;
  }

  // The caller has proved all targets safe, either by techniques or by gate().
  function advance(board,p,visible,cells,marks,{allowUnsolved=false,exact=false,flags=marks}={}) {
    const show=witness=>{
      const next=visible.slice();
      let opened=0;
      for(const v of cells) opened+=reveal(witness,next,v,flags);
      const openedCells=next.flatMap((value,index)=>visible[index]<0&&value>=0?[index]:[]);
      return {board:witness,visible:next,opened:openedCells.length,cells:openedCells};
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

  function summarizeSupports(supports) {
    const multiSteps=supports.filter(count=>count>=3).length;
    let shallowRun=0, longestShallowRun=0;
    for(const count of supports) {
      shallowRun=count>=3?0:shallowRun+1;
      longestShallowRun=Math.max(longestShallowRun,shallowRun);
    }
    return {multiSteps,longestShallowRun,averageClues:supports.reduce((sum,count)=>sum+count,0)/supports.length,
      advancedDensity:multiSteps/supports.length,sections:range(3).map(i=>{
        const steps=supports.slice(Math.ceil(i*supports.length/3),Math.ceil((i+1)*supports.length/3));
        return {steps:steps.length,advanced:steps.filter(count=>count>=3).length};
      })};
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
      for(const v of commit.safe) {
        flags.delete(v);
        opened+=reveal(board,visible,v,flags);
      }
      round=undefined;
      return commit;
    };
    while(opened<visible.length-p.mines) {
      if(options.certify && !round) {
        const publicState=classifyRows(visible,constraints(p,visible,new Set(),ns),120000,true);
        if(publicState.status!=='complete') return {...report,status:publicState.status,opened};
        options.observeRound?.(visible,flags,publicState.state);
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
    if(supports.length) Object.assign(report,summarizeSupports(supports));
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
    const choices=visible.flatMap((x,i)=>x<0&&!board.bombs[i]&&!flags.has(i)?[i]:[]);
    const safeLeft=visible.filter(v=>v<0).length-board.mines;
    let best=null, bestCost=Infinity, unresolvedCost=Infinity;
    // Each chosen cell opens, so the subset size is a lower bound on disclosures.
    for(let size=1;size<=choices.length && size<bestCost && size<=unresolvedCost;size++) {
      const stop=eachSubset(choices,size,cells=>{
        if(budget--<=0) return {status:'budget'};
        const view=visible.slice();
        for(const v of cells) reveal(board,view,v,flags);
        const opened=view.flatMap((value,index)=>visible[index]<0&&value>=0?[index]:[]);
        const cost=opened.length;
        if(cost>=bestCost || cost>unresolvedCost) return null;
        const next=cost===safeLeft || check(view);
        if(next===null) unresolvedCost=Math.min(unresolvedCost,cost);
        if(next) {
          best={status:'expanded',cells:opened,visible:view};
          bestCost=cost;
          if(cost===size) return best;
        }
        return null;
      });
      if(stop) return stop;
    }
    if(unresolvedCost<bestCost) return {status:'budget'};
    return best??{status:'not-blocked'};
  }

  function* enumerateNoGuess({w,h,mines},{accept=()=>true}={}) {
    const ns=adj(w,h), size=ns.length, cells=range(size);
    if(mines!==undefined && (!Number.isInteger(mines) || mines<0 || mines>=size)) return;
    function* combinations(count) {
      const indices=range(count);
      for(;;) {
        yield indices;
        let i=count-1;
        while(i>=0 && indices[i]===size-count+i) i--;
        if(i<0) return;
        indices[i]++;
        for(let j=i+1;j<count;j++) indices[j]=indices[j-1]+1;
      }
    }
    const bits=cells.map(v=>1n<<BigInt(v));
    for(let count=mines??0;count<=(mines??size-1);count++) for(const layout of combinations(count)) {
      const bombs=Array(size).fill(false);
      for(const v of layout) bombs[v]=true;
      const clues=ns.map(row=>row.reduce((sum,v)=>sum+Number(bombs[v]),0));
      const safe=cells.filter(v=>!bombs[v]);
      const full=safe.reduce((mask,v)=>mask|bits[v],0n);
      const pending=[full], reached=new Set(pending), proofs=new Map();
      while(pending.length) {
        const open=pending.pop(), givens=safe.filter(v=>open&bits[v]);
        // 实际开局的零格会自动展开。中间状态可逐格逆推，交付的开局必须已经展开。
        if(givens.every(v=>clues[v]!==0 || ns[v].every(u=>open&bits[u]))) {
          const board={w,h,ns:ns.map(row=>row.slice()),mines:count,bombs:bombs.slice(),clues:clues.slice(),
            opening:givens.slice(),first:givens[0]};
          if(accept(board)) yield board;
        }
        for(const v of givens) {
          const previous=open^bits[v];
          if(!previous || reached.has(previous)) continue;
          if(!proofs.has(previous)) {
            const visible=cells.map(u=>previous&bits[u]?clues[u]:-1);
            const {state}=transfer({w,h,mines:count},visible,{nodeBudget:Infinity});
            const proven=state.reduce((mask,status,u)=>status==='safe'?mask|bits[u]:mask,0n);
            proofs.set(previous,proven);
          }
          if(proofs.get(previous)&bits[v]) {
            proofs.delete(previous);
            reached.add(previous);
            pending.push(previous);
          }
        }
      }
    }
  }

  return {analyze,minimumProof,enumerateNoGuess,confirmationTargets,advance,verify,hint,inspect,expand,publicBoard,
    elementary,overlapProof,minimizeMove,openingProof,batchMove,summarizeSupports,compareDifficulty};
}

if(typeof module!=='undefined') module.exports=makeMinesInference;
