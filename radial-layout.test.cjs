const test=require('node:test');
const assert=require('node:assert/strict');
const makeRadialLayout=require('./radial-layout');

const layout=makeRadialLayout();

test('arc paths start at the launcher and connect petals in screen order',()=>{
  const origin={x:0,y:5};
  const petals=[{x:10,y:0},{x:0,y:-10},{x:-10,y:0}];
  const ordered=layout.orderAlongArc(petals,origin);
  assert.deepEqual(ordered,[petals[2],petals[1],petals[0]]);
  const path=layout.pathThrough(ordered,origin);
  assert.match(path,/^M 0 5 C /);
  assert.match(path,/ -10 0 C /);
  assert.match(path,/ 0 -10 C /);
  assert.match(path,/ 10 0$/);
});

test('arc ordering follows the angle around the launcher, not DOM order',()=>{
  const origin={x:0,y:0};
  const points=[{x:-1,y:10},{x:-10,y:-1},{x:-8,y:6}];
  assert.deepEqual(layout.orderAlongArc(points,origin),[points[0],points[2],points[1]]);
});

test('arc ordering stays continuous across the atan2 branch cut',()=>{
  const origin={x:0,y:0};
  const points=[{id:'upper-inner',x:-.259,y:-.966},{id:'upper-outer',x:-.676,y:-.737},
    {id:'lower-outer',x:-.94,y:-.342},{id:'lower-inner',x:-.819,y:.574}];
  assert.deepEqual(layout.orderAlongArc(points,origin).map(point=>point.id),
    ['lower-inner','lower-outer','upper-outer','upper-inner']);
});

test('reasoning track is an upper ellipse passing through the button centers',()=>{
  const points=[{x:-137,y:69},{x:-97,y:-28},{x:0,y:-69},{x:97,y:-28},{x:137,y:69}];
  const path=layout.semicirclePath(points);
  assert.match(path,/^M -137 69 A 137 138 0 0 1 137 69$/);
  assert.doesNotMatch(path,/[CQ]/);
  for(const point of points) {
    const normalizedX=point.x/137;
    const normalizedY=(point.y-69)/138;
    assert.ok(Math.abs(normalizedX**2+normalizedY**2-1)<0.02,
      `button center ${point.x},${point.y} should sit on the track`);
  }
});

test('reasoning menu keeps all five actions on one upper semicircle',()=>{
  const items=['focus','hint','answers','apply','solve'].map(id=>({id,width:88,height:52}));
  const result=layout.arrange(items,{width:830,height:710,originX:780,originY:660,
    launcher:{width:48,height:48},kind:'reason'});
  const byId=Object.fromEntries(result.items.map(item=>[item.id,item]));
  assert.ok(byId.focus.x<byId.hint.x && byId.hint.x<byId.answers.x && byId.answers.x<byId.apply.x && byId.apply.x<byId.solve.x);
  assert.ok(byId.hint.y<byId.focus.y && byId.answers.y<byId.focus.y && byId.apply.y<byId.solve.y);
  assert.ok(byId.answers.x>byId.focus.x && byId.answers.x<byId.apply.x);
  assert.ok(byId.answers.y<byId.focus.y && byId.answers.y<byId.apply.y);
  assert.ok(Math.abs(byId.hint.x+byId.apply.x)<1e-8);
  assert.ok(Math.abs(byId.focus.x+byId.solve.x)<1e-8);
});

test('fan coordinates are calculated symmetrically around its arc center',()=>{
  const points=layout.fan(5,80,-175,-5);
  assert.equal(points.length,5);
  assert.ok(Math.abs(points[0].x+points.at(-1).x)<1e-9);
  assert.ok(Math.abs(points[0].y-points.at(-1).y)<1e-9);
  assert.ok(points[2].y<points[0].y);
});

test('fan radius grows with the button diameter and spacing requirement',()=>{
  assert.ok(layout.radiusFor(5,66,90)>layout.radiusFor(5,44,90));
  assert.ok(layout.radiusFor(2,66,90)>=78);
});

