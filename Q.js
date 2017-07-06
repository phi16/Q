const Q = (_=>{
  const c = {};
  // Cmd = {action:() -> Cmd} | {fork:[Cmd]} | {stop:Bool}
  const ACTION = act=>({action:act});
  const FORK = threads=>({fork:threads});
  const STOP = {stop:true};

  // C x = Handler -> ((x, Handler) -> Cmd) -> Cmd

  // a -> C a
  c.pure = a=>h=>next=>next(a,h);
  // (C a, a -> C b) -> C b
  c.bind = (a,f)=>h1=>next=>a(h1)((x,h2)=>f(x)(h2)(next));
  // ((a -> C b) -> C a) -> C a
  c.callCC = proc=>s=>k=>proc(a=>h=>_=>k(a,h))(s)(k);
  // (() -> Generator) -> C a
  c.do = code=>h=>next=>{
    const gen = code();
    const f = val=>{
      const v = gen.next(val);
      if(v.done){
        if(typeof v.value === "undefined")return h=>next=>next(null,h);
        else return v.value;
      }
      return c.bind(v.value,f);
    };
    return f(null)(h)(next);
  };

  // (() -> ()) -> C ()
  c.action = act=>h=>next=>{
    const res = act();
    return next(res,h);
  };
  // C () -> C ()
  c.fork = proc=>h=>next=>{
    return FORK([
      ACTION(_=>next(null,h)),
      ACTION(_=>proc(h)(_=>STOP))
    ]);
  };
  // C ()
  c.abort = h=>next=>{
    return STOP;
  };
  // C () -> ()
  c.run = proc=>{
    const task = [ACTION(_=>proc(null)(_=>STOP))];
    while(task.length>0){
      const t = task.shift();
      if(t.action){
        const next = t.action();
        task.push(next);
      }else if(t.fork){
        t.fork.forEach(f=>{
          task.push(f);
        });
      }else if(t.stop){

      }else{
        throw new Error("Impossble happened! " + t);
      }
    }
  };

  // Box a = {value:a,full:[{value:a,action:C (),check:Handler}]} | {empty:[{send:a -> C (),check:Handler}]}
  // a -> Box a
  c.newBox = x=>({value:x,full:[]});
  // () -> Box a
  c.emptyBox = _=>({empty:[]});
  // Box a -> C a
  c.takeBox = box=>c.callCC(next=>h=>cont=>{
    if(box.full){
      while(box.full.length > 0){
        const p = box.full.shift();
        if(p.check && !p.check.check())continue;
        const x = box.value;
        box.value = p.value;
        return c.bind(c.fork(p.action),_=>c.pure(x))(h)(cont);
      }
      const x = box.value;
      delete box.value;
      delete box.full;
      box.empty = [];
      return c.pure(x)(h)(cont);
    }else{
      box.empty.push({send:b=>_=>_=>next(b)(h)(cont),check:h});
      return c.abort(h)(cont);
    }
  });
  // (Box a,a) -> C ()
  c.putBox = (box,x)=>c.callCC(next=>h=>cont=>{
    if(box.full){
      box.full.push({value:x,action:_=>_=>next()(h)(cont),check:h});
      return c.abort(h)(cont);
    }else{
      while(box.empty.length > 0){
        const fork = box.empty.shift();
        if(fork.check && !fork.check.check())continue;
        return c.fork(fork.send(x))(h)(cont);
      }
      delete box.empty;
      box.value = x;
      box.full = [];
      return next()(h)(cont);
    }
  });
  // Box a -> C a
  c.readBox = box=>{
    if(box.full){
      return c.pure(box.value);
    }else{
      return c.bind(c.takeBox(box),val=>{
        return c.bind(c.putBox(box,val),_=>{
          return c.pure(val);
        });
      });
    }
  };
  // Box a -> {just:x} | null
  c.peekBox = box=>{
    if(box.full)return {just:box.value};
    else null;
  };
  // Box a -> ()
  c.normalizeBox = box=>{
    if(box.full){
      for(let i=0;i<box.full.length;i++){
        if(box.full[i].check && !box.full[i].check.check()){
          box.full.splice(i,1);
          i--;
        }
      }
    }else{
      for(let i=0;i<box.empty.length;i++){
        if(box.empty[i].check && !box.empty[i].check.check()){
          box.empty.splice(i,1);
          i--;
        }
      }
    }
  };

  // R -> C ()
  c.waitMS = ms=>{
    const v = c.emptyBox();
    setTimeout(_=>{
      c.run(c.putBox(v,{}));
    },ms);
    return c.takeBox(v);
  };

  // Receiver a = {receive:C a}
  // Sender a = {send:a -> C ()}

  // Box a -> Receiver a
  function receiver(p){
    return {receive:c.takeBox(p)};
  }
  function sender(p){
    return {send:x=>c.fork(c.putBox(p,x)),origin:p};
  }
  // (Receiver a -> C ()) -> Sender a
  c.spawn = handler=>{
    const p = c.emptyBox();
    return c.bind(c.fork(handler(receiver(p))),_=>c.pure(sender(p)));
  };
  // Receiver a -> C ()
  c.consume = box=>c.do(function*(){
    while(1)yield box.receive;
  });

  // C a -> C a
  c.delay = f=>h=>next=>f()(h)(next);
  // C ()
  c.switch = c.delay(_=>c.waitMS(0));
  // (C () -> C ()) -> C ()
  c.waitUntil = proc=>{
    const b = c.emptyBox();
    return c.bind(proc(c.putBox(b,{})),_=>{
      return c.bind(c.takeBox(b),_=>{
        return c.switch;
      });
    });
  };
  // Promise a -> C a
  c.await = p=>{
    const b = c.emptyBox();
    p.then(d=>c.run(c.putBox(b,{fulfill:d})),e=>c.run(c.putBox(b,{reject:e})));
    return c.takeBox(b);
  };

  // [a] -> (a -> C ()) -> C ()
  c.foreach = arr=>proc=>c.do(function*(){
    for(let i=0;i<arr.length;i++){
      yield proc(arr[i]);
    }
  });

  // Handler = {check : () -> Bool, handlers : [() -> ()], blocks : [Box ()]} ?
  function merge(u,v){
    if(!u)return v;
    if(!v)return u;
    return {
      check:_=>u.check()&&v.check(),
      handlers:u.handlers.concat(v.handlers),
      blocks:u.blocks.concat(v.blocks)
    };
  }
  let anyCount = 0, anyHandlers = {};
  let termCount = 0, termHandlers = {};
  // C Handler
  const getHandler = h=>next=>next(h,h);
  // Handler -> C ()
  const putHandler = h=>_=>next=>next(null,h);
  // C () -> C ()
  c.onTerminate = action=>Q.do(function*(){
    const h = yield getHandler;
    const id = termCount++;
    let done = false;
    h.handlers.forEach(hh=>{
      if(!anyHandlers[hh])done = true;
    });
    if(done){
      yield action;
    }else{
      termHandlers[id] = action;
      h.handlers.forEach(hh=>{
        anyHandlers[hh].push(id);
      });
    }
  });
  c.join = {};
  // [C ()] -> C ()
  c.join.any = procs=>c.do(function*(){
    let b = true;
    const id = anyCount++;
    anyHandlers[id] = [];
    const h = yield getHandler;
    const handle = {
      check : _=>b,
      handlers : [id],
      blocks : []
    };
    const done = c.emptyBox();
    const newHandle = merge(h,handle);
    for(let i=0;i<procs.length;i++){
      const j = i;
      yield putHandler(newHandle);
      yield c.fork(c.bind(c.bind(c.switch,_=>procs[j]),_=>Q.do(function*(){
        if(b){
          b = false;
          yield putHandler(null);
          for(let i=0;i<anyHandlers[id].length;i++){
            const tid = anyHandlers[id][i];
            if(termHandlers[tid]){
              yield termHandlers[tid];
              delete termHandlers[tid];
            }
          }
          yield putHandler(newHandle);
          delete anyHandlers[id];
          return c.putBox(done,{});
        }
        return c.abort;
      })));
      yield putHandler(h);
      yield c.switch;
    }
    yield c.takeBox(done);
  });
  // [C ()] -> C ()
  c.join.all = procs=>c.do(function*(){
    const count = c.emptyBox();
    for(let i=0;i<procs.length;i++){
      yield c.fork(c.bind(procs[i],_=>c.putBox(count,{})));
    }
    for(let i=0;i<procs.length;i++)yield c.takeBox(count);
  });
  // (((C a, a -> C ()) -> ()) -> ()) -> C ()
  c.choose = proc=>c.do(function*(){
    let conds = [];
    let execs = [];
    let i = 0;
    let type = -1;
    let result;
    proc((e,h)=>{
      let j = i;
      conds.push(Q.bind(e,res=>Q.action(_=>{
        type = j;
        result = res;
      })));
      execs.push(h);
      i++;
    });
    yield c.join.any(conds);
    yield execs[type](result);
  });

  // [C ()] -> C ()
  c.flow = acts=>c.do(function*(){
    for(let i=0;i<acts.length;i++){
      yield acts[i];
    }
  });
  return c;
})();
