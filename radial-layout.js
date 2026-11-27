function makeRadialLayout() {
  const radians=degrees=>degrees*Math.PI/180;

  function pathThrough(points,start={x:0,y:0}) {
    const all=[start,...points];
    if(all.length<2) return '';
    const tangents=all.map((point,index)=>{
      if(index===0) {
        const next=all[1],dx=next.x-point.x,dy=next.y-point.y,length=Math.hypot(dx,dy)||1;
        return {x:dx/length,y:dy/length};
      }
      const before=all[Math.max(0,index-1)],after=all[Math.min(all.length-1,index+1)];
      const dx=after.x-before.x,dy=after.y-before.y,length=Math.hypot(dx,dy)||1;
      return {x:dx/length,y:dy/length};
    });
    return all.slice(0,-1).map((point,index)=>{
      const next=all[index+1],distance=Math.hypot(next.x-point.x,next.y-point.y);
      const handle=distance/3,start=tangents[index],end=tangents[index+1];
      const c1={x:point.x+start.x*handle,y:point.y+start.y*handle};
      const c2={x:next.x-end.x*handle,y:next.y-end.y*handle};
      return `${index?'':'M '+point.x+' '+point.y+' '}C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${next.x} ${next.y}`;
    }).join(' ');
  }

  function pathsThrough(groups,start={x:0,y:0}) {
    return groups
      .filter(group=>group.length)
      .map(group=>pathThrough(group,start).trim())
      .filter(Boolean)
      .join(' ');
  }

  function semicirclePath(points) {
    if(points.length<2) return '';
    const first=points[0],last=points.at(-1);
    const rx=(last.x-first.x)/2;
    const baseline=(first.y+last.y)/2;
    const ry=baseline-Math.min(...points.map(point=>point.y));
    if(rx<=0||ry<=0) return pathThrough(points);
    return `M ${first.x} ${first.y} A ${rx} ${ry} 0 0 1 ${last.x} ${last.y}`;
  }

  function ringArcPath(points) {
    if(points.length<2) return '';
    const [start,...rest]=orderAlongArc(points,{x:0,y:0});
    const end=rest.at(-1), radius=Math.hypot(start.x,start.y), turn=2*Math.PI;
    const span=(Math.atan2(end.y,end.x)-Math.atan2(start.y,start.x)+turn)%turn;
    return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${Number(span>Math.PI)} 1 ${end.x} ${end.y}`;
  }

  function orderAlongArc(points,origin) {
    if(points.length<2) return [...points];
    const turn=Math.PI*2;
    const ordered=points.map(point=>({point,angle:(Math.atan2(point.y-origin.y,point.x-origin.x)+turn)%turn,
      distance:Math.hypot(point.x-origin.x,point.y-origin.y)})).sort((a,b)=>a.angle-b.angle||a.distance-b.distance);
    let largestGap=-1,start=0;
    for(let index=0;index<ordered.length;index++) {
      const next=(index+1)%ordered.length;
      const gap=(ordered[next].angle+(next===0?turn:0))-ordered[index].angle;
      if(gap>largestGap) {largestGap=gap;start=next;}
    }
    return [...ordered.slice(start),...ordered.slice(0,start)].map(item=>item.point);
  }

  function fan(count,radius,start,end) {
    if(count===0) return [];
    if(count===1) return [{x:0,y:-radius}];
    return Array.from({length:count},(_,index)=>{
      const angle=radians(start+(end-start)*index/(count-1));
      return {x:Math.cos(angle)*radius,y:Math.sin(angle)*radius};
    });
  }

  function radiusFor(count,diameter,span,gap=12) {
    if(count<2) return diameter+gap;
    const step=radians(span/(count-1));
    return Math.max(diameter*1.35,(diameter+gap)/(2*Math.sin(step/2)));
  }

  function center(points,sizes) {
    const bounds=points.reduce((box,point,index)=>({
      left:Math.min(box.left,point.x-sizes[index].width/2),
      right:Math.max(box.right,point.x+sizes[index].width/2),
      top:Math.min(box.top,point.y-sizes[index].height/2),
      bottom:Math.max(box.bottom,point.y+sizes[index].height/2),
    }),{left:Infinity,right:-Infinity,top:Infinity,bottom:-Infinity});
    return {x:(bounds.left+bounds.right)/2,y:(bounds.top+bounds.bottom)/2};
  }

  function overlaps(points,sizes,gap=10) {
    for(let a=0;a<points.length;a++) for(let b=a+1;b<points.length;b++) {
      const dx=Math.abs(points[a].x-points[b].x),dy=Math.abs(points[a].y-points[b].y);
      if(dx<(sizes[a].width+sizes[b].width)/2+gap && dy<(sizes[a].height+sizes[b].height)/2+gap) return true;
    }
    return false;
  }

  function overlapsLauncher(points,sizes,launcher,gap=10) {
    if(!launcher) return false;
    const target=center(points,sizes);
    return points.some((point,index)=>
      Math.abs(point.x-target.x)<(sizes[index].width+launcher.width)/2+gap &&
      Math.abs(point.y-target.y)<(sizes[index].height+launcher.height)/2+gap);
  }

  function overlapsRect(rect,obstacle,gap) {
    return rect.right>obstacle.left-gap &&
      rect.left<obstacle.right+gap &&
      rect.bottom>obstacle.top-gap &&
      rect.top<obstacle.bottom+gap;
  }

  function overlapsObstacles(points,sizes,launcher,launcherTarget,obstacles,originX,originY,dx,dy,gap=14) {
    const buttonRects=points.map((point,index)=>({
      left:originX+point.x+dx-sizes[index].width/2,
      right:originX+point.x+dx+sizes[index].width/2,
      top:originY+point.y+dy-sizes[index].height/2,
      bottom:originY+point.y+dy+sizes[index].height/2,
    }));
    if(launcher) buttonRects.push({
      left:originX+launcherTarget.x+dx-launcher.width/2,
      right:originX+launcherTarget.x+dx+launcher.width/2,
      top:originY+launcherTarget.y+dy-launcher.height/2,
      bottom:originY+launcherTarget.y+dy+launcher.height/2,
    });
    return buttonRects.some(rect=>obstacles.some(obstacle=>overlapsRect(rect,obstacle,gap)));
  }

  function arrange(items,{width,height,kind='fan',originX=0,originY=0,padding=20,launcher=null,obstacles=[]}) {
    if(!items.length) return {items:[],center:{x:0,y:0},bounds:{left:0,right:0,top:0,bottom:0}};
    const sizes=items.map(item=>({width:item.width,height:item.height}));
    const top=originY,right=width-originX,bottom=height-originY,left=originX;
    let twoItemArc=[180,360];
    if(items.length===2) {
      const nearest=Math.min(top,right,bottom,left);
      if(nearest===bottom) twoItemArc=[225,315];
      else if(nearest===top) twoItemArc=[45,135];
      else if(nearest===right) twoItemArc=[135,225];
      else twoItemArc=[-45,45];
    }
    const selection=kind==='selection';
    const [fanStart,fanEnd]=selection?[186,354]:items.length===2?twoItemArc:[180,360];
    const span=kind==='ring'?300:kind==='paired'?110:fanEnd-fanStart;
    const diameter=Math.max(...sizes.map(size=>Math.max(size.width,size.height)));
    let radius=radiusFor(Math.ceil(items.length/(kind==='paired'?2:1)),
      diameter,span);
    let points;
    const fanPoints=()=>fan(items.length,radius,fanStart,fanEnd);
    let pairedOrientation='horizontal';
    const pairedPoints=()=>{
      const sideCount=Math.ceil(items.length/2);
      const sideAngles=Array.from({length:sideCount},(_,index)=>
        radians((pairedOrientation==='horizontal'?-75:-30)+(pairedOrientation==='horizontal'?110:60)*(sideCount===1?.5:index/(sideCount-1))));
      return items.map((_,index)=>{
        const side=index<sideCount?-1:1,angle=sideAngles[index%sideCount];
        const x=pairedOrientation==='horizontal'
          ? side*Math.cos(angle)*radius
          : side*(Math.max(...sizes.map(size=>size.width))/2+(launcher?.width??0)/2+16+radius*(1-Math.cos(angle)));
        return {x,y:Math.sin(angle)*radius};
      });
    };
    if(kind==='fan'&&items.length>2) {
      const candidate=fanPoints();
      const left=Math.min(...candidate.map((point,index)=>point.x-sizes[index].width/2));
      const right=Math.max(...candidate.map((point,index)=>point.x+sizes[index].width/2));
      const widest=Math.max(...sizes.map(size=>size.width));
      if(right-left>width-padding*2 || Math.min(originX,width-originX)<widest/2+padding) kind='paired';
    }
    if(kind==='ring') {
      const arc=fan(items.length,radius,120,420);
      const leftCount=Math.ceil(items.length/2);
      points=[...arc.slice(0,leftCount).reverse(),...arc.slice(leftCount)];
    } else if(selection) {
      // The four circular buttons and launcher share the same center of rotation.
      const launcherDiameter=launcher?Math.max(launcher.width,launcher.height):0;
      radius=Math.max(radius,(diameter+launcherDiameter)/2+10);
      points=fanPoints();
    } else if(kind==='paired') {
      const horizontalWidth=radius*2+Math.max(...sizes.map(size=>size.width));
      if(horizontalWidth>width-padding*2) {
        pairedOrientation='vertical';
        radius=radiusFor(Math.ceil(items.length/2),Math.max(...sizes.map(size=>size.height)),60,10);
      }
      points=pairedPoints();
    }
    else points=fanPoints();
    for(let attempt=0;kind!=='ring'&&!selection&&(overlaps(points,sizes)||overlapsLauncher(points,sizes,launcher))&&attempt<96;attempt++) {
      if(kind==='paired') {
        radius*=1.08;
        if(pairedOrientation==='horizontal'&&radius*2+Math.max(...sizes.map(size=>size.width))>width-padding*2) {
          pairedOrientation='vertical';
          radius=radiusFor(Math.ceil(items.length/2),Math.max(...sizes.map(size=>size.height)),60,10);
        }
        points=pairedPoints();
      }
      else {radius*=1.18;points=fanPoints();}
    }
    if(kind==='reason' && points.length>2) {
      const halfWidth=(width-2*padding-diameter)/2;
      const extent=Math.max(...points.map(point=>Math.abs(point.x)));
      if(halfWidth>0 && extent>halfWidth) {
        points=points.map(point=>({...point,x:point.x*halfWidth/extent}));
      }
    }
    const target=(kind==='ring'||selection)?{x:0,y:0}:center(points,sizes);
    const positioned=points.map(point=>({x:point.x-target.x,y:point.y-target.y}));
    const bounds=positioned.reduce((box,point,index)=>({
      left:Math.min(box.left,point.x-sizes[index].width/2),
      right:Math.max(box.right,point.x+sizes[index].width/2),
      top:Math.min(box.top,point.y-sizes[index].height/2),
      bottom:Math.max(box.bottom,point.y+sizes[index].height/2),
    }),{left:Infinity,right:-Infinity,top:Infinity,bottom:-Infinity});
    const rawPoints=launcher?[...points,{x:0,y:0}]:points;
    const rawSizes=launcher?[...sizes,{width:launcher.width,height:launcher.height}]:sizes;
    const rawBounds=rawPoints.reduce((box,point,index)=>({
      left:Math.min(box.left,point.x-rawSizes[index].width/2),
      right:Math.max(box.right,point.x+rawSizes[index].width/2),
      top:Math.min(box.top,point.y-rawSizes[index].height/2),
      bottom:Math.max(box.bottom,point.y+rawSizes[index].height/2),
    }),{left:Infinity,right:-Infinity,top:Infinity,bottom:-Infinity});
    const margin=padding;
    const minX=margin-originX-rawBounds.left,maxX=width-margin-originX-rawBounds.right;
    const minY=margin-originY-rawBounds.top,maxY=height-margin-originY-rawBounds.bottom;
    let dx=minX<=maxX?Math.min(maxX,Math.max(minX,0)):((minX+maxX)/2);
    let dy=minY<=maxY?Math.min(maxY,Math.max(minY,0)):((minY+maxY)/2);
    if(obstacles.length && minX<=maxX && minY<=maxY &&
      overlapsObstacles(points,sizes,launcher,target,obstacles,originX,originY,dx,dy)) {
      const offsets=(min,max,preferred)=>{
        const values=new Set([min,max,preferred]);
        for(let value=min;value<=max;value+=8) values.add(value);
        return [...values].sort((a,b)=>Math.abs(a-preferred)-Math.abs(b-preferred));
      };
      const xOffsets=offsets(minX,maxX,dx),yOffsets=offsets(minY,maxY,dy);
      let best;
      for(const candidateY of yOffsets) for(const candidateX of xOffsets) {
        const cost=(candidateX-dx)**2+(candidateY-dy)**2;
        if(best && cost>=best.cost) continue;
        if(!overlapsObstacles(points,sizes,launcher,target,obstacles,originX,originY,candidateX,candidateY))
          best={x:candidateX,y:candidateY,cost};
      }
      if(best) {dx=best.x;dy=best.y;}
    }
    const offset={x:target.x+dx,y:target.y+dy};
    return {items:items.map((item,index)=>({...item,x:positioned[index].x,y:positioned[index].y,
      fromX:0,fromY:0,screenX:points[index].x+dx,screenY:points[index].y+dy})),center:offset,bounds};
  }

  return {fan,radiusFor,center,arrange,pathThrough,pathsThrough,semicirclePath,ringArcPath,orderAlongArc};
}

if(typeof module!=='undefined') module.exports=makeRadialLayout;
