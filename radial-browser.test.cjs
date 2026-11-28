const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {existsSync}=require('node:fs');
const {mkdtemp,readFile,rm}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const test=require('node:test');
const {setTimeout:wait}=require('node:timers/promises');
const {pathToFileURL}=require('node:url');

const chrome=process.env.CHROME_BIN||[
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser',
].find(existsSync);

async function until(check,message) {
  const deadline=Date.now()+6000;
  do {
    const result=await check();
    if(result) return result;
    await wait(25);
  } while(Date.now()<deadline);
  assert.fail(message);
}

test('提示圆弧在普通、极小和网页内全屏窗口可点击',{
  skip:chrome&&typeof WebSocket==='function'?false:'需要 Chromium 和 Node.js WebSocket',timeout:30000,
},async t=>{
  const profile=await mkdtemp(join(tmpdir(),'ezms-radial-'));
  const browser=spawn(chrome,['--headless','--no-first-run','--remote-debugging-port=0',
    `--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
  const browserStopped=new Promise(resolve=>browser.once('close',resolve));
  let socket,launchError;
  browser.once('error',error=>{launchError=error;});
  try {
    const port=await until(async()=>{
      if(launchError) throw launchError;
      return (await readFile(join(profile,'DevToolsActivePort'),'utf8').catch(()=>'')).split('\n')[0];
    },'Chromium 未启动');
    const pages=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket=new WebSocket(pages.find(page=>page.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    const pending=new Map();
    let sequence=0;
    socket.onmessage=({data})=>{
      const {id,result,error}=JSON.parse(data);
      const callbacks=pending.get(id);
      if(!callbacks) return;
      pending.delete(id);
      if(error) callbacks.reject(new Error(error.message));
      else callbacks.resolve(result);
    };
    socket.onclose=()=>{
      for(const {reject} of pending.values()) reject(new Error('Chromium 调试连接关闭'));
      pending.clear();
    };
    const send=(method,params={})=>new Promise((resolve,reject)=>{
      const id=++sequence;
      pending.set(id,{resolve,reject});
      socket.send(JSON.stringify({id,method,params}));
    });
    const page=async (expression,awaitPromise=false)=>{
      const {exceptionDetails,result}=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise});
      assert.ok(!exceptionDetails,exceptionDetails?.exception?.description);
      return result.value;
    };
    const size=(width,height)=>send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    const click=async id=>{
      const [x,y,target]=await page(`center('${id}')`);
      assert.equal(target,id,`${id} 在 ${x},${y} 被 ${target} 挡住`);
      for(const type of ['mousePressed','mouseReleased']) {
        await send('Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1});
      }
    };
    async function waitForHits(ids,label,checkArc=false) {
      // Leave time for resize observers and radial layout to run before sampling the new frame.
      await page('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',true);
      await until(()=>page(`(() => {
        const ids=${JSON.stringify(ids)};
        const locations=ids.map(center);
        if(!locations.every(([, ,hit],i)=>hit===ids[i])) return false;
        if([q('reasonFlower'),...ids.map(q)].some(el=>el.getAnimations()
          .some(animation=>['transform','translate'].includes(animation.transitionProperty)))) return false;
        if(!${checkArc}) return true;
        const [x,y]=locations[0];
        const petals=[...q('reasonFlower').querySelectorAll('.petal')];
        const radii=petals.map(petal=>{
          const [px,py]=locations[ids.indexOf(petal.id)];
          return Math.hypot(px-x,py-y);
        });
        return / A /.test(q('reasonTrack').getAttribute('d')) &&
          radii.every(radius=>Math.abs(radius-radii[0])<.5) &&
          petals.every(petal=>petal.offsetWidth>=44 && petal.scrollWidth<=petal.clientWidth);
      })()`),`${label} 圆弧未就位、标签被裁剪或按钮被遮挡`);
    }
    const loadGame=async(seed="C('JKn6a1FFf31{")=>{
      await size(960,720);
      await send('Page.navigate',{url:pathToFileURL(join(__dirname,'index.html')).href});
      await until(()=>page("document.readyState==='complete' && typeof document.getElementById('importPosition')?.onclick==='function'"),'游戏未启动');
      await page(`window.q=id=>document.getElementById(id);
        window.center=id=>{const {x,y,width,height}=q(id).getBoundingClientRect();
          const cx=x+width/2,cy=y+height/2;
          return [cx,cy,document.elementFromPoint(cx,cy)?.closest('button')?.id??null];};
        document.documentElement.requestFullscreen=()=>Promise.reject(new Error('测试网页内全屏'));
        q('importPosition').click();
        q('positionSeedText').value=${JSON.stringify(seed)};
        q('confirmImport').click()`);
      await until(()=>page("!q('seedDialog').open && !q('reasonMenu').disabled"),'测试棋局未载入');
    };
    await loadGame();
    await click('reasonMenu');
    await until(()=>page("!q('reasonFlower').inert"),'提示菜单未展开');
    const actions=['reasonMenu','focus','hint','answers','apply','solve','markMenu','selectionMenu'];
    for(const [width,height,fullscreen] of [[960,720,false],[300,220,false],[240,180,false],
      [240,190,true],[320,270,true],[500,280,true],[960,720,false]]) {
      await size(width,height);
      if(Boolean(await page('document.documentElement.dataset.fullscreenMode'))!==fullscreen) {
        await page("q('fullscreenToggle').click()");
      }
      await until(()=>page(`Boolean(document.documentElement.dataset.fullscreenMode)===${fullscreen}`),'网页内全屏状态错误');
      await waitForHits(actions,`${width}×${height} ${fullscreen?'网页内全屏':'普通窗口'}`,true);
      await click('answers');
      await until(()=>page("q('answers').getAttribute('aria-pressed')==='true' && q('board').getAttribute('aria-busy')==='false'"),'答案未打开');
      await click('answers');
      await until(()=>page("q('answers').getAttribute('aria-pressed')==='false'"),'答案未关闭');
    }
    await click('focus');
    await until(()=>page("q('focus').getAttribute('aria-pressed')==='true'"),'线索未打开');
    await click('reasonMenu');
    assert.equal(await page("q('reasonFlower').inert"),true);

    async function openFullscreen() {
      await loadGame();
      await click('fullscreenToggle');
      await until(()=>page("document.documentElement.dataset.fullscreenMode==='page'"),'网页内全屏未打开');
    }

    async function openProof() {
      await click('reasonMenu');
      await wait(380);
      await click('hint');
      await until(()=>page("!q('proofPane').inert && q('board').getAttribute('aria-busy')==='false'"),'推导未打开');
    }

    await t.test('短窗口提示展开后可以直接点击退出全屏',async()=>{
      await openFullscreen();
      await size(361,230);
      await wait(380);
      await click('reasonMenu');
      await wait(380);
      await click('fullscreenToggle');
      await until(()=>page('!document.documentElement.dataset.fullscreenMode'),'未退出网页内全屏');
    });

    await t.test('侧栏推导和提示同时展开后可以点击关闭推导',async()=>{
      await openFullscreen();
      await openProof();
      await size(800,340);
      await wait(380);
      assert.equal(await page("q('proofPane').getAttribute('role')"),'region');
      await click('closeProof');
      assert.equal(await page("q('proofPane').inert"),true);
    });

    await t.test('浮动推导和提示同时展开时缩放后可以点击收起圆弧',async()=>{
      await openFullscreen();
      await openProof();
      await size(361,230);
      await wait(380);
      await size(361,240);
      await wait(380);
      assert.equal(await page("q('proofPane').getAttribute('role')"),'dialog');
      const hits=await page(`${JSON.stringify(actions)}.map(id=>center(id)[2])`);
      assert.deepEqual(hits,actions);
      await click('reasonMenu');
      assert.equal(await page("q('reasonFlower').inert"),true);
      assert.equal(await page("q('proofPane').inert"),false);
      await click('closeProof');
      assert.equal(await page("q('proofPane').inert"),true);
    });

    await t.test('极小全屏中可以同时操作提示、推导和页头按钮',async()=>{
      await openFullscreen();
      await openProof();
      await size(240,190);
      await wait(380);
      const controls=[...actions,'fullscreenToggle','closeProof','gameMode','editMode','soundToggle','motionToggle'];
      const hits=await page(`${JSON.stringify(controls)}.map(id=>center(id)[2])`);
      assert.deepEqual(hits,controls);
      await click('closeProof');
      assert.equal(await page("q('proofPane').inert"),true);
      await click('fullscreenToggle');
      await until(()=>page('!document.documentElement.dataset.fullscreenMode'),'未退出网页内全屏');
    });
    await t.test('桌面和窄屏切换后，键盘焦点留在推导窗的关闭按钮',async()=>{
      await loadGame();
      await click('reasonMenu');
      await waitForHits(['hint'],'推导按钮');
      await click('hint');
      await until(()=>page("!!q('proof').querySelector('.proof-line')"),'推导未渲染');
      await page("q('closeProof').focus({preventScroll:true})");
      assert.equal(await page('document.activeElement.id'),'closeProof');
      for(const width of [375,960]) {
        await size(width,720);
        await until(()=>page(`q('proofPane').getAttribute('role')===${JSON.stringify(width===375?'dialog':'region')}`),'推导窗未切换布局');
        assert.equal(await page('document.activeElement.id'),'closeProof');
      }
    });

    await t.test('推导侧栏和浮窗随可用空间向下伸缩',async()=>{
      await loadGame();
      await openProof();
      await page(`(() => {
        q('reasonMenu').click();
        const content=document.createElement('div');
        content.style.height='1500px';
        q('proof').append(content);
      })()`);
      const read=()=>page(`(() => {
        const pane=q('proofPane'), body=q('proof');
        const {top,bottom,height}=pane.getBoundingClientRect();
        const oldScroll=body.scrollTop;
        body.scrollTop=14;
        const scrollable=body.scrollTop>0;
        body.scrollTop=oldScroll;
        return {top,bottom,height,scrollable};
      })()`);
      for(const fullscreen of [false,true]) {
        if(fullscreen) {
          await click('fullscreenToggle');
          await until(()=>page("document.documentElement.dataset.fullscreenMode==='page'"),'网页内全屏未打开');
        }
        for(const height of [620,860]) {
          await size(960,height);
          await until(async()=>Math.abs((await read()).bottom-(height-12))<=1,'推导侧栏未填满窗口下方可用空间');
          assert.equal((await read()).scrollable,true);
        }
      }
      await click('fullscreenToggle');
      await until(()=>page('!document.documentElement.dataset.fullscreenMode'),'网页内全屏未关闭');
      await size(390,960);
      await until(()=>page("q('proofPane').getAttribute('role')==='dialog'"),'推导浮窗未打开');
      await until(async()=>{
        const {height,bottom}=await read();
        const {room,controls}=await page(`({room:parseFloat(q('proofPane').style.getPropertyValue('--proof-room')),
          controls:q('toolDock').getBoundingClientRect().top})`);
        return height>960*.55 && Math.abs(height-room)<=1 && bottom<controls;
      },'推导浮窗没有利用工具栏上方的可用空间');
      const tall=await read();
      await size(390,600);
      await until(async()=>{
        const short=await read();
        return short.height<tall.height && short.bottom<=600-12 && short.scrollable;
      },'窗口缩短后推导浮窗没有收缩');
      await click('closeProof');
      assert.equal(await page("q('proofPane').inert"),true);
    });

    await t.test('推导请求发送失败或无法读取返回值时，棋盘解锁并可重试',async()=>{
      await loadGame();
      await click('reasonMenu');
      await page(`window.sendWorkerMessage=Worker.prototype.postMessage;
        Worker.prototype.postMessage=function(data,...rest) {
          if(data.kind==='hint' && window.hintFault) {
            const fault=window.hintFault;
            window.hintFault=undefined;
            if(fault==='send') throw new DOMException('模拟无法发送','DataCloneError');
            setTimeout(()=>this.dispatchEvent(new MessageEvent('messageerror')),0);
            return;
          }
          return window.sendWorkerMessage.call(this,data,...rest);
        };`);
      for(const fault of ['send','receive']) {
        await page(`window.hintFault=${JSON.stringify(fault)};q('hint').click()`);
        await until(()=>page("q('board').getAttribute('aria-busy')==='false' && q('proof').textContent.includes('计算失败')"),`提示失败后未解锁 ${fault}`);
        await page("q('hint').click();q('hint').click()");
        await until(()=>page("!!q('proof').querySelector('.proof-line')"),'重试未渲染推导');
        await page("q('hint').click()");
      }
    });
    await t.test('停止正在计算的自动求解时解锁一次并忽略迟到的提示',async()=>{
      await loadGame();
      await click('reasonMenu');
      assert.deepEqual(await page(`(() => {
        const sendWorkerMessage=Worker.prototype.postMessage;
        let request;
        Worker.prototype.postMessage=function(data,...args) {
          if(data.kind==='hint') {request=this;return;}
          return sendWorkerMessage.call(this,data,...args);
        };
        try {
          q('solve').click();
          const started=!!request && q('board').getAttribute('aria-busy')==='true';
          const observer=new MutationObserver(()=>{});
          observer.observe(q('reasonMenu'),{childList:true});
          q('solve').click();
          request?.onmessage({data:{status:'error'}});
          const redraws=observer.takeRecords().length;
          observer.disconnect();
          return {started,redraws,busy:q('board').getAttribute('aria-busy'),label:q('solve').textContent};
        } finally {
          Worker.prototype.postMessage=sendWorkerMessage;
        }
      })()`),{started:true,redraws:1,busy:'false',label:'自动求解'});
    });

    await t.test('总雷数高亮留出文字边距且页头不抖动',async()=>{
      await loadGame('J:eVyiz!}');
      const geometry=`JSON.stringify(['totalMines','board','restart'].map(id=>{
        const {offsetLeft,offsetTop,offsetWidth,offsetHeight}=q(id);
        return [offsetLeft,offsetTop,offsetWidth,offsetHeight];
      }))`;
      const before=await page(geometry);
      await click('reasonMenu');
      await page("q('focus').click()");
      await until(()=>page("q('totalMines').classList.contains('clue-total')"),'总雷数未高亮');
      const paddedFrame=`(() => {
        const total=q('totalMines');
        const frame=getComputedStyle(total,'::before');
        const prefix=document.createRange();
        prefix.selectNode(q('size').firstChild);
        const frameLeft=total.getBoundingClientRect().left+parseFloat(frame.left);
        return frame.content!=='none' && frameLeft>=prefix.getBoundingClientRect().right-.5 &&
          ['top','right','bottom','left'].every(side=>
            -parseFloat(frame[side])-parseFloat(frame.getPropertyValue('border-'+side+'-width'))>=2);
      })()`;
      assert.equal(await page(paddedFrame),true,'高亮边框压在文字边缘');
      assert.equal(await page(geometry),before);
      await page("q('hint').click()");
      await until(()=>page("[...q('proof').querySelectorAll('.proof-cell')].some(el=>el.textContent==='全盘')"),'缺少全盘线索公式');
      await page(`([...q('proof').querySelectorAll('.proof-cell')].find(el=>el.textContent==='全盘'))
        .dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}))`);
      assert.equal(await page("q('totalMines').classList.contains('proof-hover')"),true);
      assert.equal(await page(paddedFrame),true,'悬停边框压在文字边缘');
      assert.equal(await page(geometry),before);
    });

    await t.test('点击棋盘坐标按矩形增加或减去选区',async()=>{
      await loadGame();
      await page(`window.axis=name=>q('board').querySelector('button.axis[aria-label="'+name+'"]');
        window.areas=[];
        const post=Worker.prototype.postMessage;
        Worker.prototype.postMessage=function(data,...args) {
          if(data.p && data.weights instanceof Map) areas.push([...data.weights].sort((a,b)=>a[0]-b[0]));
          return post.call(this,data,...args);
        };`);
      const corner='选择全盘', row='选择第 1 行', column='选择 B 列';
      const names=[corner,row,column];
      assert.equal(await page(`${JSON.stringify(names)}.every(name=>axis(name)?.disabled)`),true);
      const cellGeometry=`JSON.stringify([...q('board').querySelectorAll('[data-cell]')].map(el=>
        [el.offsetLeft,el.offsetTop,el.offsetWidth,el.offsetHeight]))`;
      const before=await page(cellGeometry);
      await page("q('selectionMenu').click();q('selectionAdd').click()");
      assert.equal(await page(cellGeometry),before);
      const clickAxis=async name=>{
        const [x,y,hit]=await page(`(() => {
          const el=axis(${JSON.stringify(name)}), {x,y,width,height}=el.getBoundingClientRect();
          const cx=x+width/2,cy=y+height/2;
          return [cx,cy,document.elementFromPoint(cx,cy)?.closest('button')===el && !el.disabled];
        })()`);
        assert.equal(hit,true,`${name}不可点击`);
        for(const type of ['mousePressed','mouseReleased']) {
          await send('Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1});
        }
      };
      await clickAxis(row);
      assert.deepEqual(await page('areas.at(-1)'),[[1,1],[2,1],[3,1],[4,1]]);
      await until(()=>page("q('selectionTerms').textContent==='A1:E1'"),'整行没有按首尾坐标显示');
      await page("q('selectionUndo').click()");
      assert.equal(await page("q('selectionReadout').hidden"),true);
      await page("q('selectionRedo').click();q('selectionSubtract').click()");
      await clickAxis(column);
      assert.deepEqual(await page('areas.at(-1)'),[[2,1],[3,1],[4,1],[11,-1],[16,-1],[21,-1]]);
      await page("q('selectionUndo').click();q('selectionUndo').click();q('selectionAdd').click()");
      await size(375,720);
      await page('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',true);
      const alignment=await page(`(() => {
        const mid=el=>{const {x,y,width,height}=el.getBoundingClientRect();return [x+width/2,y+height/2];};
        const [corner,row,column]=${JSON.stringify(names)}.map(name=>mid(axis(name)));
        const first=mid(q('board').querySelector('[data-cell="0"]'));
        const second=mid(q('board').querySelector('[data-cell="1"]'));
        return [corner[0]-row[0],corner[1]-column[1],first[1]-row[1],second[0]-column[0]];
      })()`);
      assert.ok(alignment.every(delta=>Math.abs(delta)<.5),`坐标轴未对齐：${alignment}`);
      await clickAxis(corner);
      const covered=[1,2,3,4,5,8,9,11,13,15,16,17,18,20,21,23,24];
      assert.deepEqual(await page('areas.at(-1)'),covered.map(cell=>[cell,1]));
      await until(()=>page("q('selectionBounds').textContent==='6'"),'全盘雷数未正确显示');
      await until(()=>page("q('selectionTerms').textContent==='A1:E5'"),'全盘没有合并为一个矩形');
      await page("q('selectionUndo').click()");
      await clickAxis('选择 C 列');
      await until(()=>page("q('selectionTerms').textContent==='C1:C5'"),'整列没有按首尾坐标显示');
      await page("q('selectionAdd').click();q('editMode').click()");
      assert.equal(await page(`${JSON.stringify(names)}.every(name=>axis(name)?.disabled)`),true);
    });

    await t.test('编辑器可新建和编辑局面，回到游戏时恢复原棋盘',async()=>{
      await loadGame();
      const snapshot=()=>page(`({size:q('size').textContent,cells:[...q('board').querySelectorAll('[data-cell]')]
        .map(node=>node.getAttribute('aria-label'))})`);
      const playing=await snapshot();
      await click('editMode');
      await page(`q('editWidth').value=4;q('editHeight').value=3;q('blankPosition').click()`);
      await until(()=>page("q('board').querySelectorAll('[data-cell]').length===12"),'编辑器未新建棋盘');
      await page(`q('board').querySelector('[data-cell="0"]').click()`);
      assert.equal(await page("q('totalMines').textContent"),'1 雷');
      assert.equal(await page(`q('board').querySelector('[data-cell="0"]').classList.contains('edit-mine')`),true);
      await page(`q('mineTools').querySelector('[data-edit="open"]').click();q('board').querySelector('[data-cell="1"]').click()`);
      assert.equal(await page(`q('board').querySelector('[data-cell="1"]').textContent`),'1');
      await page(`q('editTools').querySelector('[data-draft="numbers"]').click()`);
      assert.equal(await page("q('numberTools').hidden"),false);
      await page(`q('draftMines').value=2;q('draftMines').dispatchEvent(new Event('input'))`);
      assert.equal(await page("q('totalMines').textContent"),'2 雷');
      await click('gameMode');
      assert.deepEqual(await snapshot(),playing);
    });

    await t.test('超矮全屏中提示圆弧和关闭推导可点击',async()=>{
      await loadGame();
      await click('fullscreenToggle');
      await until(()=>page('!!document.documentElement.dataset.fullscreenMode'),'未进入网页内全屏');
      await click('reasonMenu');
      await until(()=>page("center('hint')[2]==='hint'"),'推导按钮未展开');
      await click('hint');
      await until(()=>page("!!q('proof').querySelector('.proof-line')"),'推导未渲染');
      const controls=[...actions,'closeProof','fullscreenToggle'];
      for(const [width,height] of [[240,150],[200,180]]) {
        await size(width,height);
        await waitForHits(controls,`${width}×${height} 网页内全屏`);
      }
      await size(320,120);
      await waitForHits(['closeProof','fullscreenToggle'],'320×120 网页内全屏');
      const scrollPoint=await page(`(() => {
        const body=q('proof'), {left,right,top,height}=body.getBoundingClientRect();
        if(body.clientHeight<16) return null;
        const y=top+height/2;
        for(let x=left+4;x<right;x+=4) {
          if(body.contains(document.elementFromPoint(x,y))) return {x,y};
        }
        return null;
      })()`);
      assert.ok(scrollPoint,'超矮全屏的推导正文被裁掉或遮挡');
      await send('Input.dispatchMouseEvent',{type:'mouseWheel',...scrollPoint,deltaX:0,deltaY:60});
      await until(()=>page("q('proof').scrollTop>0"),'超矮全屏的推导正文无法滚动');
      const closeArea=()=>page(`(() => {
        const button=q('closeProof'), rect=button.getBoundingClientRect();
        const misses=[];
        for(let dy=4;dy<rect.height-3;dy+=4) for(let dx=4;dx<rect.width-3;dx+=4) {
          const x=rect.left+dx,y=rect.top+dy;
          const hit=document.elementFromPoint(x,y)?.closest('button');
          if(hit!==button) misses.push({x,y,hit:hit?.id});
        }
        return misses;
      })()`);
      await size(320,140);
      await waitForHits(['closeProof','fullscreenToggle'],'320×140 网页内全屏');
      const shorter=await page("q('proof').clientHeight");
      const covered=await closeArea();
      await size(320,141);
      await waitForHits(['closeProof','fullscreenToggle'],'320×141 网页内全屏');
      const taller=await page("q('proof').clientHeight");
      assert.ok(taller>=shorter,`窗口增高后推导正文由 ${shorter}px 缩到 ${taller}px`);
      assert.deepEqual(covered,[],'320×140 的关闭按钮与提示圆弧重叠');
      assert.deepEqual(await closeArea(),[],'320×141 的关闭按钮与提示圆弧重叠');
      await size(320,140);
      await waitForHits(['closeProof','fullscreenToggle'],'缩回 320×140 网页内全屏');
      const before=await page("q('roundProgress').value");
      const corner=await page(`(() => {
        const {left,top}=q('closeProof').getBoundingClientRect();
        return {x:left+5,y:top+5};
      })()`);
      for(const type of ['mousePressed','mouseReleased']) {
        await send('Input.dispatchMouseEvent',{type,...corner,button:'left',clickCount:1});
      }
      assert.equal(await page("q('roundProgress').value"),before);
      assert.equal(await page("q('proofPane').inert"),true);
      await click('fullscreenToggle');
      await until(()=>page('!document.documentElement.dataset.fullscreenMode'),'未退出网页内全屏');
    });
    await t.test('收起圆弧后增高狭窄全屏不会缩短推导正文',async()=>{
      await openFullscreen();
      await openProof();
      await click('reasonMenu');
      assert.equal(await page("q('reasonFlower').inert"),true);
      let previous=0;
      for(const height of [180,181,219,220,240,241,300,301]) {
        await size(220,height);
        await waitForHits(['closeProof','fullscreenToggle'],`220×${height} 网页内全屏`);
        const current=await page("q('proof').clientHeight");
        assert.ok(current>=previous,`窗口增高到 ${height}px 时，推导正文由 ${previous}px 缩到 ${current}px`);
        previous=current;
      }
    });
    await t.test('狭窄全屏可关闭推导且不触发求解',async()=>{
      for(const {width,height,motion,expanded} of [
        {width:220,height:190,motion:false,expanded:true},
        {width:200,height:150,motion:true,expanded:false},
      ]) {
        await openFullscreen();
        await openProof();
        await page(`if(q('motionToggle').getAttribute('aria-pressed')!==String(${motion})) q('motionToggle').click()`);
        await size(width,height);
        await page('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',true);
        assert.equal(await page("!q('reasonFlower').inert"),expanded);
        const before=await page("q('roundProgress').value");
        await click('closeProof');
        assert.equal(await page("q('proofPane').inert"),true);
        assert.equal(await page("q('roundProgress').value"),before);
        if(!expanded) await click('reasonMenu');
        await waitForHits(actions,`${width}×${height} 关闭推导后提示圆弧可用`);
      }
    });
  } finally {
    socket?.close();
    browser.kill();
    await browserStopped;
    await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
