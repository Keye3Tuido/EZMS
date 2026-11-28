// 推导浮窗与推理工具以视口坐标计算，页面负责测量和应用结果。
const proofWindowLayout=(()=>{
  const panelInset=12;
  const panelGap=8;
  const toolGap=10;
  const minPanelRoom=79;

  function positionFloatingProof({width,height,headerBottom,reasonSlot,tools,verticalDock}) {
    const top=headerBottom===undefined?panelInset:headerBottom+panelGap;
    const aboveTools=tools.top-toolGap;
    const tight=aboveTools-top<minPanelRoom;
    const shortLandscape=height<=500 && width>height;
    const rightRoom=width-tools.right;
    const leftRoom=tools.left;
    const sideRoom=Math.max(leftRoom,rightRoom);
    const side=(shortLandscape && sideRoom>=230) || ((tight || verticalDock) && sideRoom>=170);
    const useRight=side && rightRoom>leftRoom;
    const bottom=side?height-panelInset:Math.max(top+minPanelRoom,aboveTools);

    // 页面滚到当前推理时，优先把浮窗放在仍有空间的一侧。
    const belowStart=Math.max(top,reasonSlot.bottom+panelGap);
    const roomAbove=Math.min(bottom,reasonSlot.top-panelGap)-top;
    const roomBelow=bottom-belowStart;
    const useBelow=roomAbove<Math.min(180,(bottom-top)*.45) && roomBelow>roomAbove;
    return {
      left:useRight?tools.right+toolGap:panelInset,
      right:side && !useRight?width-tools.left+toolGap:undefined,
      top:Math.min(useBelow?belowStart:top,Math.max(top,bottom-minPanelRoom)),
      room:Math.max(minPanelRoom,useBelow?roomBelow:roomAbove),
      closeOnLeft:tight && !side
    };
  }

  // 返回相对按钮默认位置的偏移。无空位时，由页面决定是否缩小按钮或收起菜单。
  function findCloseButtonOffset({heading,title,button,obstacles}) {
    const circles=obstacles.map(({left,right,top,bottom})=>({
      x:(left+right)/2,y:(top+bottom)/2,r:(right-left)/2+1
    }));
    let best, distance=Infinity;
    function consider(x,y) {
      const right=x+button.width, bottom=y+button.height;
      const dx=x-button.left, dy=y-button.top;
      const cost=Math.abs(dx)+Math.abs(dy);
      if(cost>=distance) return;
      if(x<title.right+1 && right>title.left-1 && y<title.bottom && bottom>title.top) return;
      for(const circle of circles) {
        const gapX=Math.max(0,x-circle.x,circle.x-right);
        const gapY=Math.max(0,y-circle.y,circle.y-bottom);
        if(gapX*gapX+gapY*gapY<circle.r*circle.r) return;
      }
      best={x:dx,y:dy};
      distance=cost;
    }
    consider(button.left,button.top);
    if(distance===0) return best;
    for(let y=heading.top+1;y+button.height<=heading.bottom-1;y+=2) {
      for(let x=heading.left+1;x+button.width<=heading.right-1;x+=2) consider(x,y);
    }
    return best;
  }

  return {positionFloatingProof,findCloseButtonOffset};
})();

if(typeof module!=='undefined') module.exports=proofWindowLayout;
