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
    const page=async expression=>{
      const {exceptionDetails,result}=await send('Runtime.evaluate',{expression,returnByValue:true});
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
    const loadGame=async()=>{
      await size(960,720);
      await send('Page.navigate',{url:pathToFileURL(join(__dirname,'index.html')).href});
      await until(()=>page("document.readyState==='complete' && typeof document.getElementById('importPosition')?.onclick==='function'"),'游戏未启动');
      await page(`window.q=id=>document.getElementById(id);
        window.center=id=>{const {x,y,width,height}=q(id).getBoundingClientRect();
          const cx=x+width/2,cy=y+height/2;
          return [cx,cy,document.elementFromPoint(cx,cy)?.closest('button')?.id??null];};
        document.documentElement.requestFullscreen=()=>Promise.reject(new Error('测试网页内全屏'));
        q('importPosition').click();
        q('positionSeedText').value="C('JKn6a1FFf31{";
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
      await wait(380);
      const hits=await page(`${JSON.stringify(actions)}.map(id=>center(id)[2])`);
      assert.deepEqual(hits,actions,`${width}×${height} ${fullscreen?'网页内全屏':'普通窗口'}`);
      assert.ok(await page(`/ A /.test(q('reasonTrack').getAttribute('d'))`));
      assert.ok(await page(`(() => {
        const [x,y]=center('reasonMenu');
        const petals=[...q('reasonFlower').querySelectorAll('.petal')];
        const radii=petals.map(petal=>{
          const [px,py]=center(petal.id);
          return Math.hypot(px-x,py-y);
        });
        return radii.every(radius=>Math.abs(radius-radii[0])<.5) &&
          petals.every(petal=>petal.offsetWidth>=44 && petal.scrollWidth<=petal.clientWidth);
      })()`),'圆弧同心且标签能完整显示');
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
  } finally {
    socket?.close();
    browser.kill();
    await browserStopped;
    await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