test('launcher destination is the center of the surrounding buttons, not their origin',()=>{
  const points=[{x:-60,y:-40},{x:40,y:-20}],sizes=[{width:60,height:40},{width:40,height:60}];
  assert.deepEqual(layout.center(points,sizes),{x:-15,y:-25});
  const result=layout.arrange(points.map((point,index)=>({...point,...sizes[index]})),
    {width:400,height:300,originX:360,originY:260,launcher:{width:48,height:48}});
  const bounds=result.items.reduce((box,item)=>({
    left:Math.min(box.left,item.x-item.width/2),right:Math.max(box.right,item.x+item.width/2),
    top:Math.min(box.top,item.y-item.height/2),bottom:Math.max(box.bottom,item.y+item.height/2),
  }),{left:Infinity,right:-Infinity,top:Infinity,bottom:-Infinity});
  assert.ok(Math.abs((bounds.left+bounds.right)/2)<1e-8);
  assert.ok(Math.abs((bounds.top+bounds.bottom)/2)<1e-8);
  assert.ok(result.center.y<260);
});

test('layout keeps a long fan inside a narrow viewport beside a corner launcher',()=>{
  const items=Array.from({length:5},()=>({width:88,height:52}));
  const result=layout.arrange(items,{width:390,height:640,originX:358,originY:602});
  for(const [index,item] of result.items.entries()) {
    const x=358+result.center.x+item.x,y=602+result.center.y+item.y;
    assert.ok(x-items[index].width/2>=20);
    assert.ok(x+items[index].width/2<=370);
    assert.ok(y-items[index].height/2>=20);
    assert.ok(y+items[index].height/2<=620);
  }
});

test('paired menu positions form two separated arcs inside the viewport',()=>{
  const items=Array.from({length:10},()=>({width:44,height:44}));
  const result=layout.arrange(items,{width:390,height:720,originX:365,originY:685,kind:'paired'});
  assert.ok(result.center.x<0);
  assert.ok(result.center.y<0);
  for(const [index,item] of result.items.entries()) {
    const x=365+result.center.x+item.x,y=685+result.center.y+item.y;
    assert.ok(x-items[index].width/2>=20);
    assert.ok(x+items[index].width/2<=370);
    assert.ok(y-items[index].height/2>=20);
    assert.ok(y+items[index].height/2<=700);
  }
  for(let a=0;a<result.items.length;a++) for(let b=a+1;b<result.items.length;b++) {
    const left=result.items[a],right=result.items[b];
    assert.ok(Math.abs(left.x-right.x)>=(items[a].width+items[b].width)/2 ||
      Math.abs(left.y-right.y)>=(items[a].height+items[b].height)/2,
      `buttons ${a} and ${b} overlap`);
  }
  const left=result.items.slice(0,5),right=result.items.slice(5);
  assert.ok(left[2].x<left[0].x && left[2].x<left[4].x,'left fan should bow outward');
  assert.ok(right[2].x>right[0].x && right[2].x>right[4].x,'right fan should mirror the left fan');
  assert.ok(left[0].y<left[4].y,'each fan should rise and descend along an arc');
});

test('paired layout stays curved and collision-free for oversized buttons in a narrow viewport',()=>{
  const items=Array.from({length:10},()=>({width:88,height:52}));
  const result=layout.arrange(items,{width:390,height:720,originX:365,originY:685,
    kind:'paired',launcher:{width:48,height:48}});
  for(const [index,item] of result.items.entries()) {
    const x=365+result.center.x+item.x,y=685+result.center.y+item.y;
    assert.ok(x-items[index].width/2>=20 && x+items[index].width/2<=370);
    assert.ok(y-items[index].height/2>=20 && y+items[index].height/2<=700);
  }
  assert.ok(Math.abs(result.items[0].x-result.items[2].x)>1,'petal positions must remain on a curve');
  for(let a=0;a<items.length;a++) for(let b=a+1;b<items.length;b++) {
    assert.ok(Math.abs(result.items[a].x-result.items[b].x)>=(items[a].width+items[b].width)/2 ||
      Math.abs(result.items[a].y-result.items[b].y)>=(items[a].height+items[b].height)/2,
      `buttons ${a} and ${b} overlap`);
  }
});

test('paired arcs prevent collisions with uneven button sizes',()=>{
  for(const count of [5,8,10]) {
    const items=Array.from({length:count},(_,i)=>({width:i%3?44:68,height:i%2?48:42}));
    const result=layout.arrange(items,{width:430,height:780,originX:400,originY:740,kind:'paired'});
    for(let a=0;a<count;a++) for(let b=a+1;b<count;b++) {
      const x=Math.abs(result.items[a].x-result.items[b].x),y=Math.abs(result.items[a].y-result.items[b].y);
      assert.ok(x>=(items[a].width+items[b].width)/2 || y>=(items[a].height+items[b].height)/2,
        `buttons ${a} and ${b} overlap at count ${count}`);
    }
  }
});

