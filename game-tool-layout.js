// 把圆弧几何应用到页面，并为紧凑布局中的推导浮窗留出空间。
function makeGameToolLayout({$,radialLayout,viewport,header,reasonSlot,proofPane,reasonContent,reasonStatus,
  openReasonPanel,compactReason,isProofVisible,isReasonCollapsed,isEditing}) {
  let reasonMenuBounds;

  function positionProofWindow() {
    if(!compactReason.matches || !isProofVisible()) return;
    const top=document.documentElement.dataset.fullscreenMode ? header.getBoundingClientRect().bottom+8 : 12;
    const minRoom=proofPane.querySelector('.panel-head').offsetHeight+24;
    const gap=10;
    // Use the settled layout, even while the circular buttons are in motion.
    const {left:fanLeft,right:fanRight,top:fanTop}=$('reasonFlower').inert
      ? $('toolDock').getBoundingClientRect() : reasonMenuBounds;
    const aboveFan=fanTop-gap;
    const shortLandscape=window.innerHeight <= 500 && window.innerWidth > window.innerHeight;
    const tight=aboveFan-top<minRoom;
    const rightRoom=window.innerWidth-fanRight;
    const sideRoom=Math.max(fanLeft,rightRoom);
    const side=(shortLandscape && sideRoom>=230) || (tight && sideRoom>=170);
    const useRight=side && rightRoom>fanLeft;
    proofPane.classList.toggle('proof-close-left',tight && !side);
    proofPane.style.setProperty('--proof-left',useRight?`${fanRight+gap}px`:'12px');
    if(side && !useRight) proofPane.style.setProperty('--proof-right',`${window.innerWidth-fanLeft+gap}px`);
    else proofPane.style.removeProperty('--proof-right');
    const bottom=side?window.innerHeight-12:Math.max(top+minRoom,aboveFan);
    const rect=reasonSlot.getBoundingClientRect();
    const above=Math.min(bottom,rect.top-8)-top;
    const below=bottom-Math.max(top,rect.bottom+8);
    // Leave the current reasoning visible even when the page is scrolled to it.
    const useBelow=above<Math.min(180,(bottom-top)*.45) && below>above;
    const y=useBelow?Math.max(top,rect.bottom+8):top;
    const room=useBelow?below:above;
    // Leave room for the title and a scrollable strip on short screens.
    proofPane.style.setProperty('--proof-top',`${Math.min(y,Math.max(top,bottom-minRoom))}px`);
    proofPane.style.setProperty('--proof-room',`${Math.max(minRoom,room)}px`);
  }

  function syncProofLayout() {
    const floating=compactReason.matches;
    const collapsed=isReasonCollapsed(), visible=isProofVisible();
    const parent=floating?viewport:reasonContent;
    const active=document.activeElement, focused=proofPane.contains(active);
    const moved=proofPane.parentElement!==parent;
    if(moved) parent.append(proofPane);
    proofPane.setAttribute('role',floating?'dialog':'region');
    reasonStatus.inert=collapsed || (!floating && visible);
    proofPane.inert=!visible || (!floating && collapsed);
    if(focused && moved && !proofPane.inert) active.focus({preventScroll:true});
    else if(focused && visible && collapsed && !floating) openReasonPanel.focus({preventScroll:true});
    if(!floating && !proofPane.inert && !$('reasonFlower').inert) layoutRadial('reason');
    positionProofWindow();
  }

  function layoutRadial(name) {
    const flower=$(`${name}Flower`),launcher=$(`${name}Menu`);
    const items=[...flower.querySelectorAll('.petal,.mark-option')].filter(item=>!item.hidden);
    if(!items.length) return;
    const dock=$('toolDock'), dockRect=dock.getBoundingClientRect();
    const dockButtonRect=button=>{
      const left=dockRect.left+button.offsetLeft, top=dockRect.top+button.offsetTop;
      const width=button.offsetWidth, height=button.offsetHeight;
      return {left,top,width,height,right:left+width,bottom:top+height};
    };
    const anchor=dockButtonRect(launcher);
    const viewport=document.documentElement;
    const originX=anchor.left+anchor.width/2, originY=anchor.top+anchor.height/2;
    const obstacles=[...dock.querySelectorAll('.launcher')].filter(item=>item!==launcher && !item.hidden).map(dockButtonRect);
    const kind=name==='reason'?'reason':name==='mark'&&!isEditing()?'ring':name==='selection'?'selection':'fan';
    const stickyHeader=kind==='reason' && viewport.dataset.fullscreenMode ? header.getBoundingClientRect() : null;
    if(stickyHeader) {
      for(const button of header.querySelectorAll('button:not([hidden])')) obstacles.push(button.getBoundingClientRect());
    }
    if(kind==='reason' && !compactReason.matches && !proofPane.inert) {
      for(const button of proofPane.querySelectorAll('.panel-head button')) obstacles.push(button.getBoundingClientRect());
    }
    const positioned=radialLayout.arrange(items.map(item=>({item,width:item.offsetWidth,height:item.offsetHeight})),{
      width:viewport.clientWidth,height:viewport.clientHeight,originX,originY,obstacles,launcher:anchor,kind,header:stickyHeader
    });
    if(kind==='reason') reasonMenuBounds={
      left:originX+positioned.center.x+positioned.bounds.left,
      right:originX+positioned.center.x+positioned.bounds.right,
      top:originY+positioned.center.y+positioned.bounds.top
    };
    // A fixed element's origin may include a reserved scrollbar gutter.
    const frame=flower.getBoundingClientRect(), style=getComputedStyle(flower);
    const [movingX=0,movingY=0]=style.translate.split(' ').map(value=>parseFloat(value)||0);
    const frameX=frame.left-movingX-parseFloat(style.left);
    const frameY=frame.top-movingY-parseFloat(style.top);
    flower.style.left=`${originX-frameX}px`;
    flower.style.top=`${originY-frameY}px`;
    for(const point of positioned.items) {
      point.item.style.setProperty('--x',`${point.x}px`);
      point.item.style.setProperty('--y',`${point.y}px`);
    }
    for(const element of [flower,launcher]) {
      element.style.setProperty('--menu-x',`${positioned.center.x}px`);
      element.style.setProperty('--menu-y',`${positioned.center.y}px`);
    }
    flower.classList.toggle('over-header',positioned.overHeader);
    launcher.classList.toggle('over-header',positioned.overHeader);
    const track=flower.querySelector('.radial-track');
    if(track) {
      const mark=positioned.items;
      const launcherPoint={x:0,y:0};
      if(kind==='ring' || kind==='selection' || kind==='reason') {
        const id=kind==='ring'?'inkTrack':`${kind}Track`;
        track.querySelector(`#${id}`).setAttribute('d',radialLayout.ringArcPath(mark));
      } else {
        const path=track.querySelector('path:not([id])')??track.querySelector('#redInkTrack');
        const ordered=radialLayout.orderAlongArc(mark,launcherPoint);
        path?.setAttribute('d',radialLayout.pathThrough(ordered,launcherPoint));
      }
      const coords=[[launcherPoint.x,launcherPoint.y],...positioned.items.map(point=>[point.x,point.y])];
      const xs=coords.map(point=>point[0]),ys=coords.map(point=>point[1]);
      const left=Math.min(...xs)-12,top=Math.min(...ys)-12,width=Math.max(...xs)-left+12,height=Math.max(...ys)-top+12;
      track.setAttribute('viewBox',`${left} ${top} ${width} ${height}`);
      track.style.left=`${left}px`;track.style.top=`${top}px`;track.style.width=`${width}px`;track.style.height=`${height}px`;
      track.style.transformOrigin=`${-left}px ${-top}px`;
    }
  }

  let radialLayoutFrame=0;
  const refreshOpenRadials=()=>{
    cancelAnimationFrame(radialLayoutFrame);
    radialLayoutFrame=requestAnimationFrame(()=>{
      for(const name of ['mark','selection','reason']) if(!$(`${name}Flower`).inert) layoutRadial(name);
      positionProofWindow();
    });
  };
  function observe() {
    compactReason.addEventListener('change',syncProofLayout);
    document.addEventListener('scroll',event=>{
      if(compactReason.matches) positionProofWindow();
      else if(!proofPane.inert && !$('reasonFlower').inert &&
        (event.target===document || event.target===header.parentElement)) refreshOpenRadials();
    },{capture:true,passive:true});
    addEventListener('resize',refreshOpenRadials);
    window.visualViewport?.addEventListener('resize',refreshOpenRadials);
    new MutationObserver(refreshOpenRadials).observe(document.documentElement,{
      attributes:true,attributeFilter:['data-fullscreen-mode']
    });
    const toolLayoutObserver=new ResizeObserver(refreshOpenRadials);
    toolLayoutObserver.observe(header);
    toolLayoutObserver.observe(reasonSlot);
  }
  return {layoutRadial,positionProofWindow,syncProofLayout,observe};
}
