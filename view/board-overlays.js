// 棋盘覆盖层只读取局面和高亮数据，维护笔迹与区域路径。
function makeBoardOverlays({$,contour,inkTrails,inkPath}) {
  const proofDrawing=document.createElementNS('http://www.w3.org/2000/svg','svg');
  proofDrawing.classList.add('board-proof');
  proofDrawing.setAttribute('aria-hidden','true');
  const proofPattern=document.createElementNS(proofDrawing.namespaceURI,'defs');
  const hatch=document.createElementNS(proofDrawing.namespaceURI,'pattern');
  for(const [name,value] of Object.entries({id:'proof-hatch',patternUnits:'userSpaceOnUse',width:6,height:6,patternTransform:'rotate(45)'})) hatch.setAttribute(name,value);
  const hatchLine=document.createElementNS(proofDrawing.namespaceURI,'rect');
  hatchLine.setAttribute('width','2'); hatchLine.setAttribute('height','6');
  hatch.append(hatchLine); proofPattern.append(hatch);
  const inkDrawing=document.createElementNS('http://www.w3.org/2000/svg','svg');
  inkDrawing.classList.add('board-ink');
  inkDrawing.setAttribute('aria-hidden','true');
  let paintedInk='';
  const proofKinds=['cancelled','positive','negative','element','selection-positive','selection-negative'];
  function paintInk(game,editing) {
    if(!game) return;
    const {w}=game.board, root=$('board'), style=getComputedStyle(root);
    const [axis,tile]=style.gridTemplateColumns.split(' ',2).map(parseFloat);
    const [axisY,height]=style.gridTemplateRows.split(' ',2).map(parseFloat);
    const dx=tile+parseFloat(style.columnGap),dy=height+parseFloat(style.rowGap);
    const left=axis+dx-tile/2, top=axisY+dy-height/2;
    if(!Number.isFinite(left+top)) return;
    const redCells=editing?game.notes.layers.red.keys():game.manual?.marked.keys()??[];
    const covered=([i])=>game.visible[i]<0;
    const visibleRed=new Map([...redCells].map(i=>[i,confirmedInk(game,i,editing)]).filter(covered));
    const layers=[['red',visibleRed],['blue',[...game.notes.layers.blue].filter(covered)]];
    const width=parseFloat(style.width), boardHeight=parseFloat(style.height);
    const key=JSON.stringify([w,width,boardHeight,tile,height,dx,dy,left,top,...layers.map(([,ink])=>[...ink])]);
    if(key===paintedInk) return;
    paintedInk=key;
    const center=i=>[left+i%w*dx,top+Math.floor(i/w)*dy];
    const paths=document.createDocumentFragment();
    const draw=(color,d,weight)=>{
      const path=document.createElementNS(inkDrawing.namespaceURI,'path');
      path.setAttribute('class',color);
      path.setAttribute('d',d);
      path.setAttribute('stroke-width',weight);
      paths.append(path);
    };
    const weight=Math.max(1.2,tile*.054);
    for(const [color,ink] of layers) {
      const lines=new Map();
      for(const [i,{symbol,level}] of ink) {
        if(symbol==='x') {
          const [x,y]=center(i), r=tile*(color==='blue'?.29:.36);
          draw(color,`M${x-r},${y-r}L${x+r},${y+r}M${x-r},${y+r}L${x+r},${y-r}`,weight);
        } else if(symbol==='/' || symbol==='//') {
          const group=symbol==='/'?0:level;
          if(!lines.has(group)) lines.set(group,[]);
          lines.get(group).push(i);
        }
      }
      for(const [rank,cells] of lines) for(const {cells:trail,closed} of inkTrails(cells,w)) {
        const points=trail.map(center);
        const overlaps=color==='blue' && !rank && trail.some(i=>visibleRed.get(i)?.symbol==='/');
        for(const shift of rank?[-tile*.09,tile*.09]:[overlaps?tile*.13:0]) {
          draw(color,inkPath(points,tile,shift,closed),weight*(rank?.78:1));
        }
      }
    }
    inkDrawing.setAttribute('viewBox',`0 0 ${width} ${boardHeight}`);
    inkDrawing.replaceChildren(paths);
  }
  function proofGeometry() {
    const root=$('board'), style=getComputedStyle(root);
    const columns=style.gridTemplateColumns.split(' ',2).map(parseFloat);
    const rows=style.gridTemplateRows.split(' ',2).map(parseFloat);
    if(columns.length<2 || rows.length<2) return null;
    const tile=columns[1], height=rows[1];
    const dx=tile+parseFloat(style.columnGap), dy=height+parseFloat(style.rowGap);
    const left=columns[0]+dx-tile/2, top=rows[0]+dy-height/2;
    const width=parseFloat(style.width), boardHeight=parseFloat(style.height);
    return Number.isFinite(left+top+dx+dy) ? {width,boardHeight,tile,height,dx,dy,left,top} : null;
  }

  function coefficientDepth(weight=1) {
    const magnitude=Math.abs(weight);
    return magnitude>1 ? .66*(magnitude-1)/(magnitude+1) : 0;
  }

  function paintProofAreas(game,activeAreaPreview) {
    if(!activeAreaPreview || !game) { proofDrawing.replaceChildren(); return; }
    const geo=proofGeometry();
    if(!geo) return;
    const {w,h}=game.board, {width,boardHeight,tile,height,dx,dy,left,top}=geo;
    const step=Math.min(tile,height);
    const grid={x:left-dx/2,y:top-dy/2,dx,dy,radius:Math.min(6,step*.16),inset:Math.min(1.75,step*.1)};
    const paths=document.createDocumentFragment();
    const {areas,weights}=activeAreaPreview;
    const append=(kind,d,parent=paths)=>{
      const path=document.createElementNS(proofDrawing.namespaceURI,'path');
      path.setAttribute('class',kind);
      path.setAttribute('d',d);
      path.setAttribute('fill-rule','evenodd');
      parent.append(path);
      return path;
    };
    for(const [i,kind] of proofKinds.entries()) {
      const cells=areas[i];
      if(!cells?.size) continue;
      const opposite={positive:2,negative:1,'selection-positive':5,'selection-negative':4}[kind];
      const d=contour(cells,w,h,grid,areas[opposite]);
      append(kind,d);
      if(weights?.size && kind!=='cancelled') {
        const shades=new Map();
        for(const cell of cells) {
          const magnitude=Math.abs(weights.get(cell)??1);
          if(magnitude<=1) continue;
          const x=grid.x+(cell%w)*dx, y=grid.y+Math.floor(cell/w)*dy;
          const square=`M${x},${y}H${x+dx}V${y+dy}H${x}Z`;
          shades.set(magnitude,(shades.get(magnitude)??'')+square);
        }
        if(shades.size) {
          // Clip the shading to the shared contour so adjacent weights do not create extra borders.
          const clip=document.createElementNS(proofDrawing.namespaceURI,'clipPath');
          const shading=document.createElementNS(proofDrawing.namespaceURI,'g');
          const clipId=`${kind}-clip`;
          clip.setAttribute('id',clipId);
          append('',d,clip).setAttribute('clip-rule','evenodd');
          shading.setAttribute('clip-path',`url(#${clipId})`);
          for(const [magnitude,squares] of shades) {
            append(`${kind}-shade`,squares,shading).setAttribute('fill-opacity',coefficientDepth(magnitude));
          }
          paths.append(clip,shading);
        }
      }
      if(kind==='element') append('element-hatch',d);
      append(`${kind} boundary`,d);
    }
    proofDrawing.setAttribute('viewBox',`0 0 ${width} ${boardHeight}`);
    proofDrawing.replaceChildren(proofPattern,paths);
  }

  function confirmedInk(g,i,editing) {
    const kind=g.manual?.marked.get(i);
    return kind?{symbol:kind==='mine'?'x':'/',level:0}:editing?g.notes.layers.red.get(i):undefined;
  }

  return {proofDrawing,inkDrawing,paintInk,paintProofAreas,confirmedInk,coefficientDepth};
}
