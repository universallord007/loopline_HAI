process.env.LOOPLINE_TEST = "1";
const { createPlayer, beginGame, beginLoop, resolve, finishGame, publicRoom, maintainRooms, rooms } = await import("../server.mjs");
const assert = (condition, message) => { if (!condition) throw new Error(message); };
function makeRoom(count, code) {
  const players = Array.from({ length: count }, (_, i) => createPlayer("Tester " + (i + 1), i === 0));
  return { code, phase:"lobby", round:0, hostId:players[0].id, hostSeen:Date.now(), players, stability:6, score:0, history:[], echoes:[], outcome:null, endsAt:0, tutorialUsed:false, playerStats:{} };
}
function planLoop(room, idleSeat = -1) {
  room.players.forEach((p) => { p.move = null; p.locked = false; });
  const effective = room.echoes.map((m) => ({ ...m, era: room.rule.kind === "drift" ? ["PAST","NOW","FUTURE"][( ["PAST","NOW","FUTURE"].indexOf(m.era)+1 )%3] : m.era }));
  const occupiedByEcho = (core) => effective.some(m=>m.verb==="LIFT"&&m.target===core.id&&m.era===core.safeEra);
  const available=room.players.map((_,i)=>i).filter(i=>i!==idleSeat);
  let cursor=0;
  const use=(verb,era,target=null)=>{const i=available[cursor++];if(i===undefined)return false;room.players[i].move={verb,era,target};return true};
  if(room.round===1){use("SPLICE","PAST");room.cores.forEach(c=>use("LIFT",c.safeEra,c.id));}
  else {
    const gateEcho=effective.some(m=>m.verb==="SPLICE"&&m.era==="PAST");
    if(!gateEcho)use("SPLICE","PAST");
    room.cores.filter(c=>!occupiedByEcho(c)).forEach(c=>use("LIFT",c.safeEra,c.id));
  }
  const ghostMissionEras=new Set(effective.filter(m=>m.verb==="SPLICE"||m.verb==="LIFT").map(m=>m.era));
  for(const i of available.slice(cursor)){
    const candidates=["PAST","NOW","FUTURE"].flatMap(era=>["BOOST","DECOY"].map(verb=>({era,verb})));
    const move=candidates.find(x=>!effective.some(m=>m.era===x.era&&m.verb===x.verb&&m.target===null))||candidates.find(x=>!ghostMissionEras.has(x.era))||{era:"PAST",verb:"DECOY"};
    room.players[i].move={...move,target:null};
  }
  room.players.forEach((p,i)=>{if(i!==idleSeat)p.locked=true;});
  resolve(room);
  assert(room.phase==="reveal","resolution did not enter reveal");
  assert(room.outcome&&room.outcome.log.length>0,"reveal log missing");
}
async function simulate(count, idleSeat=-1) {
  const room=makeRoom(count,"T"+count+"X");beginGame(room);
  assert(room.phase==="planning"&&room.round===1,"round 1 did not begin");
  const privateView=JSON.parse(JSON.stringify(publicRoom(room,room.players[0].token)));
  assert(privateView.me.memory,"own private memory missing");
  if(count>1)assert(!("memory" in privateView.players[1]),"another player's memory leaked");
  for(let round=1;round<=3;round++){
    planLoop(room,round===2?idleSeat:-1);
    if(round<3)beginLoop(room);
  }
  finishGame(room);
  assert(room.phase==="results"&&room.finalStats.length===count,"final results missing");
  assert(room.rating&&room.winner,"winner/rating missing");
  assert(room.history.length===3,"game did not complete three loops");
  assert(idleSeat>=0 ? room.history.filter(loop=>loop.success).length>=2 : room.history.every(loop=>loop.success),"competent crew plan failed unexpectedly");
  return {players:count,loops:room.history.length,successes:room.history.map(h=>h.success),stolen:room.history.map(h=>h.stolen),round2Log:count===2?room.history[1].log.map(x=>x.result):undefined,score:room.score,final:room.rating,idleAutoSkipped:room.history[1].moves.some(m=>m.auto)};
}
const results=[await simulate(2),await simulate(8),await simulate(2,1),await simulate(8,7)];
const hostRoom=makeRoom(2,"HOST");rooms.set(hostRoom.code,hostRoom);
const now=Date.now();hostRoom.players[0].seen=now-100000;hostRoom.players[1].seen=now-500;hostRoom.hostSeen=now-100000;maintainRooms(now);
assert(hostRoom.hostId===hostRoom.players[1].id,"host was not reassigned after host left");
assert(publicRoom(hostRoom,hostRoom.players[1].token).me.id===hostRoom.players[1].id,"token reconnect failed");
const idleRoom=makeRoom(2,"IDLE");rooms.set(idleRoom.code,idleRoom);idleRoom.players.forEach(p=>p.seen=now-100000);maintainRooms(now);
assert(!rooms.has(idleRoom.code),"idle room was not expired");
rooms.delete(hostRoom.code);
console.log(JSON.stringify({simulations:results,hostReassigned:true,reconnectByToken:true,idleRoomExpired:true},null,2));