test('paired mobile menu clears neighboring dock launchers and keeps both arcs',()=>{
  const items=Array.from({length:10},()=>({width:44,height:44}));
  const obstacles=[
    {left:269,top:781,right:317,bottom:829},
    {left:326,top:781,right:374,bottom:829},
  ];
  const result=layout.arrange(items,{width:390,height:844,originX:236,originY:805,
    kind:'paired',launcher:{width:48,height:48},obstacles});
  for(const [index,item] of result.items.entries()) {
    const left=236+result.center.x+item.x-items[index].width/2,right=236+result.center.x+item.x+items[index].width/2;
    const top=805+result.center.y+item.y-items[index].height/2,bottom=805+result.center.y+item.y+items[index].height/2;
    assert.ok(left>=20 && right<=370 && top>=20 && bottom<=824,'petals stay in the viewport');
    for(const obstacle of obstacles)
      assert.ok(right<=obstacle.left-14 || left>=obstacle.right+14 || bottom<=obstacle.top-14 || top>=obstacle.bottom+14,
        `petal ${index} overlaps a neighboring launcher`);
  }
  const leftArc=result.items.slice(0,5),rightArc=result.items.slice(5);
  assert.ok(leftArc[2].x<leftArc[0].x && leftArc[2].x<leftArc[4].x,'left arc remains bowed outward');
  assert.ok(rightArc[2].x>rightArc[0].x && rightArc[2].x>rightArc[4].x,'right arc remains bowed outward');
});


test('expanded children never cover the translated launcher',()=>{
  for(const config of [
    {count:10,kind:'paired',width:390,height:720,originX:365,originY:685,size:44,launcher:{width:48,height:48}},
    {count:2,kind:'fan',width:390,height:640,originX:358,originY:602,size:52,launcher:{width:48,height:48}},
  ]) {
    const items=Array.from({length:config.count},()=>({width:config.size,height:config.size}));
    const result=layout.arrange(items,{...config});
    for(const [index,item] of result.items.entries()) {
      assert.ok(Math.abs(item.x)>=(items[index].width+config.launcher.width)/2 ||
        Math.abs(item.y)>=(items[index].height+config.launcher.height)/2,
        `button ${index} covers launcher`);
    }
  }
});

test('two-button selection fan moves inward clear of neighboring dock launchers',()=>{
  const items=Array.from({length:2},()=>({width:52,height:52}));
  const origin={x:1328,y:914},neighbors=[{x:1271,y:921},{x:1385,y:921}];
  const result=layout.arrange(items,{width:1440,height:960,originX:origin.x,originY:origin.y,
    launcher:{width:48,height:48}});
  assert.ok(result.center.y<0,'launcher should rise into the viewport');
  for(const item of result.items) {
    const point={x:origin.x+result.center.x+item.x,y:origin.y+result.center.y+item.y};
    assert.ok(point.y<origin.y-48,'petals should clear the bottom dock row');
    for(const neighbor of neighbors) {
      const separated=Math.abs(point.x-neighbor.x)>=50 || Math.abs(point.y-neighbor.y)>=50;
      assert.ok(separated,`petal at ${point.x},${point.y} overlaps dock neighbor`);
    }
  }
});

test('viewport-sized layout stays aligned across browser zoom CSS viewport sizes',()=>{
  for(const viewport of [
    {width:1440,height:900,originX:1388,originY:848},
    {width:1280,height:780,originX:1228,originY:728},
    {width:960,height:650,originX:908,originY:598},
    {width:720,height:540,originX:668,originY:488},
  ]) {
    const items=Array.from({length:5},()=>({width:52,height:52}));
    const result=layout.arrange(items,{...viewport,launcher:{width:48,height:48}});
    for(const [index,item] of result.items.entries()) {
      const x=viewport.originX+result.center.x+item.x;
      const y=viewport.originY+result.center.y+item.y;
      assert.ok(x-items[index].width/2>=20 && x+items[index].width/2<=viewport.width-20);
      assert.ok(y-items[index].height/2>=20 && y+items[index].height/2<=viewport.height-20);
      assert.ok(Math.abs(item.x)>=(items[index].width+48)/2 || Math.abs(item.y)>=(items[index].height+48)/2,
        'expanded tool stays clear of the launcher');
    }
  }
});

