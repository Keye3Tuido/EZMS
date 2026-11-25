function makePositionSeeds(adj) {
  const prefix='MS1.';
  const symbols=[['x','s'],['x','s','o','/','v','\u028c','e','//']];
  const sizeOk=n=>Number.isInteger(n) && n>=2 && n<=24;
  const fail=()=>{throw Error('局面种子无效或已损坏。');};

  function unpack([w,h,cells,...inks]) {
    if(!sizeOk(w) || !sizeOk(h) || typeof cells!=='string' || cells.length!==w*h || !/^[01245]+$/.test(cells)) fail();
    const n=w*h, ns=adj(w,h), bits=Array.from(cells,Number);
    const bombs=bits.map(b=>!!(b&1)), mines=bombs.filter(Boolean).length;
    const opening=bits.flatMap((b,i)=>b&2?[i]:[]), flags=bits.flatMap((b,i)=>b&4?[i]:[]);
    const clues=ns.map(row=>row.reduce((sum,i)=>sum+Number(bombs[i]),0));
    const notes=inks.map((entries,color)=>{
      if(!Array.isArray(entries) || entries.length>n) fail();
      const seen=new Set();
      return entries.map(entry=>{
        if(!Array.isArray(entry) || entry.length!==3) fail();
        const [i,s,level]=entry;
        const validLevel=color===1 && s>=4 ? Number.isInteger(level) && level>=2 && level<=99 : level===0;
        if(!Number.isInteger(i) || i<0 || i>=n || seen.has(i) || !Number.isInteger(s) || !symbols[color][s] || !validLevel) fail();
        seen.add(i);
        return [i,{symbol:symbols[color][s],level}];
      });
    });
    return {board:{w,h,ns,bombs,mines,clues,opening,first:opening[0]??0,seed:0},
      visible:bits.map((b,i)=>b&2?clues[i]:-1),flags,notes};
  }

  function pack({board,visible,flags,notes}) {
    return [board.w,board.h,board.bombs.map((mine,i)=>Number(mine)+2*Number(visible[i]>=0)+4*Number(flags.has(i))).join(''),
      ...['red','blue'].map((color,c)=>[...(notes?.layers[color]??[])].sort(([a],[b])=>a-b)
        .map(([i,m])=>[i,symbols[c].indexOf(m.symbol),m.level]))];
  }

  function numbers(w,h,mines=0,digits='.'.repeat(w*h),flagCells=[],inks=[[],[]]) {
    if(!sizeOk(w) || !sizeOk(h) || !Number.isInteger(mines) || mines<0 || mines>w*h ||
      typeof digits!=='string' || digits.length!==w*h || !/^[.0-8]+$/.test(digits) || !Array.isArray(flagCells)) fail();
    const visible=Array.from(digits,c=>c==='.'?-1:Number(c));
    const bits=Array(w*h).fill('0');
    for(const i of flagCells) {
      if(!Number.isInteger(i) || visible[i]!==-1 || bits[i]!=='0') fail();
      bits[i]='4';
    }
    const {board,flags,notes}=unpack([w,h,bits.join(''),...inks]);
    return {board:{...board,mines,opening:visible.flatMap((v,i)=>v>=0?[i]:[])},visible,flags,notes,numbers:true};
  }

  return {
    sizeOk,
    numbers,
    create(w,h,cells) {
      if(!sizeOk(w) || !sizeOk(h)) fail();
      return unpack([w,h,cells??'0'.repeat(w*h),[],[]]);
    },
    encode(position) {
      let payload=pack(position), tag=prefix;
      if(position.numbers) {
        const {board,visible,flags}=position;
        payload=[board.w,board.h,board.mines,visible.map(v=>v<0?'.':v).join(''),[...flags],...payload.slice(3)];
        numbers(...payload.slice(0,5),payload.slice(5)); tag='MS2.';
      } else unpack(payload);
      return tag+btoa(JSON.stringify(payload)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    },
    decode(text) {
      const seed=text.trim();
      const numeric=seed.startsWith('MS2.');
      if(!numeric && !seed.startsWith(prefix)) throw Error('请粘贴以 MS1. 或 MS2. 开头的局面种子。');
      const body=seed.slice(prefix.length);
      if(body.length>50000 || !/^[A-Za-z0-9_-]+$/.test(body)) fail();
      try {
        const data=JSON.parse(atob(body.replace(/-/g,'+').replace(/_/g,'/')));
        if(!Array.isArray(data) || data.length!==(numeric?7:5)) fail();
        return numeric?numbers(...data.slice(0,5),data.slice(5)):unpack(data);
      } catch {return fail();}
    }
  };
}

if(typeof module!=='undefined') module.exports=makePositionSeeds;
