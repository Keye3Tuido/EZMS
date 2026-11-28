const assert=require('node:assert/strict');
const test=require('node:test');
const {positionFloatingProof,findCloseButtonOffset}=require('./proof-layout');

const rect=(left,top,width,height)=>({left,top,right:left+width,bottom:top+height,width,height});

test('竖排工具栏旁的推导浮窗使用下方空间',()=>{
  const layout=height=>positionFloatingProof({width:220,height,headerBottom:39,
    reasonSlot:rect(12,544,196,299),tools:rect(8,height-82,36,77),verticalDock:true});
  assert.deepEqual(layout(180),{left:54,right:undefined,top:47,room:121,closeOnLeft:false});
  assert.equal(layout(181).room,122);
  assert.equal(layout(220).room,161);
});

test('圆弧两侧都放不下浮窗时保留标题和可滚动正文的空间',()=>{
  const placement=positionFloatingProof({width:220,height:190,headerBottom:54,
    reasonSlot:rect(12,544,196,299),tools:rect(8,98,202,75),verticalDock:false});
  assert.deepEqual(placement,{left:12,right:undefined,top:62,room:79,closeOnLeft:true});
});

test('关闭按钮保留无冲突的位置，遇到圆形按钮时在标题栏里寻找位置',()=>{
  const heading=rect(0,0,180,50), title=rect(10,15,46,20), button=rect(130,11,28,28);
  assert.deepEqual(findCloseButtonOffset({heading,title,button,obstacles:[]}),{x:0,y:0});
  assert.deepEqual(findCloseButtonOffset({heading,title,button,obstacles:[rect(125,4,42,42)]}),{x:-35,y:0});
});

test('整个标题栏都无法避开圆形按钮时报告没有空位',()=>{
  const heading=rect(0,0,100,36), title=rect(8,10,52,16), button=rect(64,4,28,28);
  assert.equal(findCloseButtonOffset({heading,title,button,obstacles:[rect(60,-4,44,44)]}),undefined);
});
