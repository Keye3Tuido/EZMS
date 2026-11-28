function makeProofFormat() {
  function column(n) {
    let label='';
    for(n++;n>0;n=Math.floor((n-1)/26)) label=String.fromCharCode(65+(n-1)%26)+label;
    return label;
  }
  const coordinate = (v,w) => `${column(v%w)}${Math.floor(v/w)+1}`;

  function rectangleLabel([left,top,right,bottom],w) {
    const first=coordinate(top*w+left,w), last=coordinate((bottom-1)*w+right-1,w);
    return first===last?first:`${first}:${last}`;
  }

  function label(cells,w,h,visible,{namedRegions=true}={}) {
    const vs = [...cells].sort((a,b) => a-b);
    if (vs.length <= 1) return vs.length ? coordinate(vs[0],w) : '';
    let left=w,right=0;
    const top=Math.floor(vs[0]/w), bottom=Math.floor(vs.at(-1)/w);
    for(const v of vs) {left=Math.min(left,v%w);right=Math.max(right,v%w);}
    const targets = new Set(vs);
    for (let r=top; r<=bottom; r++) for (let c=left; c<=right; c++) {
      const v=r*w+c;
      if (!targets.has(v) && !(visible?.[v]>=0)) return vs.map(v => coordinate(v,w)).join('');
    }
    if(namedRegions) {
      if (left === 0 && right === w-1 && top === 0 && bottom === h-1) return '全盘';
      if (left === 0 && right === w-1 && top === bottom) return `第${top+1}行`;
      if (top === 0 && bottom === h-1 && left === right) return `${column(left)}列`;
    }
    return rectangleLabel([left,top,right+1,bottom+1],w);
  }

  function regions(cells,w,h,visible) {
    const remaining=new Set(cells);
    const targets=new Set(remaining);
    const result=[];
    while (remaining.size>1) {
      let best;
      // For each row span, find runs of columns containing only targets or open gaps.
      for (let top=0; top<h; top++) {
        const counts=Array(w).fill(0);
        for (let bottom=top; bottom<h; bottom++) {
          let left=-1, right=-1, count=0;
          for (let c=0; c<=w; c++) {
            if (c<w && counts[c]>=0) {
              const v=bottom*w+c;
              if (remaining.has(v)) counts[c]++;
              else if (!(visible?.[v]>=0) || targets.has(v)) counts[c]=-1;
            }
            if (c<w && counts[c]>=0) {
              if (counts[c]) {
                if (left<0) left=c;
                right=c;
                count+=counts[c];
              }
            } else {
              const area=(bottom-top+1)*(right-left+1);
              if (count>1 && (!best || count>best.count || (count===best.count && area<best.area))) {
                best={top,bottom,left,right,count,area};
              }
              left=right=-1;
              count=0;
            }
          }
        }
      }
      if (!best) break;
      const group=[];
      for (let r=best.top; r<=best.bottom; r++) for (let c=best.left; c<=best.right; c++) {
        const v=r*w+c;
        if (remaining.delete(v)) group.push(v);
      }
      result.push(group);
    }
    for (const v of remaining) result.push([v]);
    return result.sort((a,b)=>a[0]-b[0]);
  }

  function terms(raw,groups) {
    const weights = new Map(raw);
    const result = [];
    for (const group of groups) {
      const c = weights.get(group[0]);
      if (!c || !group.every(v => weights.get(v) === c)) continue;
      result.push({coefficient:c,cells:group});
      for (const v of group) weights.delete(v);
    }
    for (const [v,c] of weights) if (c) result.push({coefficient:c,cells:[v]});
    return result.sort((a,b)=>Number(b.coefficient>0)-Number(a.coefficient>0) || a.cells[0]-b.cells[0]);
  }

  function conclusionGroups(raw,groups,w,h,visible) {
    if (!raw.length || !raw.every(([,c])=>c===raw[0][1])) return groups;
    const rectangles=regions(raw.map(([v])=>v),w,h,visible).filter(group=>group.length>1);
    const merged=new Set(rectangles.flat());
    return [...rectangles,...groups.map(group=>group.filter(v=>!merged.has(v))).filter(group=>group.length>1)];
  }

  const relation = (sign,rhs) => ({sign,constant:Math.abs(rhs),constantFirst:rhs<0});

  function comparison(raw,sign,rhs,groups) {
    const shown=relation(sign,rhs);
    return {...shown,terms:terms(shown.constantFirst ? raw.map(([v,c])=>[v,-c]) : raw,groups)};
  }

  function referenceTerms(refs,resultReflected=false) {
    const totals=new Map();
    for (const {id,k,reflected} of refs) totals.set(id,(totals.get(id)??0)+k*(reflected?-1:1));
    return [...totals].filter(([,k])=>k).map(([id,k])=>({id,k:resultReflected?-k:k}))
      .sort((a,b)=>Number(b.k>0)-Number(a.k>0))
      .map(({id,k},i)=>({id,operator:k<0?'−':i?'+':'',factor:Math.abs(k)===1?'':String(Math.abs(k))}));
  }

  function summands(node) {
    // A rounded bound is a new premise, not another sum of clue regions.
    return node.kind==='sum' ? [...summands(node.a),...summands(node.b)] : [node];
  }

  function cancellation(inputs,reflected=false) {
    const covered=new Map();
    for (const terms of inputs) for (const [cell,weight] of terms) {
      if (!weight) continue;
      const c=reflected?-weight:weight;
      const area=covered.get(cell)??{net:0,both:0};
      area.net+=c;
      area.both|=c>0?1:2;
      covered.set(cell,area);
    }
    const result={cancelled:[],positive:[],negative:[],weights:new Map()};
    for (const [cell,{net,both}] of covered) {
      if (net) {
        result.weights.set(cell,net);
        (net>0?result.positive:result.negative).push(cell);
      } else if (both===3) result.cancelled.push(cell);
    }
    return result;
  }

  function fixedCells(raw,sign,rhs) {
    let min=0, max=0;
    for(const [,c] of raw) {
      min+=Math.min(0,c);
      max+=Math.max(0,c);
    }
    const below=sign==='≥'||sign==='>' ? Infinity : rhs-min-Number(sign==='<');
    const above=sign==='≤'||sign==='<' ? Infinity : max-rhs-Number(sign==='>');
    if(below<0 || above<0) return [];
    // Leaving either extreme costs the absolute weight of the cell.
    return raw.flatMap(([v,c])=>Math.abs(c)>below ? [[v,Number(c<0)]]
      : Math.abs(c)>above ? [[v,Number(c>0)]] : []);
  }

  function isolateConclusion(raw,sign,rhs,cells,value) {
    const targets=new Set(Array.isArray(cells)?cells:[cells]);
    const [,weight]=raw.find(([v])=>targets.has(v));
    const direction=Math.sign(weight);
    const divisor=Math.abs(weight), constant=direction*rhs;
    const terms=raw.filter(([v])=>!targets.has(v)).map(([v,c])=>[v,-direction*c]);
    const upper=value===0, bound=upper?'≤':'≥';
    const strict=sign==='<' || sign==='>';
    const relation=sign==='='?'=':strict?(upper?'<':'>'):bound;
    const limit=terms.reduce((sum,[,c])=>sum+(upper?Math.max(0,c):Math.min(0,c)),constant);
    return {divisor,constant,terms,relation,bound,limit};
  }

  const rounding = reflected => reflected ? '向上取整' : '向下取整';

  function simplifyInequality(node) {
    if (node.row) return node;
    const a=simplifyInequality(node.a);
    if (node.kind==='sum') {
      const b=simplifyInequality(node.b);
      return a===node.a && b===node.b ? node : {...node,a,b,rhs:a.rhs+b.rhs};
    }
    const rhs=Math.floor(a.rhs/2);
    // Keep the stronger premise when rounding cannot tighten the same sum.
    if (a.rhs<=rhs && node.terms.length===a.terms.length &&
        node.terms.every(([v,c],i)=>v===a.terms[i][0] && c===a.terms[i][1])) return a;
    return a===node.a ? node : {...node,a,rhs};
  }

  function lineIdentity(raw,sign,rhs) {
    const ordered=raw.slice().sort(([a],[b])=>a-b);
    const flipped=sign==='≥' || (sign==='=' && ordered[0]?.[1]<0);
    return {flipped,key:JSON.stringify([
      flipped?ordered.map(([v,c])=>[v,-c]):ordered,sign==='='?'=':'≤',flipped?-rhs:rhs
    ])};
  }

  function usedLines(lines) {
    const needed=new Set();
    for (let i=lines.length-1;i>=0;i--) {
      if (!lines[i].keep && !needed.has(i+1)) continue;
      needed.add(i+1);
      for (const id of lines[i].refs) needed.add(id);
    }
    return [...needed].sort((a,b)=>a-b);
  }

  return {column,coordinate,rectangleLabel,label,regions,terms,relation,comparison,conclusionGroups,referenceTerms,summands,cancellation,fixedCells,isolateConclusion,rounding,simplifyInequality,lineIdentity,usedLines};
}

if (typeof module !== 'undefined') module.exports = makeProofFormat();
