// 把圆弧几何应用到页面，管理推导窗口在侧栏、浮窗和手机分屏中的布局。
function makeGameToolLayout({$,radialLayout,proofLayout,viewport,header,reasonSlot,proofPane,reasonContent,reasonStatus,
  openReasonPanel,compactReason,isProofVisible,isReasonCollapsed,isEditing,collapseReasonTools}) {
  const phoneProof=matchMedia('(pointer: coarse) and (max-width: 1000px)');
  let reasonMenuBounds, reasonButtons=[], pageScroll;

  function positionProofWindow() {
    if(proofPane.inert || viewport.classList.contains('mobile-proof-split')) return;
    const fullscreen=!!document.documentElement.dataset.fullscreenMode;
    const rect=reasonSlot.getBoundingClientRect();
    if(!compactReason.matches) {
      $('closeProof').style.removeProperty('left');
      $('closeProof').style.removeProperty('top');
      proofPane.classList.remove('proof-close-compact');
      // Keep the sidebar height stable while the surrounding page scrolls.
      const scroll=fullscreen ? header.parentElement.scrollTop : window.scrollY;
      proofPane.style.setProperty('--proof-start',`${Math.max(0,rect.top+scroll)}px`);
      return;
    }
    const dock=$('toolDock');
    const menuClosed=$('reasonFlower').inert;
    const placement=proofLayout.positionFloatingProof({
      width:window.innerWidth,height:window.innerHeight,
      headerBottom:fullscreen?header.getBoundingClientRect().bottom:undefined,
      reasonSlot:rect,
      tools:menuClosed?dock.getBoundingClientRect():reasonMenuBounds,
      verticalDock:menuClosed && getComputedStyle(dock).flexDirection==='column'
    });
    proofPane.classList.toggle('proof-close-left',placement.closeOnLeft);
    const {left,right,top,room}=placement;
    proofPane.style.setProperty('--proof-left',`${left}px`);
    if(right===undefined) proofPane.style.removeProperty('--proof-right');
    else proofPane.style.setProperty('--proof-right',`${right}px`);
    proofPane.style.setProperty('--proof-top',`${top}px`);
    proofPane.style.setProperty('--proof-room',`${room}px`);
    positionProofClose();
  }

  function positionProofClose() {
    const button=$('closeProof');
    const heading=proofPane.querySelector('.panel-head').getBoundingClientRect();
    const title=proofPane.querySelector('h2').getBoundingClientRect();
    const expanded=!$('reasonFlower').inert;
    const obstacles=[...$('toolDock').querySelectorAll('.launcher:not([hidden])')]
      .filter(button=>!expanded || button!==$('reasonMenu')).map(button=>button.getBoundingClientRect());
    if(expanded) obstacles.push(...reasonButtons);
    function move(x,y) {
      button.style.left=`${x}px`;
      button.style.top=`${y}px`;
    }
    const findSlot=()=>proofLayout.findCloseButtonOffset({heading,title,button:button.getBoundingClientRect(),obstacles});
    move(0,0);
    proofPane.classList.remove('proof-close-compact');
    let slot=findSlot();
    if(!slot) {
      proofPane.classList.add('proof-close-compact');
      slot=findSlot();
    }
    if(slot) move(slot.x,slot.y);
    else if(expanded) collapseReasonTools();
  }

  function syncProofLayout() {
    const floating=compactReason.matches;
    const collapsed=isReasonCollapsed(), visible=isProofVisible();
    const split=phoneProof.matches && visible;
    const wasSplit=viewport.classList.contains('mobile-proof-split');
    const parent=split?header.parentElement:floating?viewport:reasonContent;
    const active=document.activeElement, focused=proofPane.contains(active);
    const moved=proofPane.parentElement!==parent;
    if(moved) parent.append(proofPane);
    proofPane.setAttribute('role',floating && !split?'dialog':'region');
    reasonStatus.inert=collapsed || (!floating && visible);
    proofPane.inert=!visible || (!floating && collapsed);
    if(split!==wasSplit) {
      if(split) {
        pageScroll=window.scrollY;
        proofPane.classList.remove('proof-close-left','proof-close-compact');
        $('closeProof').style.removeProperty('left');
        $('closeProof').style.removeProperty('top');
      }
      viewport.classList.toggle('mobile-proof-split',split);
      if(!split) window.scrollTo(0,pageScroll);
      refreshOpenRadials();
    }
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
    const root=document.documentElement;
    const originX=anchor.left+anchor.width/2, originY=anchor.top+anchor.height/2;
    const obstacles=[...dock.querySelectorAll('.launcher')].filter(item=>item!==launcher && !item.hidden).map(dockButtonRect);
    const kind=name==='reason'?'reason':name==='mark'&&!isEditing()?'ring':name==='selection'?'selection':'fan';
    const stickyHeader=kind==='reason' && root.dataset.fullscreenMode ? header.getBoundingClientRect() : null;
    if(stickyHeader) {
      for(const button of header.querySelectorAll('button:not([hidden])')) obstacles.push(button.getBoundingClientRect());
    }
    const split=viewport.classList.contains('mobile-proof-split');
    if(!proofPane.inert && (split || (kind==='reason' && !compactReason.matches))) {
      for(const button of proofPane.querySelectorAll('.panel-head button')) obstacles.push(button.getBoundingClientRect());
    }
    const positioned=radialLayout.arrange(items.map(item=>({item,width:item.offsetWidth,height:item.offsetHeight})),{
      width:root.clientWidth,height:root.clientHeight,originX,originY,obstacles,launcher:anchor,kind,header:stickyHeader
    });
    if(kind==='reason') {
      reasonMenuBounds={
        left:originX+positioned.center.x+positioned.bounds.left,
        right:originX+positioned.center.x+positioned.bounds.right,
        top:originY+positioned.center.y+positioned.bounds.top
      };
      reasonButtons=[...positioned.items,{width:anchor.width,height:anchor.height,
        screenX:positioned.center.x,screenY:positioned.center.y}].map(({width,height,screenX,screenY})=>({
        left:originX+screenX-width/2,right:originX+screenX+width/2,
        top:originY+screenY-height/2,bottom:originY+screenY+height/2
      }));
    }
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
    phoneProof.addEventListener('change',syncProofLayout);
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
    toolLayoutObserver.observe(viewport.querySelector('.setup-bar'));
    toolLayoutObserver.observe(reasonSlot);
  }
  return {layoutRadial,positionProofWindow,syncProofLayout,observe};
}