test('tall viewport keeps the translated launcher and neighboring dock launchers separated',()=>{
  const gap=14;
  const viewport={width:1280,height:1170,originX:1220,originY:1128};
  const items=Array.from({length:10},()=>({width:44,height:44}));
  const obstacles=[
    {left:1144,top:1107,right:1192,bottom:1155},
    {left:1004,top:1107,right:1052,bottom:1155},
  ];
  const launcher={width:48,height:48};
  const result=layout.arrange(items,{...viewport,kind:'paired',launcher,obstacles});
  const rect=(x,y,size)=>({left:x-size.width/2,right:x+size.width/2,
    top:y-size.height/2,bottom:y+size.height/2});
  const placed=[rect(viewport.originX+result.center.x,viewport.originY+result.center.y,launcher),
    ...result.items.map((item,index)=>rect(viewport.originX+result.center.x+item.x,
      viewport.originY+result.center.y+item.y,items[index]))];
  for(const button of placed) for(const obstacle of obstacles) {
    assert.ok(button.right<=obstacle.left-gap || button.left>=obstacle.right+gap ||
      button.bottom<=obstacle.top-gap || button.top>=obstacle.bottom+gap,
      'button is too close to a dock launcher');
  }
  for(const button of placed) {
    assert.ok(button.left>=20 && button.right<=viewport.width-20,
      'translated menu stays inside horizontal viewport padding');
    assert.ok(button.top>=20 && button.bottom<=viewport.height-20,
      'translated menu stays inside vertical viewport padding');
  }
});

test('reasoning petals fit a 320px viewport while preserving their order',()=>{
  const items=Array.from({length:5},()=>({width:52,height:52}));
  const originX=280, originY=640, width=320;
  const result=layout.arrange(items,{width,height:710,kind:'reason',originX,originY,
    launcher:{width:48,height:48}});
  assert.ok(result.items.every(({screenX})=>originX+screenX-26>=19.99 && originX+screenX+26<=width-19.99));
  assert.ok(result.items.every(({x},i)=>i===0||x>result.items[i-1].x));
});

test('blue marker petals share a circular arc centered on their launcher',()=>{
  const size=44;
  const items=Array.from({length:10},()=>({width:size,height:size}));
  const originX=180, originY=660;
  const result=layout.arrange(items,{width:320,height:710,originX,originY,kind:'ring',launcher:{width:48,height:48}});
  const radius=Math.hypot(result.items[0].x,result.items[0].y);
  for(const [i,point] of result.items.entries()) {
    assert.ok(Math.abs(Math.hypot(point.x,point.y)-radius)<1e-7);
    assert.ok(Math.abs(point.screenX-result.center.x-point.x)<1e-7);
    assert.ok(Math.abs(point.screenY-result.center.y-point.y)<1e-7);
    assert.ok(originX+point.screenX-size/2>=19.99 && originX+point.screenX+size/2<=300.01);
    assert.ok(result.items.slice(0,i).every(other=>Math.hypot(point.x-other.x,point.y-other.y)>=size+10));
  }
  assert.match(layout.ringArcPath(result.items),/^M .* A [\d.]+ [\d.]+ 0 1 1 /);
});

test('all four selection controls sit on one short arc around the launcher',()=>{
  const items=Array.from({length:4},(_,id)=>({id,width:50,height:50}));
  const {items:petals,center}=layout.arrange(items,{
    kind:'selection',width:320,height:640,originX:260,originY:605,launcher:{width:52,height:52}
  });
  const radii=petals.map(({x,y})=>Math.hypot(x,y));
  assert.ok(petals.every(({y})=>y<0));
  assert.ok(radii.every(radius=>Math.abs(radius-radii[0])<1e-9));
  assert.ok(radii[0]>51);
  for(const {x,y,screenX,screenY} of petals) {
    assert.ok(260+screenX-25>0 && 260+screenX+25<320);
    assert.ok(605+screenY-25>0 && 605+screenY+25<640);
    assert.ok(Math.abs(screenX-x-center.x)<1e-9 && Math.abs(screenY-y-center.y)<1e-9);
  }
  assert.match(layout.ringArcPath(petals),/^M .+ A [\d.]+ [\d.]+ 0 0 1 [\d.]+ -[\d.]+$/);
});
