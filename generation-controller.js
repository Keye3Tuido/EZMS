'use strict';

const generationWorkerCode=`
const options={};
onmessage = async ({data:{p,seed,originalTarget,candidateFallback}}) => {
  options.candidateFallback=candidateFallback;
  if(!p) return;
  options.originalTarget=originalTarget;
  try {
    let updated = -Infinity, sentCandidate;
    const sendProgress=({candidate,...progress})=>{
      postMessage(candidate!==sentCandidate ? {progress,candidate} : {progress});
      sentCandidate=candidate;
      updated=performance.now();
    };
    for (const result of makeMinesEngine().generate(p,seed,sendProgress,options)) {
      if (result.board) { postMessage({result}); return; }
      if (performance.now() - updated >= 100) sendProgress(result);
      // 原目标线程在轮次之间接收实际并发变化。
      if(originalTarget) await new Promise(resolve=>setTimeout(resolve,0));
    }
  }
  catch (error) { postMessage({error:error.message}); }
};
`;

// 并行搜索接收 Worker 适配器和引擎策略，通过事件通知页面。
function makeGenerationController({rank,scheduleFor,logicalCores,randomSeed,openWorker,
  onChange,onStart,onCandidate,onProgress,onFailure,onResult}) {
  let activeSearch, closestCandidate;

  function discardCandidate() {
    const hadCandidate=!!closestCandidate;
    closestCandidate=undefined;
    return hadCandidate;
  }

  function stop(keepCandidate=false) {
    for(const lane of activeSearch?.active??[]) lane.terminate();
    activeSearch=null;
    if(!keepCandidate) discardCandidate();
    onChange();
  }

  function start(p) {
    const {target,compareClosest}=rank(p);
    const schedule=scheduleFor(p,logicalCores());
    const usedSeeds=new Set();
    closestCandidate=undefined;
    let canStartMore=true, originalLane, replacedOriginal=false, originalFallback;
    const task=activeSearch={lanes:new Map(),active:new Set()};
    function progress() {
      let tried=0,passed=0;
      for(const lane of task.lanes.values()) {tried+=lane.tried;passed+=lane.passed;}
      const report=closestCandidate?.report;
      const closest=report&&{average:report.averageClues,multiPercent:report.advancedDensity*100,peak:report.clues};
      return {tried,passed,closest,target};
    }
    function failed(lane,kind,detail) {
      if(activeSearch!==task || !task.active.delete(lane)) return;
      lane.terminate();
      if(lane===originalLane) {
        if(!replacedOriginal) {
          replacedOriginal=true;
          try { startLane(true); return; }
          catch { /* 补位失败，结束整组搜索。 */ }
        }
      } else if(task.active.size) {
        updateCandidateFallback();
        return;
      }
      stop(true);
      onFailure(kind,detail,closestCandidate);
    }
    function startLane(originalTarget) {
      let seed=randomSeed();
      while(usedSeeds.has(seed)) seed=(seed+1)>>>0;
      usedSeeds.add(seed);
      const lane=openWorker(generationWorkerCode);
      lane.onmessage=({data})=>{
        if(activeSearch!==task || !task.active.has(lane)) return;
        if(data.error) {failed(lane,'search',data.error);return;}
        if(data.progress) {
          task.lanes.set(lane,data.progress);
          if(data.candidate && (!closestCandidate || compareClosest(data.candidate.report,closestCandidate.report)<0)) {
            closestCandidate={...data.candidate,p};
            onCandidate();
          }
          const merged=progress();
          if(closestCandidate) closestCandidate.progress=merged;
          startLanes(schedule.lanesAt(merged.tried));
          onProgress(merged,closestCandidate?.report);
          return;
        }
        const result=data.result;
        task.lanes.set(lane,result);
        const {tried}=progress();
        stop();
        onResult(result,p,tried);
      };
      lane.onerror=()=>failed(lane,'worker');
      const candidateFallback=originalTarget && !task.active.size;
      try { lane.postMessage({p,seed,originalTarget,candidateFallback}); }
      catch(error) { lane.terminate(); throw error; }
      task.lanes.set(lane,{tried:0,passed:0});
      task.active.add(lane);
      if(originalTarget) {
        originalLane=lane;
        originalFallback=candidateFallback;
      }
    }
    function updateCandidateFallback() {
      if(!task.active.has(originalLane)) return;
      const enabled=task.active.size===1;
      if(enabled===originalFallback) return;
      originalLane.postMessage({candidateFallback:enabled});
      originalFallback=enabled;
    }
    function startLanes(desired) {
      // 退役线程仍计入累计进度，补位只占原有的一个并发名额。
      const scheduled=task.lanes.size-Number(replacedOriginal);
      for(let count=scheduled;canStartMore && count<desired;count++) {
        try { startLane(!originalLane); }
        catch { canStartMore=false; }
      }
      updateCandidateFallback();
    }
    startLanes(schedule.initial);
    if(!task.active.size) {
      stop();
      onFailure('startup');
      return;
    }
    onChange();
    onStart();
  }

  return {start,stop,discardCandidate,
    get searching(){return !!activeSearch;},
    get candidate(){return closestCandidate;}
  };
}

if(typeof module!=='undefined') module.exports=makeGenerationController;
