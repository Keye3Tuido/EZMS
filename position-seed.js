function makePositionSeeds(adj) {
  const symbols=[['x','s'],['x','s','o','/','v','\u028c','e','//']];
  // Printable characters excluding quotes and backslashes.
  const alphabet=Array.from({length:94},(_,i)=>String.fromCharCode(i+33)).filter(c=>c!=='"' && c!=='\\').join('');
  const digitOf=new Map(Array.from(alphabet,(c,i)=>[c,i]));
  const zero=alphabet[0], escape=alphabet.at(-1), blockSize=256, implicitLimit=65536;
  const maxArea=0xffffffff, varBase=46;
  const sizeOk=n=>Number.isSafeInteger(n) && n>=1;
  const dimensionsOk=(w,h)=>sizeOk(w) && sizeOk(h) && w*h<=maxArea;
  const fail=()=>{throw Error('局面种子无效或已损坏。');};

  function unpack([w,h,cells,...inks]) {
    if(!dimensionsOk(w,h) || typeof cells!=='string' || cells.length!==w*h || !/^[01245]+$/.test(cells)) fail();
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
    const flagSet=flags instanceof Set?flags:new Set(flags??[]);
    return [board.w,board.h,board.bombs.map((mine,i)=>Number(mine)+2*Number(visible[i]>=0)+4*Number(flagSet.has(i))).join(''),
      ...['red','blue'].map((color,c)=>[...(notes?.layers?.[color]??notes?.[c]??[])].sort(([a],[b])=>a-b)
        .map(([i,m])=>[i,symbols[c].indexOf(m.symbol),m.level]))];
  }

  function numbers(w,h,mines=0,digits,flagCells=[],inks=[[],[]]) {
    if(!dimensionsOk(w,h)) fail();
    if(digits===undefined) digits='.'.repeat(w*h);
    if(!Number.isInteger(mines) || mines<0 || mines>w*h ||
      typeof digits!=='string' || digits.length!==w*h || !/^[.0-8]+$/.test(digits) || !Array.isArray(flagCells)) fail();
    const visible=Array.from(digits,c=>c==='.'?-1:Number(c));
    const bits=Array(w*h).fill('0');
    for(const i of flagCells) {
      if(!Number.isInteger(i) || i<0 || i>=w*h || visible[i]!==-1 || bits[i]!=='0') fail();
      bits[i]='4';
    }
    const {board,flags,notes}=unpack([w,h,bits.join(''),...inks]);
    return {board:{...board,mines,opening:visible.flatMap((v,i)=>v>=0?[i]:[])},visible,flags,notes,numbers:true};
  }

  function encodeBigInt(value) {
    if(typeof value!=='bigint' || value<0n) fail();
    if(value===0n) return alphabet[0];
    const base=BigInt(alphabet.length), out=[];
    while(value) {out.push(alphabet[Number(value%base)]);value/=base;}
    return out.reverse().join('');
  }

  function decodeBigInt(text) {
    if(!text) fail();
    let value=0n;
    for(const char of text) {
      const digit=digitOf.get(char);
      if(digit===undefined) fail();
      value=value*92n+BigInt(digit);
    }
    return value;
  }

  function encodeFixed(value,width) {
    if(!Number.isSafeInteger(value) || value<0 || !Number.isInteger(width) || width<1) fail();
    const text=encodeBigInt(BigInt(value));
    if(text.length>width) fail();
    return alphabet[0].repeat(width-text.length)+text;
  }

  function decodeFixed(text,max) {
    const value=decodeBigInt(text);
    if(value>BigInt(max) || value>BigInt(Number.MAX_SAFE_INTEGER)) fail();
    return Number(value);
  }

  function codeWidth(count) {
    return encodeBigInt(BigInt(count-1)).length;
  }

  function encodeRadix(values,radix,start=0,end=values.length) {
    const base=BigInt(radix);
    let value=0n;
    for(let i=start;i<end;i++) value=value*base+BigInt(values[i]);
    return encodeBigInt(value);
  }

  function readRadix(text,radix,result,start,end) {
    let value=decodeBigInt(text);
    const base=BigInt(radix);
    for(let i=end-1;value && i>=start;i--) {
      result[i]=Number(value%base);
      value/=base;
    }
    if(value!==0n) fail();
  }

  function blockWidth(radix,count) {
    return encodeBigInt(BigInt(radix)**BigInt(count)-1n).length;
  }

  // Each header digit carries a base-46 value; its upper half signals continuation.
  function encodeHeader(value) {
    let text='';
    while(value>=varBase) {
      text+=alphabet[varBase+value%varBase];
      value=Math.floor(value/varBase);
    }
    return text+alphabet[value];
  }

  function readHeader(seed) {
    let offset=0;
    function read(max) {
      let value=0, unit=1;
      for(;;unit*=varBase) {
        const digit=digitOf.get(seed[offset++]);
        if(digit===undefined || unit>max && unit>1) fail();
        value+=unit*(digit%varBase);
        if(value>max) fail();
        if(digit<varBase) {
          if(unit>1 && digit===0) fail();
          return value;
        }
      }
    }
    const packed=read(maxArea*8-1), w=Math.floor(packed/8)+1;
    const numeric=!!(packed&1), hasFlags=!!(packed&2), rectangular=!!(packed&4);
    const h=rectangular?read(maxArea-1)+1:w;
    if(!dimensionsOk(w,h) || rectangular && w===h) fail();
    const mines=numeric?read(w*h):0;
    return {w,h,numeric,hasFlags,mines,offset};
  }

  // The board and the optional ink layers share the full alphabet; ~~ is literal, ~! separates fields.
  function readFields(text) {
    const fields=[''];
    for(let start=0;;) {
      const end=text.indexOf(escape,start);
      fields[fields.length-1]+=text.slice(start,end<0?undefined:end);
      if(end<0) break;
      const next=text[end+1];
      if(next===escape) fields[fields.length-1]+=escape;
      else if(next===zero && fields.length<3) fields.push('');
      else fail();
      start=end+2;
    }
    if(fields.length>1 && !fields.at(-1)) fail();
    return fields;
  }

  const cellRadix=(numeric,hasFlags)=>numeric?10+Number(hasFlags):hasFlags?5:3;

  function encodeCells(cells,radix) {
    const n=cells.length;
    // Large boards require a size-proportional payload and use bounded BigInts.
    if(n>implicitLimit) {
      const width=blockWidth(radix,blockSize), parts=[];
      for(let i=0;i<n;i+=blockSize) {
        const size=Math.min(blockSize,n-i);
        parts.push(encodeRadix(cells,radix,i,i+size).padStart(size===blockSize?width:blockWidth(radix,size),zero));
      }
      return parts.join('');
    }
    const dense=encodeRadix(cells,radix);
    if(dense===zero) return '';
    const states=radix-1, width=codeWidth(n*states), sparse=[zero];
    for(let i=0;i<n;i++) if(cells[i]) {
      if(1+sparse.length*width>=dense.length) return dense;
      sparse.push(encodeFixed(i*states+cells[i]-1,width));
    }
    return sparse.join('');
  }

  function decodeCells(text,radix,n) {
    if(n>implicitLimit) {
      const width=blockWidth(radix,blockSize), tail=n%blockSize;
      const tailWidth=tail?blockWidth(radix,tail):0;
      if(text.length!==Math.floor(n/blockSize)*width+tailWidth) fail();
      const result=new Uint8Array(n);
      for(let i=0,offset=0;i<n;i+=blockSize,offset+=width) {
        readRadix(text.slice(offset,offset+width),radix,result,i,Math.min(i+blockSize,n));
      }
      return result;
    }
    const states=radix-1, width=codeWidth(n*states), sparse=text.startsWith(zero);
    if(sparse && (text.length===1 || (text.length-1)%width || (text.length-1)/width>n)) fail();
    if(!sparse && text.length>Math.ceil(n*Math.log(radix)/Math.log(92))) fail();
    const result=new Uint8Array(n);
    if(!text) return result;
    if(!sparse) {
      readRadix(text,radix,result,0,n);
      return result;
    }
    let previous=-1;
    for(let i=1;i<text.length;i+=width) {
      const code=decodeFixed(text.slice(i,i+width),n*states-1), index=Math.floor(code/states);
      if(index<=previous) fail();
      previous=index;
      result[index]=code%states+1;
    }
    return result;
  }

  function encodeNotes(entries,color,n) {
    const states=color===0?2:396, width=codeWidth(n*states);
    return entries.map(([index,symbol,level])=>
      encodeFixed(index*states+symbol+(level?4*(level-2):0),width)).join('');
  }

  function decodeNotes(text,color,n) {
    const states=color===0?2:396, width=codeWidth(n*states);
    if(text.length%width || text.length/width>n) fail();
    const entries=[]; let previous=-1;
    for(let i=0;i<text.length;i+=width) {
      const packed=decodeFixed(text.slice(i,i+width),n*states-1), index=Math.floor(packed/states), code=packed%states;
      if(index<=previous) fail();
      previous=index;
      const symbol=code<4?code:4+code%4, level=code<4?0:1+Math.floor(code/4);
      entries.push([index,symbol,level]);
    }
    return entries;
  }

  function encodeCompact(position) {
    const numeric=!!position.numbers, packed=pack(position), noteEntries=[];
    let canonical;
    if(numeric) {
      const {board,visible,flags}=position;
      const data=[board.w,board.h,board.mines,visible.map(v=>v<0?'.':v).join(''),[...(flags??[])],...packed.slice(3)];
      canonical=numbers(...data.slice(0,5),data.slice(5));
      noteEntries.push(...data.slice(5));
    } else {
      canonical=unpack(packed);
      noteEntries.push(...packed.slice(3));
    }
    const {board,visible,flags}=canonical, n=board.w*board.h, flagSet=new Set(flags);
    const hasFlags=flags.length>0;
    const cells=[];
    for(let i=0;i<n;i++) {
      if(numeric) cells.push(visible[i]<0?(flagSet.has(i)?1:0):visible[i]+1+Number(hasFlags));
      else {
        const mine=board.bombs[i], open=visible[i]>=0, flagged=flagSet.has(i);
        cells.push(open?2:flagged?(mine?4:3):mine?1:0);
      }
    }
    const rectangular=board.w!==board.h;
    const header=encodeHeader(8*(board.w-1)+Number(numeric)+2*Number(hasFlags)+4*Number(rectangular))+
      (rectangular?encodeHeader(board.h-1):'')+(numeric?encodeHeader(board.mines):'');
    const fields=[encodeCells(cells,cellRadix(numeric,hasFlags)),encodeNotes(noteEntries[0],0,n),encodeNotes(noteEntries[1],1,n)];
    while(fields.at(-1)==='') fields.pop();
    return header+fields.map(text=>text.replaceAll(escape,escape+escape)).join(escape+zero);
  }

  function decodeCompact(seed) {
    const {w,h,numeric,hasFlags,mines,offset}=readHeader(seed), n=w*h;
    const [cellText,redText='',blueText='']=readFields(seed.slice(offset));
    const red=decodeNotes(redText,0,n), blue=decodeNotes(blueText,1,n);
    const cells=decodeCells(cellText,cellRadix(numeric,hasFlags),n);
    if(hasFlags && !cells.some(v=>numeric?v===1:v>=3)) fail();
    if(numeric) {
      const visible=Array(n).fill(-1), flags=[];
      for(let i=0;i<n;i++) {
        const value=cells[i];
        if(value===1 && hasFlags) flags.push(i);
        else if(value>0) visible[i]=value-1-Number(hasFlags);
      }
      return numbers(w,h,mines,visible.map(v=>v<0?'.':v).join(''),flags,[red,blue]);
    }
    return unpack([w,h,Array.from(cells,value=>'01245'[value]).join(''),red,blue]);
  }

  return {
    dimensionsOk,
    numbers,
    create(w,h,cells) {
      if(!dimensionsOk(w,h)) fail();
      return unpack([w,h,cells??'0'.repeat(w*h),[],[]]);
    },
    encode(position) { return encodeCompact(position); },
    decode(text) {
      if(typeof text!=='string') return fail();
      try {return decodeCompact(text.trim());}
      catch {return fail();}
    }
  };
}

if(typeof module!=='undefined') module.exports=makePositionSeeds;
