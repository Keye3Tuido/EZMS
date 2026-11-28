// 单一请求通道，供对局和编辑器交互使用。取消后销毁旧线程，以隔离它的迟到消息。
function makeGameRequests({openWorker,onBusyChange}) {
  let worker, pending;
  const code=`
const engine = makeMinesEngine();
onmessage = ({data:{kind,board,p,visible,proven,flags,cells,opening,allowUnsolved,exact,confirmed}}) => {
  try { postMessage(kind==='classify' ? engine.classify(p,visible,{nodeBudget:Infinity})
    : kind==='advance' ? engine.advance(board,p,visible,cells,proven,{allowUnsolved,exact,flags})
    : kind==='expand' ? engine.expand(board,visible,flags)
    : kind==='materialize' ? engine.publicBoard(p,visible)
    : engine.hint(p,visible,proven,flags,{opening,confirmed})); }
  catch { postMessage({status:'error'}); }
};
`;

  function finish(result) {
    const resolve=pending;
    if(!resolve) return;
    pending=null;
    resolve(result);
    onBusyChange();
  }

  function terminate() {
    const task=worker;
    worker=null;
    task?.terminate();
  }

  function cancel() {
    const resolve=pending;
    if(!resolve) return;
    pending=null;
    terminate();
    // 调用方完成停止求解、隐藏推导或关闭导入的状态更新后，再统一刷新控件。
    resolve(null);
  }

  function ask(kind,data) {
    if(pending) return Promise.resolve({status:'error'});
    if(!worker) {
      try { worker=openWorker(code); }
      catch { return Promise.resolve({status:'error'}); }
      const task=worker;
      task.onmessage=({data})=>{
        if(task===worker) finish(data);
      };
      const fail=()=>{
        if(task!==worker) return;
        terminate();
        finish({status:'error'});
      };
      task.onerror=fail;
      task.addEventListener('messageerror',fail);
    }
    return new Promise(resolve=>{
      pending=resolve;
      onBusyChange();
      try { worker.postMessage({kind,...data}); }
      catch {
        terminate();
        finish({status:'error'});
      }
    });
  }

  return {ask,cancel,get busy(){return !!pending;}};
}

if(typeof module!=='undefined') module.exports=makeGameRequests;
