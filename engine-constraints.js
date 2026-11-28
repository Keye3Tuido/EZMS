function makeMinesConstraints(board) {
  'use strict';
  const {adj}=board;

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

  function classify(p,visible,{nodeBudget=35000,proven=new Set()}={}) {
    return classifyRows(visible,constraints(p,visible,proven,adj(p.w,p.h)),nodeBudget,true);
  }

  function transfer(p,visible,{nodeBudget=120000,proven=new Set(),knownSafe}={}) {
    return transferRows(visible,constraints(p,visible,proven,adj(p.w,p.h),knownSafe),nodeBudget);
  }

  function transferRows(visible,{rows,local,unknown,invalid},budget) {
    const state=visible.map(v=>v>=0?'open':'unknown');
    let nodes=0, reverseEdges=0;
    const result=status=>({status,state,nodes,depth:0,maxDepth:0});
    if(invalid) return result('invalid');
    if(budget<=0) return result('budget');
    const total=rows.find(row=>row.source===-1)?.rhs;
    const membership=new Map(unknown.map(v=>[v,[]]));
    for(const [i,row] of local.entries()) for(const v of row.vs) membership.get(v).push(i);
    const grouped=new Map(), byRow=local.map(()=>[]);
    for(const [v,ids] of membership) {
      const key=ids.join(',');
      if(!grouped.has(key)) {
        const group={cells:[],rows:ids};
        grouped.set(key,group);
        for(const id of ids) byRow[id].push(group);
      }
      grouped.get(key).cells.push(v);
    }
    const outside=grouped.get('')?.cells??[];
    grouped.delete('');
    const pending=new Set(grouped.values()), components=[];
    for(const start of pending) {
      pending.delete(start);
      const groups=[start], ids=new Set();
      for(const group of groups) for(const id of group.rows) {
        if(ids.has(id)) continue;
        ids.add(id);
        for(const next of byRow[id]) if(pending.delete(next)) groups.push(next);
      }
      components.push(groups);
    }
    const allCounts=size=>(2n<<BigInt(size))-1n;
    const countMask=total===undefined ? -1n : allCounts(total);
    const counts=bits=>{
      const values=[];
      for(let n=0;bits;bits>>=1n,n++) if(bits&1n) values.push(n);
      return values;
    };
    function combine(a,b) {
      let joined=0n;
      if(!a || !b) return joined;
      if(a>b) [a,b]=[b,a];
      for(const n of counts(a)) {
        if(nodes+reverseEdges>=budget) return null;
        nodes++;
        joined|=b<<BigInt(n);
      }
      return joined&countMask;
    }
    const tables=[];
    for(const groups of components) {
      // 优先选使待完成线索最少的分组。宽分区可直接使用棋盘顺序，避免二次扫描。
      const capacity=new Map();
      for(const group of groups) for(const id of group.rows) {
        capacity.set(id,(capacity.get(id)??0)+group.cells.length);
      }
      const waiting=new Set(groups), layers=[];
      let active=[], states=new Map([['',{counts:1n,values:[],edges:[]}]]);
      while(waiting.size) {
        const slots=new Map(active.map((id,i)=>[id,i]));
        let choice=waiting.values().next().value;
        if(groups.length<=128) {
          let best=Infinity;
          for(const group of waiting) {
            const delta=group.rows.reduce((sum,id)=>sum+(capacity.get(id)===group.cells.length ?
              -Number(slots.has(id)) : Number(!slots.has(id))),0);
            if(delta<best) {choice=group;best=delta;}
          }
        }
        waiting.delete(choice);
        const {cells,rows:ids}=choice, size=cells.length;
        const affected=new Set(ids);
        for(const id of ids) capacity.set(id,capacity.get(id)-size);
        const boundary=active.concat(ids.filter(id=>!slots.has(id)));
        const nextActive=boundary.filter(id=>capacity.get(id)>0);
        const next=new Map();
        for(const from of states.values()) {
          const need=id=>slots.has(id)?from.values[slots.get(id)]:local[id].rhs;
          let min=0,max=size;
          for(const id of ids) {
            min=Math.max(min,need(id)-capacity.get(id));
            max=Math.min(max,need(id));
          }
          for(let k=min;k<=max;k++) {
            if(nodes+reverseEdges>=budget) return result('budget');
            nodes++;
            const support=(from.counts<<BigInt(k))&countMask;
            if(!support) continue;
            // 每条前向保留的边都会在反向扫描时再访问一次，提前留出这一节点。
            if(nodes+reverseEdges>=budget) return result('budget');
            reverseEdges++;
            const values=nextActive.map(id=>need(id)-(affected.has(id)?k:0));
            const key=values.join(',');
            if(!next.has(key)) next.set(key,{counts:0n,values,edges:[]});
            const to=next.get(key);
            to.counts|=support;
            from.edges.push({to,k});
          }
        }
        if(!next.size) return result('invalid');
        layers.push({states,cells});
        states=next;
        active=nextActive;
      }
      tables.push({layers,end:states.get('')});
    }
    const prefix=[1n], suffix=Array(tables.length+1);
    suffix[tables.length]=allCounts(outside.length)&countMask;
    if(total!==undefined) {
      for(const table of tables) {
        const support=combine(prefix.at(-1),table.end.counts);
        if(support===null) return result('budget');
        prefix.push(support);
      }
      for(let i=tables.length-1;i>=0;i--) {
        const support=combine(suffix[i+1],tables[i].end.counts);
        if(support===null) return result('budget');
        suffix[i]=support;
      }
      if(!(suffix[0]&(1n<<BigInt(total)))) return result('invalid');
    }
    // 后向只保留能抵达整盘合法总雷数的路径，逐组汇总可行取值。
    const projections=[];
    for(const [i,{layers,end}] of tables.entries()) {
      end.valid=end.counts;
      if(total!==undefined) {
        const rest=combine(prefix[i],suffix[i+1]);
        if(rest===null) return result('budget');
        end.valid=0n;
        for(const localCount of counts(end.counts)) if(rest&(1n<<BigInt(total-localCount))) {
          end.valid|=1n<<BigInt(localCount);
        }
      }
      for(let j=layers.length-1;j>=0;j--) {
        const {states,cells}=layers[j];
        let safe=false,mine=false;
        for(const from of states.values()) {
          from.valid=0n;
          for(const {to,k} of from.edges) {
            reverseEdges--;
            nodes++;
            const through=from.counts&(to.valid>>BigInt(k));
            if(!through) continue;
            from.valid|=through;
            safe||=k<cells.length;
            mine||=k>0;
          }
        }
        projections.push({cells,safe,mine});
      }
    }
    let safe=total===undefined,mine=safe;
    if(total!==undefined) for(const count of counts(prefix.at(-1))) {
      const rest=total-count;
      if(rest>=0 && rest<=outside.length) {
        safe||=rest<outside.length;
        mine||=rest>0;
      }
    }
    projections.push({cells:outside,safe,mine});
    for(const {cells,safe,mine} of projections) for(const v of cells) {
      state[v]=safe && mine?'either':safe?'safe':'mine';
    }
    return result('complete');
  }

  function classifyRows(visible,context,nodeBudget,grouped=false,witnessOnly=false) {
    if(!grouped || nodeBudget<=0) return searchRows(visible,context,nodeBudget,grouped,witnessOnly);
    const result=transferRows(visible,context,Math.min(nodeBudget,120000));
    if(result.status!=='budget') return result;
    const fallback=searchRows(visible,context,nodeBudget-result.nodes,grouped,witnessOnly);
    return {...fallback,nodes:fallback.nodes+result.nodes};
  }

  function searchRows(visible,{rows,local,unknown,frontier,invalid},nodeBudget,grouped,witnessOnly) {
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

  function selectionTotals(p,visible,known,weights,budget=Infinity) {
    const marks=new Set(), safe=new Set();
    for(const [v,mine] of known) if(visible[v]<0) (mine?marks:safe).add(v);
    const ns=adj(p.w,p.h);
    let fixedWeight=0, context=constraints(p,visible,marks,ns,safe);
    // 精确搜索前先传播约束，排除雷或安全状态已经确定的格子。
    for(;;) {
      if(context.invalid) return {status:'invalid'};
      let changed=false, contradiction=false;
      function force(cells,mine) {
        const affected=mine?marks:safe, opposite=mine?safe:marks;
        for(const v of cells) {
          if(opposite.has(v)) {contradiction=true;continue;}
          if(affected.has(v)) continue;
          affected.add(v);
          if(mine) fixedWeight+=weights.get(v)??0;
          changed=true;
        }
      }
      for(const {vs,rhs} of context.rows) if(!rhs || rhs===vs.length) force(vs,Boolean(rhs));
      if(!changed && !contradiction) {
        const incident=new Map();
        for(const a of context.local) {
          const overlaps=new Set();
          for(const v of a.vs) {
            if(!incident.has(v)) incident.set(v,[]);
            const prior=incident.get(v);
            for(const b of prior) overlaps.add(b);
            prior.push(a);
          }
          for(const b of overlaps) {
            const [A,B,I]=split(a.vs,b.vs);
            const low=Math.max(0,a.rhs-A.length,b.rhs-B.length), high=Math.min(I.length,a.rhs,b.rhs);
            if(low>high) return {status:'invalid'};
            for(const [cells,min,max] of [[I,low,high],[A,a.rhs-high,a.rhs-low],[B,b.rhs-high,b.rhs-low]]) {
              if(cells.length && (!max || min===cells.length)) force(cells,Boolean(max));
            }
          }
        }
      }
      if(contradiction) return {status:'invalid'};
      if(!changed) break;
      context=constraints(p,visible,marks,ns,safe);
    }
    const {local,unknown}=context;
    if(budget<=0) return {status:'budget'};
    const remaining=p.mines-marks.size;
    const incident=new Map(unknown.map(v=>[v,[]]));
    for(const [i,row] of local.entries()) for(const v of row.vs) incident.get(v).push(i);

    // 只使用公开约束，符合约束但需要猜的布雷也参与统计。
    // 受相同线索约束且系数相同的格子可以合并，只记录组内雷数。
    const groups=new Map();
    for(const [v,rows] of incident) {
      const weight=weights.get(v)??0, key=`${weight}:${rows}`;
      if(!groups.has(key)) groups.set(key,{rows,weight,size:0,first:v});
      groups.get(key).size++;
    }
    const byRow=local.map(()=>[]);
    for(const group of groups.values()) for(const row of group.rows) byRow[row].push(group);
    const unvisited=new Set(groups.values());
    const components=[];
    const scan=v=>p.w<=p.h?v:(v%p.w)*p.h+Math.floor(v/p.w);
    while(unvisited.size) {
      const first=unvisited.values().next().value;
      unvisited.delete(first);
      const component=[first], seenRows=new Set();
      for(const group of component) for(const row of group.rows) {
        if(seenRows.has(row)) continue;
        seenRows.add(row);
        for(const other of byRow[row]) if(unvisited.delete(other)) component.push(other);
      }
      components.push(component.sort((a,b)=>scan(a.first)-scan(b.first)));
    }
    const add=(table,mines,weighted)=>{
      if(!table.has(mines)) table.set(mines,new Set());
      table.get(mines).add(weighted);
    };
    // 将最大的无线索约束组留到最后，由全局总雷数确定其组内雷数。
    components.sort((a,b)=>Number(!a[0].rows.length)-Number(!b[0].rows.length)||
      (!a[0].rows.length && !b[0].rows.length ? a[0].size-b[0].size : 0));
    let combined=new Map([[0,new Set([fixedWeight])]]), countedCells=0;
    for(const component of components) {
      const totals=new Map();
      const size=component.reduce((sum,group)=>sum+group.size,0);
      const minMines=Math.max(0,remaining-(unknown.length-size));
      const gcd=(a,b)=>{while(b) [a,b]=[b,a%b];return a;};
      const unit=component.reduce((scale,group)=>gcd(scale,Math.abs(group.weight)),0)||1;
      const offset=component.reduce((sum,group)=>sum+Math.min(0,group.weight*group.size),0);
      const span=component.reduce((sum,group)=>sum+Math.abs(group.weight/unit)*group.size,0);
      const bitset=span<=8192;
      const lastUse=new Map(), capacity=new Map();
      for(const [index,group] of component.entries()) for(const row of group.rows) {
        lastUse.set(row,index);
        capacity.set(row,(capacity.get(row)??0)+group.size);
      }
      // 只保留仍关联未处理分组的线索余量。
      // 用位集合记录当前边界和雷数下所有可能的加权雷数。
      let states=new Map([['0:',{mines:0,residual:'',scores:bitset?1n:new Set([0])}]]);
      let active=[];
      let consumed=0;
      for(const [index,{rows,weight,size:copies}] of component.entries()) {
        consumed+=copies;
        const activeSlots=new Map(active.map((row,i)=>[row,i]));
        const linked=new Set(rows);
        const nextRows=[...new Set([...active,...rows])].filter(row=>lastUse.get(row)>index);
        const read=({slot,rhs},residual)=>slot===undefined?rhs:residual.charCodeAt(slot)-48;
        const bounds=rows.map(row=>{
          const free=capacity.get(row)-copies;
          capacity.set(row,free);
          return {slot:activeSlots.get(row),rhs:local[row].rhs,free};
        });
        const outgoing=nextRows.map(row=>({slot:activeSlots.get(row),rhs:local[row].rhs,used:linked.has(row)}));
        const minimum=Math.min(0,copies*weight);
        const next=new Map();
        for(const {mines,residual,scores} of states.values()) {
          let low=Math.max(0,minMines-mines-(size-consumed)), high=Math.min(copies,remaining-mines);
          for(const bound of bounds) {
            const rhs=read(bound,residual);
            low=Math.max(low,rhs-bound.free);
            high=Math.min(high,rhs);
          }
          for(let count=low;count<=high;count++) {
            if(--budget<0) return {status:'budget'};
            let boundary='';
            for(const row of outgoing) boundary+=String.fromCharCode(48+read(row,residual)-(row.used?count:0));
            const countNow=mines+count, key=`${countNow}:${boundary}`;
            let entry=next.get(key);
            if(!entry) {
              entry={mines:countNow,residual:boundary,scores:bitset?0n:new Set()};
              next.set(key,entry);
            }
            const shift=(count*weight-minimum)/unit;
            if(bitset) entry.scores|=scores<<BigInt(shift);
            else for(const value of scores) {
              if(--budget<0) return {status:'budget'};
              entry.scores.add(value+shift);
            }
          }
        }
        if(!next.size) return {status:'invalid'};
        active=nextRows;
        states=next;
      }
      for(const {mines,scores} of states.values()) {
        if(bitset) {
          const bits=scores.toString(2);
          for(let i=0;i<bits.length;i++) if(bits[bits.length-1-i]==='1') add(totals,mines,offset+i*unit);
        } else for(const value of scores) add(totals,mines,offset+value*unit);
      }
      countedCells+=size;
      const next=new Map(), minCombined=remaining-(unknown.length-countedCells);
      function* compatible(used) {
        const low=Math.max(0,minCombined-used), high=remaining-used;
        if(high-low+1<totals.size) {
          for(let mines=low;mines<=high;mines++) if(totals.has(mines)) yield [mines,totals.get(mines)];
        } else {
          for(const entry of totals) if(entry[0]>=low && entry[0]<=high) yield entry;
        }
      }
      for(const [used,previous] of combined) for(const [mines,weighted] of compatible(used)) {
        if(--budget<0) return {status:'budget'};
        const count=used+mines;
        for(const a of previous) for(const b of weighted) {
          if(--budget<0) return {status:'budget'};
          add(next,count,a+b);
        }
      }
      if(!next.size) return {status:'invalid'};
      combined=next;
    }
    const values=combined.get(remaining);
    return values?{status:'complete',values:[...values].sort((a,b)=>a-b)}:{status:'invalid'};
  }

  function gate(classification,cells) {
    if(classification.status==='invalid') return {status:'invalid'};
    const blocked=cells.find(v=>['mine','either'].includes(classification.state[v]));
    if(blocked!==undefined) return {status:'blocked',cell:blocked};
    return {status:cells.every(v=>classification.state[v]==='safe')?'safe':'unknown'};
  }

  return {split,equivalentGroups,constraints,classify,transfer,transferRows,classifyRows,selectionTotals,gate};
}

if(typeof module!=='undefined') module.exports=makeMinesConstraints;
