// 棋盘笔迹路径、标记符号和坐标定位。
function inkTrails(cells,width) {
  const all=new Set([...cells].sort((a,b)=>a-b)), paths=[];
  const neighbors=i=>[...(i%width?[i-1]:[]),...(i%width<width-1?[i+1]:[]),i-width,i+width].filter(v=>all.has(v));
  const closes=trail=>trail.length>2 && neighbors(trail[0]).includes(trail.at(-1));
  for(const start of all) {
    const component=[start], seen=new Set(component);
    for(const i of component) for(const v of neighbors(i)) if(!seen.has(v)) {seen.add(v);component.push(v);}
    const edges=component.flatMap(i=>neighbors(i).filter(v=>i<v).map(v=>[i,v]));
    edges.sort(([a,b],[c,d])=>neighbors(a).length+neighbors(b).length-neighbors(c).length-neighbors(d).length || a-c || b-d);
    const links=new Map(component.map(i=>[i,[]]));
    const wouldCycle=(a,b)=>{
      let previous=-1;
      while(a!==undefined) {
        if(a===b) return true;
        const next=links.get(a).find(i=>i!==previous);
        previous=a; a=next;
      }
      return false;
    };
    const ends=(a,b)=>links.get(a).length<2 && links.get(b).length<2 && !wouldCycle(a,b);
    const append=(a,b)=>{links.get(a).push(b);links.get(b).push(a);};
    const take=()=>{
      const used=new Set(), result=[];
      for(const i of component) if(links.get(i).length<2 && !used.has(i)) {
        const trail=[];
        for(let v=i;v!==undefined;v=links.get(v).find(x=>!used.has(x))) {used.add(v);trail.push(v);}
        result.push(trail);
      }
      return result.sort((a,b)=>b.length-a.length);
    };
    const direction=(a,b)=>[Math.sign(b%width-a%width),Math.sign(Math.floor(b/width)-Math.floor(a/width))];
    const turns=(trail,closed)=>{
      if(trail.length<3) return 0;
      const edges=trail.slice(1).map((v,i)=>direction(trail[i],v));
      if(closed) edges.push(direction(trail.at(-1),trail[0]));
      let count=0;
      for(let i=1;i<edges.length;i++) if(edges[i][0]!==edges[i-1][0] || edges[i][1]!==edges[i-1][1]) count++;
      if(closed && edges.length>1 && (edges[0][0]!==edges.at(-1)[0] || edges[0][1]!==edges.at(-1)[1])) count++;
      return count;
    };
    const better=(a,b)=>{
      if(a.length!==b.length) return a.length<b.length;
      const ac=a.filter(closes), bc=b.filter(closes);
      if(ac.length!==bc.length) return ac.length>bc.length;
      const at=ac.reduce((sum,path)=>sum+turns(path,true),0), bt=bc.reduce((sum,path)=>sum+turns(path,true),0);
      if(at!==bt) return at<bt;
      const first=a.findIndex((path,i)=>path.length!==b[i].length);
      return first>=0 ? a[first].length>b[first].length : a.filter(closes).length>b.filter(closes).length;
    };
    let best=component.map(i=>[i]);
    for(const order of [edges,[...edges].sort(([a,b],[c,d])=>Number(a+1!==b)-Number(c+1!==d)),
      [...edges].sort(([a,b],[c,d])=>Number(a+1===b)-Number(c+1===d)),[...edges].reverse()]) {
      for(const i of component) links.get(i).length=0;
      for(const [a,b] of order) if(ends(a,b)) append(a,b);
      const result=take(); if(better(result,best)) best=result;
    }
    // Large components use bounded search so ink stays responsive during play.
    if(component.length<=18 || best.length>1) {
      for(const i of component) links.get(i).length=0;
      let remaining=component.length<=18?120000:4000;
      const improve=(at,count)=>{
        if(--remaining<0) return;
        if(count>=component.length-best.length) {
          const result=take();
          if(better(result,best)) best=result;
        }
        if(at===edges.length) return;
        if(count+edges.length-at<component.length-best.length) return;
        const [a,b]=edges[at];
        if(ends(a,b)) {append(a,b);improve(at+1,count+1);links.get(a).pop();links.get(b).pop();}
        improve(at+1,count);
      };
      improve(0,0);
    }
    for(const cells of best) paths.push({cells,closed:closes(cells)});
    for(const i of component) all.delete(i);
  }
  return paths;
}

function inkPath(points,tile,offset=0,closed=false) {
  const unit=([x,y],[u,v])=>[Math.sign(u-x),Math.sign(v-y)];
  const move=([x,y],[u,v],distance)=>[x+u*distance,y+v*distance];
  const parallel=(p,[x,y])=>move(p,[-y,x],offset);
  const extent=tile*.33;
  if(points.length===1) {
    const [x,y]=points[0];
    return `M${x-extent},${y+offset}H${x+extent}`;
  }
  const sides=points.slice(1).map((p,i)=>unit(points[i],p));
  if(closed) sides.push(unit(points.at(-1),points[0]));
  const start=sides[0],last=sides.at(-1);
  const radius=tile*.27;
  let d=`M${move(parallel(points[0],start),start,closed?radius:-extent)}`;
  for(let i=1;i<(closed?points.length+1:points.length-1);i++) {
    const at=i%points.length, before=sides[i-1], after=sides[at];
    if(before[0]===after[0] && before[1]===after[1]) continue;
    const p=points[at], corner=parallel(parallel(p,before),after);
    const a=move(parallel(p,before),before,-radius), b=move(parallel(p,after),after,radius);
    d+=`L${a}Q${corner} ${b}`;
  }
  return closed?d+'Z':d+`L${move(parallel(points.at(-1),last),last,extent)}`;
}

function focusBoardCell(game,buttons,target) {
  if (!buttons[target]) return;
  if (buttons[game.focus]) buttons[game.focus].tabIndex = -1;
  game.focus = target;
  buttons[game.focus].tabIndex = 0;
  buttons[game.focus].focus();
}

const inkShapes=new Map([
  ['x','<path d="M4 4L20 20M20 4L4 20"/>'],
  ['o','<circle cx="12" cy="12" r="10"/>'],
  ['s','<path d="M20 5C17 1 6 1 5 7C4 12 20 11 20 17C19 23 8 23 4 19"/>'],
  ['e','<path d="M3 12H21C21 6 17 2 12 2C7 2 3 6 3 12C3 18 7 22 13 22C16 22 18 21 20 19"/>'],
  ['v','<path d="M3 3L11 20Q12 22 13 20L21 3"/>'],
  ['ʌ','<path d="M3 21L11 4Q12 2 13 4L21 21"/>'],
]);
function inkGlyph(symbol) {
  const shape=inkShapes.get(symbol);
  return shape?`<svg class="ink-glyph" viewBox="0 0 24 24" aria-hidden="true">${shape}</svg>`:'';
}

if(typeof module!=='undefined') module.exports={inkTrails,inkPath,focusBoardCell,inkGlyph};
