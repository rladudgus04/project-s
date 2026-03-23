const express = require('express');
const app = express();
const server = require('http').Server(app);
const io = require('socket.io')(server);
app.use(express.static(__dirname + '/public'));

const MAP = 1100; // 맵 경계 -MAP ~ MAP

const STAGE_CONFIG = [
  { waves:[{melee:36,ranged:10,hp:80,dmg:8},{melee:36,ranged:18,hp:90,dmg:10},{melee:30,ranged:23,hp:100,dmg:12}],
    boss:{name:'안개의 수호자',hp:8000,dmg:20,speed:4,pattern:'charge'} },
  { waves:[{melee:26,ranged:23,hp:110,dmg:12},{melee:28,ranged:24,hp:120,dmg:14},{melee:29,ranged:25,hp:130,dmg:16}],
    boss:{name:'심연의 파수꾼',hp:10000,dmg:22,speed:8.8,pattern:'spin'} },
  { waves:[{melee:28,ranged:24,hp:140,dmg:15},{melee:30,ranged:25,hp:150,dmg:18},{melee:32,ranged:26,hp:160,dmg:20}],
    boss:{name:'황혼의 군주',hp:14000,dmg:24,speed:8.8,pattern:'cross'} },
  { waves:[{melee:30,ranged:25,hp:170,dmg:20},{melee:32,ranged:27,hp:180,dmg:22},{melee:34,ranged:28,hp:200,dmg:25}],
    boss:{name:'혼돈의 지배자',hp:19000,dmg:50,speed:8.8,pattern:'berserk'} },
  { waves:[{melee:32,ranged:27,hp:200,dmg:25},{melee:35,ranged:29,hp:220,dmg:28},{melee:38,ranged:30,hp:250,dmg:30}],
    boss:{name:'어둠의 왕',hp:28000,dmg:100,speed:9.0,pattern:'final',isFinal:true} },
];

const UPGRADES = [
  { id:'dmg',   name:'영혼의 불꽃',   desc:'공격 데미지 +20%',      apply:p=>{p.damageMult=(p.damageMult||1)*1.2;} },
  { id:'def',   name:'수호의 갑옷',   desc:'받는 데미지 -3%',       apply:p=>{p.defenseMult=(p.defenseMult||1)*0.97;} },
  { id:'regen', name:'재생의 결정',   desc:'5초마다 HP 10 회복',    apply:p=>{p.regenRate=(p.regenRate||0)+10;} },
  { id:'cd',    name:'노련한 솜씨',   desc:'스킬 쿨타임 10% 감소',  apply:p=>{p.cdMult=(p.cdMult||1)*0.9;} },
  { id:'aspd',  name:'영혼 가속',     desc:'공격 속도 15% 증가',    apply:p=>{p.aspdMult=(p.aspdMult||1)*1.15;} },
];

// ===== 아이템 =====
const ITEMS_LIST = [
  { id:'longsword',  name:'롱소드',      type:'weapon', roles:['attacker','tanker'], desc:'공격력 +10%, 공격범위 +10%' },
  { id:'soulBook',   name:'영혼의 책',   type:'weapon', roles:['healer'],            desc:'치유량 +10%, 치유범위 +10%' },
  { id:'ironArmor',  name:'철갑옷',      type:'armor',  roles:null,                  desc:'받는 데미지 -15%' },
  { id:'swiftBoots', name:'신속한 장화', type:'boots',  roles:null,                  desc:'이동속도 +10%' },
];

// ===== XP 스케일링 (레벨당 20% 증가) =====
function xpForLevel(lv){ return Math.ceil(100*Math.pow(1.2,lv-1)); }
function getPlayerLevel(xp){
  let lv=1,total=0;
  while(total+xpForLevel(lv)<=xp){total+=xpForLevel(lv);lv++;}
  return {lv,xpInLevel:xp-total,xpMax:xpForLevel(lv)};
}

// ===== 맵 생성 (트리 구조) =====
function generateMap() {
  const nodes=[]; let nid=0;
  // 방 비율: 전투 70%, 성장 20%, 장비 10%
  function randRoomType(){const r=Math.random();return r<0.70?'mob':r<0.90?'upgrade':'equipment';}
  // Floor 0: 시작 (클리어됨)
  nodes.push({id:nid++,type:'start',floor:0,children:[],cleared:true});
  // Floors 1-10: 각 층 2-3개 방 선택
  for(let floor=1;floor<=10;floor++){
    const count=Math.random()<0.4?2:3;
    for(let i=0;i<count;i++)
      nodes.push({id:nid++,type:randRoomType(),floor,children:[],cleared:false});
  }
  // Floor 11: 보스
  nodes.push({id:nid++,type:'boss',floor:11,children:[],cleared:false});
  // 연결: 각 층의 모든 노드를 다음 층 모든 노드와 연결
  for(let floor=0;floor<=10;floor++){
    const cur=nodes.filter(n=>n.floor===floor);
    const nxt=nodes.filter(n=>n.floor===floor+1);
    cur.forEach(n=>{n.children=nxt.map(x=>x.id);});
  }
  return nodes;
}

// ===== 장비 스탯 적용 =====
function applyEquipStats(p){
  const eq=p.equipped||{};
  p.equipDmg   = eq.weapon==='longsword'  ? 1.1 : 1;
  p.equipRange  = eq.weapon==='longsword'  ? 1.1 : 1;
  p.equipHeal   = eq.weapon==='soulBook'   ? 1.1 : 1;
  p.equipHealR  = eq.weapon==='soulBook'   ? 1.1 : 1;
  p.equipDef    = eq.armor ==='ironArmor'  ? 0.85: 1;
  p.equipSpeed  = eq.boots ==='swiftBoots' ? 1.1 : 1;
}

function emitStats(room, p){
  io.to(p.id).emit('statsUpdate',{
    speedMult:(p.speedMult||1)*(p.equipSpeed||1),
    damageMult:(p.damageMult||1)*(p.equipDmg||1),
    skillMult:p.skillMult||1, cdMult:p.cdMult||1, aspdMult:p.aspdMult||1,
    healMult:(p.skillMult||1)*(p.equipHeal||1), healRangeMult:p.equipHealR||1,
    attackRangeMult:p.equipRange||1,
    hp:p.hp, maxHp:p.maxHp, equipped:p.equipped||{}, inventory:p.inventory||[]
  });
}

const rooms = {};
let gEid = 0;

function dist(a,b) { return Math.hypot(a.x-b.x,a.y-b.y); }
function norm(dx,dy) { const d=Math.hypot(dx,dy)||1; return [dx/d,dy/d]; }
function clamp(v,mn,mx) { return Math.max(mn,Math.min(mx,v)); }
function getLobbyState(room) {
  return { roomId:room.id, players:Object.values(room.players).map(p=>({id:p.id,role:p.role,ready:p.ready,name:p.name||'영혼'})) };
}

// ===== 대미지 =====
function damagePlayer(room, player, base) {
  if (!player || player.hp<=0 || player.invincible) return;
  // 수호물 내부 무적
  if(room.barriers && room.barriers.length>0){
    for(const bar of room.barriers){if(dist(player,bar)<250)return;}
  }
  const mult = (player.defenseMult||1) * (player.equipDef||1) * (player.role==='tanker'?0.5:1);
  player.hp = Math.max(0, player.hp - base*mult);
  io.to(room.id).emit('playerHealthUpdate',{playerId:player.id,hp:Math.floor(player.hp),maxHp:player.maxHp});
  if(player.hp<=0) io.to(room.id).emit('playerDied',{playerId:player.id});
}

// ===== 그로기 공통 헬퍼 (모든 보스 2페이즈에서 15초마다) =====
function tickGroggy(room, boss, now) {
  // 그로기 해제
  if(boss.groggy && now >= boss.groggyEnd) {
    boss.groggy = false;
    boss.isCharging = false;
    io.to(room.id).emit('bossAction',{type:'groggyEnd',x:boss.x,y:boss.y});
  }
  // 2페이즈 진입 추적 (HP 50% 이하)
  if(boss.hp < boss.maxHp*0.5 && !boss.phase2Entry) {
    boss.phase2Entry = now;
  }
  // 15초마다 그로기 발동
  if(boss.phase2Entry && !boss.groggy) {
    const idx = Math.floor((now - boss.phase2Entry) / 15000);
    if(idx > 0 && idx > (boss.lastGroggyIdx||0)) {
      boss.lastGroggyIdx = idx;
      boss.groggy = true;
      boss.groggyEnd = now + 8000;
      boss.isCharging = false;
      io.to(room.id).emit('bossAction',{type:'groggy',x:boss.x,y:boss.y,duration:8000});
    }
  }
  return boss.groggy;
}

// ===== 보스 패턴 =====
const BOSS_AI = {

  charge(room, boss, alive, now) {
    if(!alive.length) return;

    // ── 페이즈 전환 ──
    if(boss.hp <= boss.maxHp*0.75 && !boss.phase2Triggered) {
      boss.phase2Triggered=true; boss.isCharging=false;
      boss.x=0; boss.y=0;
      const pillars=[];
      for(let i=0;i<6;i++){
        const a=(i/6)*Math.PI*2+Math.random()*0.5;
        const r=350+Math.random()*350;
        pillars.push({id:i,x:clamp(Math.cos(a)*r,-900,900),y:clamp(Math.sin(a)*r,-900,900),broken:false});
      }
      room.pillars=pillars; room.phase2MechanicSolved=false;
      io.to(room.id).emit('bossAction',{type:'phase2',pillars,x:0,y:0});
    }
    if(boss.hp <= boss.maxHp*0.375 && !boss.phase3Triggered) {
      boss.phase3Triggered=true;
      const frags=[];
      for(let i=0;i<10;i++)
        frags.push({id:i,x:(Math.random()-0.5)*1800,y:(Math.random()-0.5)*1800,collected:false});
      room.soulFragments=frags; room.neutralGauge=0; room.neutralMult=0;
      room.phase3MechanicSolved=false; room.phase3Failed=false;
      room.neutralDeadline=now+30000;
      io.to(room.id).emit('bossAction',{type:'phase3',fragments:frags,x:boss.x,y:boss.y,timer:30});
    }

    // ── 3페이즈 타이머/게이지 ──
    if(boss.phase3Triggered && !room.phase3MechanicSolved && !room.phase3Failed) {
      const timeLeft=Math.max(0,room.neutralDeadline-now);
      if(!room._lgEmit||now-room._lgEmit>250){
        room._lgEmit=now;
        io.to(room.id).emit('neutralGaugeUpdate',{gauge:Math.floor(room.neutralGauge||0),timeLeft:Math.ceil(timeLeft/1000)});
      }
      if(timeLeft<=0){
        room.phase3Failed=true;
        Object.values(room.players).forEach(p=>{
          if(p.hp>0){p.hp=0;
            io.to(room.id).emit('playerHealthUpdate',{playerId:p.id,hp:0,maxHp:p.maxHp});
            io.to(room.id).emit('playerDied',{playerId:p.id});
          }
        });
        io.to(room.id).emit('bossAction',{type:'mechanic3_fail'});
      }
    }

    // ── 영혼조각 수집 체크 ──
    if(boss.phase3Triggered && room.soulFragments) {
      room.soulFragments.forEach(frag=>{
        if(frag.collected) return;
        alive.forEach(p=>{
          if(!frag.collected && dist(p,frag)<40){
            frag.collected=true;
            room.neutralMult=Math.min(1.0,(room.neutralMult||0)+0.1);
            io.to(room.id).emit('bossAction',{type:'fragment_collect',id:frag.id,neutralMult:room.neutralMult});
          }
        });
      });
    }

    // ── 1페이즈 ──
    if(!boss.phase2Triggered) {
      const target=alive.reduce((a,b)=>dist(a,boss)<dist(b,boss)?a:b);
      const dx=target.x-boss.x,dy=target.y-boss.y,d=Math.hypot(dx,dy);
      const [nx,ny]=norm(dx,dy);
      if(!boss.isCharging&&d>80){boss.x+=nx*boss.speed;boss.y+=ny*boss.speed;}
      // 근접
      if(d<80&&(!boss.lastMelee||now-boss.lastMelee>1000)){
        boss.lastMelee=now;
        damagePlayer(room,target,boss.dmg);
        io.to(room.id).emit('bossAction',{type:'melee',x:boss.x,y:boss.y});
      }
      // 돌진 (2s = 50tick@40ms, 쿨 3s)
      if(!boss.isCharging&&(!boss.lastCharge||now-boss.lastCharge>3000)){
        boss.lastCharge=now;
        const t=alive[Math.floor(Math.random()*alive.length)];
        const tx=t.x,ty=t.y;
        io.to(room.id).emit('bossAction',{type:'charge_warn',tx,ty,delay:0});
        setTimeout(()=>{
          if(!room.boss)return;
          boss.isCharging=true;
          const cx=tx-boss.x,cy=ty-boss.y,cd=Math.hypot(cx,cy)||1;
          const [bx,by]=[cx/cd,cy/cd];
          let ticks=0;
          const iv=setInterval(()=>{
            if(!room.boss||ticks++>=50){
              if(room.boss){
                boss.isCharging=false;
                // 돌진 종료 — 정확한 위치 스냅 이벤트
                io.to(room.id).emit('bossAction',{type:'charge_end',x:boss.x,y:boss.y});
              }
              clearInterval(iv);return;
            }
            boss.x+=bx*22;boss.y+=by*22;
            boss.x=clamp(boss.x,-MAP,MAP);boss.y=clamp(boss.y,-MAP,MAP);
            alive.forEach(p=>{if(dist(p,boss)<60)damagePlayer(room,p,boss.dmg);});
          },40);
        },500);
      }
      // 구형 AoE (5s CD, 2s 경고)
      if(!boss.lastSphere||now-boss.lastSphere>5000){
        boss.lastSphere=now;
        const t=alive[Math.floor(Math.random()*alive.length)];
        const sx=t.x,sy=t.y;
        io.to(room.id).emit('bossAction',{type:'sphere_warn',x:sx,y:sy,radius:250});
        setTimeout(()=>{
          if(!room.boss)return;
          io.to(room.id).emit('bossAction',{type:'sphere',x:sx,y:sy,radius:250});
          Object.values(room.players).filter(p=>p.hp>0).forEach(p=>{
            if(Math.hypot(p.x-sx,p.y-sy)<250)damagePlayer(room,p,boss.dmg*2.5);
          });
        },2000);
      }
      // 8방향 탄도 (4s CD)
      if(!boss.lastProj||now-boss.lastProj>4000){
        boss.lastProj=now;
        for(let i=0;i<8;i++){
          const a=(i/8)*Math.PI*2;
          const pid=`p${room.projId++}`;
          room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,vx:Math.cos(a)*11.7,vy:Math.sin(a)*11.7,dmg:boss.dmg*0.6,ttl:150};
        }
        io.to(room.id).emit('bossAction',{type:'spin',x:boss.x,y:boss.y});
      }
    }

    // ── 2페이즈 ──
    if(boss.phase2Triggered && !boss.phase3Triggered) {
      // 스턴 해제 체크
      if(boss.stunned && now>=boss.stunEnd){
        boss.stunned=false;
        io.to(room.id).emit('bossAction',{type:'stunEnd',x:boss.x,y:boss.y});
      }
      // 스턴 중엔 패턴 스킵
      if(boss.stunned) return;

      // 랜덤 플레이어를 향한 돌진 (2s 경고, 1s 돌진)
      if(!boss.isCharging&&(!boss.lastWallCharge||now-boss.lastWallCharge>5000)){
        boss.lastWallCharge=now;
        const t=alive[Math.floor(Math.random()*alive.length)];
        const tx=t.x, ty=t.y;
        io.to(room.id).emit('bossAction',{type:'charge_warn',tx,ty,delay:0});
        setTimeout(()=>{
          if(!room.boss)return;
          boss.isCharging=true;
          const cx=tx-boss.x,cy=ty-boss.y,cd=Math.hypot(cx,cy)||1;
          const [bx,by]=[cx/cd,cy/cd];
          let ticks=0;
          const iv=setInterval(()=>{
            if(!room.boss||ticks++>=25){if(room.boss)boss.isCharging=false;clearInterval(iv);return;}
            boss.x+=bx*36;boss.y+=by*36;
            boss.x=clamp(boss.x,-MAP,MAP);boss.y=clamp(boss.y,-MAP,MAP);
            // 기둥 충돌 → 3초 스턴
            (room.pillars||[]).forEach(pillar=>{
              if(!pillar.broken&&dist(boss,pillar)<100){
                pillar.broken=true;
                boss.isCharging=false; clearInterval(iv);
                boss.stunned=true; boss.stunEnd=Date.now()+3000;
                io.to(room.id).emit('bossAction',{type:'pillar_break',id:pillar.id});
                io.to(room.id).emit('bossAction',{type:'stunned',x:boss.x,y:boss.y,duration:3000});
                if((room.pillars||[]).every(p=>p.broken)){
                  room.phase2MechanicSolved=true;
                  io.to(room.id).emit('bossAction',{type:'mechanic2_solved'});
                }
              }
            });
            alive.forEach(p=>{if(dist(p,boss)<60)damagePlayer(room,p,boss.dmg*1.5);});
          },40);
        },2000);
      }
      // 12방향 원형 탄막 (3.5s CD)
      if(!boss.lastSpin2||now-boss.lastSpin2>3500){
        boss.lastSpin2=now;
        for(let i=0;i<12;i++){
          const a=(i/12)*Math.PI*2;
          const pid=`p${room.projId++}`;
          room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,vx:Math.cos(a)*11.7,vy:Math.sin(a)*11.7,dmg:boss.dmg*0.55,ttl:140};
        }
        io.to(room.id).emit('bossAction',{type:'spin',x:boss.x,y:boss.y});
      }
    }

    // ── 3페이즈 ──
    if(boss.phase3Triggered) {
      const target=alive.reduce((a,b)=>dist(a,boss)<dist(b,boss)?a:b);
      const dx=target.x-boss.x,dy=target.y-boss.y,d=Math.hypot(dx,dy);
      const [nx,ny]=norm(dx,dy);
      if(!boss.isCharging&&d>80){boss.x+=nx*boss.speed*1.3;boss.y+=ny*boss.speed*1.3;}
      if(d<80&&(!boss.lastMelee3||now-boss.lastMelee3>700)){
        boss.lastMelee3=now;
        damagePlayer(room,target,boss.dmg*1.2);
      }
      // 16방향 탄막 (2s CD)
      if(!boss.lastSpin3||now-boss.lastSpin3>2000){
        boss.lastSpin3=now;
        for(let i=0;i<16;i++){
          const a=(i/16)*Math.PI*2;
          const pid=`p${room.projId++}`;
          room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,vx:Math.cos(a)*13,vy:Math.sin(a)*13,dmg:boss.dmg*0.65,ttl:130};
        }
        io.to(room.id).emit('bossAction',{type:'spin',x:boss.x,y:boss.y});
      }
      // 맵 끝→끝 돌진 (2s 경고, 4s CD)
      if(!boss.isCharging&&(!boss.lastCharge3||now-boss.lastCharge3>4000)){
        boss.lastCharge3=now;
        const t=alive[Math.floor(Math.random()*alive.length)];
        const ddx=t.x-boss.x||1,ddy=t.y-boss.y||0;
        const [dnx,dny]=norm(ddx,ddy);
        const sx=-dnx*MAP*0.9,sy=-dny*MAP*0.9;
        const ex=dnx*MAP*0.9,ey=dny*MAP*0.9;
        io.to(room.id).emit('bossAction',{type:'wallcharge_warn',sx,sy,ex,ey,duration:2000});
        setTimeout(()=>{
          if(!room.boss)return;
          boss.isCharging=true;boss.x=sx;boss.y=sy;
          const total=25,stX=(ex-sx)/total,stY=(ey-sy)/total;
          let ticks=0;
          const iv=setInterval(()=>{
            if(!room.boss||ticks++>=total){if(room.boss)boss.isCharging=false;clearInterval(iv);return;}
            boss.x+=stX;boss.y+=stY;
            alive.forEach(p=>{if(dist(p,boss)<60)damagePlayer(room,p,boss.dmg*1.5);});
          },40);
        },2000);
      }
    }

    boss.x=clamp(boss.x,-MAP,MAP);boss.y=clamp(boss.y,-MAP,MAP);
  },

  spin(room, boss, alive, now) {
    if(tickGroggy(room, boss, now)) return;
    const target = alive.reduce((a,b)=>dist(a,boss)<dist(b,boss)?a:b);
    const dx=target.x-boss.x, dy=target.y-boss.y, d=Math.hypot(dx,dy);
    const [nx,ny]=norm(dx,dy);
    const phase2 = boss.hp < boss.maxHp*0.5;

    // 거리 유지 이동
    const moveSpd = phase2 ? boss.speed*2.0 : boss.speed*1.2;
    const keep=200;
    if(d>keep+40){boss.x+=nx*moveSpd;boss.y+=ny*moveSpd;}
    else if(d<keep-40){boss.x-=nx*moveSpd;boss.y-=ny*moveSpd;}

    // 삼중 스파이럴: 매 100-160ms, 3방향
    const spiralCD = phase2 ? 100 : 160;
    if(!boss.lastSpiral||now-boss.lastSpiral>spiralCD) {
      boss.lastSpiral=now;
      boss.spiralAngle=(boss.spiralAngle||0)+(phase2?0.6:0.42);
      const arms = phase2 ? 3 : 2;
      for(let arm=0;arm<arms;arm++){
        const a=boss.spiralAngle+arm*(Math.PI*2/arms);
        const pid=`p${room.projId++}`;
        room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,
          vx:Math.cos(a)*9.75,vy:Math.sin(a)*9.75,dmg:boss.dmg*0.52,ttl:160};
      }
    }

    // 유도탄: 더 많이, 더 빠르게
    const homingCD = phase2 ? 1800 : 3200;
    if(!boss.lastHoming||now-boss.lastHoming>homingCD) {
      boss.lastHoming=now;
      const count = phase2 ? 8 : 4;
      for(let i=0;i<count;i++){
        const p = alive[i % alive.length];
        setTimeout(()=>{
          if(!room.boss||!rooms[room.id])return;
          const b=room.boss;
          const ang=Math.atan2(p.y-b.y,p.x-b.x);
          const pid=`p${room.projId++}`;
          room.projectiles[pid]={id:pid,x:b.x,y:b.y,
            vx:Math.cos(ang)*8.45,vy:Math.sin(ang)*8.45,
            dmg:b.dmg*0.75,ttl:200,homing:p.id};
        },i*200);
      }
      io.to(room.id).emit('bossAction',{type:'homing_warn',x:boss.x,y:boss.y});
    }

    // 순간이동: 더 자주, 16방향 폭발 + phase2 즉시 유도탄
    const teleCD = phase2 ? 2200 : 4000;
    if(!boss.lastTele||now-boss.lastTele>teleCD){
      boss.lastTele=now;
      const tp=alive[Math.floor(Math.random()*alive.length)];
      const tAngle=Math.random()*Math.PI*2;
      const tDist=180+Math.random()*160;
      boss.x=clamp(tp.x+Math.cos(tAngle)*tDist,-MAP+80,MAP-80);
      boss.y=clamp(tp.y+Math.sin(tAngle)*tDist,-MAP+80,MAP-80);
      const burstCount=phase2?16:10;
      for(let i=0;i<burstCount;i++){
        const ba=(i/burstCount)*Math.PI*2;
        const pid=`p${room.projId++}`;
        room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,
          vx:Math.cos(ba)*8.45,vy:Math.sin(ba)*8.45,dmg:boss.dmg*0.6,ttl:140};
      }
      if(phase2){
        alive.slice(0,2).forEach((p,i)=>{
          setTimeout(()=>{
            if(!room.boss||!rooms[room.id])return;
            const b=room.boss;
            const ang=Math.atan2(p.y-b.y,p.x-b.x);
            const pid=`p${room.projId++}`;
            room.projectiles[pid]={id:pid,x:b.x,y:b.y,
              vx:Math.cos(ang)*7.15,vy:Math.sin(ang)*7.15,dmg:b.dmg*0.85,ttl:220,homing:p.id};
          },300+i*220);
        });
      }
      io.to(room.id).emit('bossAction',{type:'teleport',x:boss.x,y:boss.y});
    }

    // 별모양 버스트: phase2에서 5.5초마다 3웨이브 12방향
    if(phase2&&(!boss.lastStar||now-boss.lastStar>5500)){
      boss.lastStar=now;
      boss.starRot=(boss.starRot||0);
      for(let wave=0;wave<3;wave++){
        setTimeout(()=>{
          if(!room.boss||!rooms[room.id])return;
          const b=room.boss;
          for(let i=0;i<12;i++){
            const a=(i/12)*Math.PI*2+b.starRot+wave*0.22;
            const pid=`p${room.projId++}`;
            room.projectiles[pid]={id:pid,x:b.x,y:b.y,
              vx:Math.cos(a)*11.05,vy:Math.sin(a)*11.05,dmg:b.dmg*0.58,ttl:155};
          }
        },wave*380);
      }
      boss.starRot+=Math.PI/10;
      io.to(room.id).emit('bossAction',{type:'spin',x:boss.x,y:boss.y});
    }

    // 근접 타격 (쿨 단축)
    if(d<75&&(!boss.lastMelee||now-boss.lastMelee>850)){
      boss.lastMelee=now;
      damagePlayer(room,target,boss.dmg*1.1);
      io.to(room.id).emit('bossAction',{type:'melee',x:boss.x,y:boss.y});
    }
  },

  cross(room, boss, alive, now) {
    if(tickGroggy(room, boss, now)) return;
    const target=alive.reduce((a,b)=>dist(a,boss)<dist(b,boss)?a:b);
    const dx=target.x-boss.x,dy=target.y-boss.y,d=Math.hypot(dx,dy);
    const [nx,ny]=norm(dx,dy);
    const phase2=boss.hp<boss.maxHp*0.45;

    if(!boss.isCharging&&d>90){boss.x+=nx*boss.speed*1.3;boss.y+=ny*boss.speed*1.3;}
    if(d<90&&(!boss.lastMelee||now-boss.lastMelee>850)){
      boss.lastMelee=now;
      damagePlayer(room,target,boss.dmg*1.2);
      io.to(room.id).emit('bossAction',{type:'melee',x:boss.x,y:boss.y});
    }

    // 검기 날리기: 부채꼴 동기 생성 (setTimeout 제거 — 동기화 버그 수정)
    const beamCD=phase2?1200:2200;
    if(!boss.lastBeam||now-boss.lastBeam>beamCD){
      boss.lastBeam=now;
      const targets=phase2?alive:[target];
      targets.forEach(tgt=>{
        const baseAng=Math.atan2(tgt.y-boss.y,tgt.x-boss.x);
        const beamCount=phase2?5:3;
        const spread=phase2?0.22:0.15;
        for(let i=0;i<beamCount;i++){
          const ang=baseAng+(i-(beamCount-1)/2)*spread;
          const pid=`p${room.projId++}`;
          room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,
            vx:Math.cos(ang)*22.1,vy:Math.sin(ang)*22.1,dmg:boss.dmg*0.88,ttl:220};
        }
      });
      // 2페이즈: 회전 12방향 검기 추가
      if(phase2){
        boss.crossRot=(boss.crossRot||0)+Math.PI/8;
        for(let i=0;i<12;i++){
          const a=(i/12)*Math.PI*2+boss.crossRot;
          const pid=`p${room.projId++}`;
          room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,
            vx:Math.cos(a)*15.6,vy:Math.sin(a)*15.6,dmg:boss.dmg*0.62,ttl:200};
        }
      }
      io.to(room.id).emit('bossAction',{type:'cross',x:boss.x,y:boss.y,phase:phase2?2:1});
    }

    // 회전 칼날 패턴: 4방향 × 4웨이브 동기 생성
    const rotCD=phase2?3500:6000;
    if(!boss.lastRot||now-boss.lastRot>rotCD){
      boss.lastRot=now;
      boss.rotBase=(boss.rotBase||0);
      for(let wave=0;wave<4;wave++){
        for(let i=0;i<4;i++){
          const a=(i/4)*Math.PI*2+boss.rotBase+wave*0.18;
          const pid=`p${room.projId++}`;
          room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,
            vx:Math.cos(a)*13,vy:Math.sin(a)*13,dmg:boss.dmg*0.72,ttl:185};
        }
      }
      boss.rotBase+=Math.PI/5;
      io.to(room.id).emit('bossAction',{type:'cross',x:boss.x,y:boss.y,phase:0});
    }

    // 차지: 더 자주, 더 빠르게, 경로상 모든 플레이어 타격
    const chargeCD=phase2?1900:2800;
    if(!boss.lastCharge||now-boss.lastCharge>chargeCD){
      boss.lastCharge=now;
      const t2=alive[Math.floor(Math.random()*alive.length)];
      const tx=t2.x,ty=t2.y;
      io.to(room.id).emit('bossAction',{type:'charge_warn',tx,ty,delay:0});
      setTimeout(()=>{
        if(!room.boss||!rooms[room.id])return;
        const b=room.boss;
        b.isCharging=true;
        const [cx,cy]=norm(tx-b.x,ty-b.y);
        let ticks=0;
        const iv=setInterval(()=>{
          if(!room.boss||ticks++>24){if(room.boss)room.boss.isCharging=false;clearInterval(iv);return;}
          room.boss.x+=cx*21;room.boss.y+=cy*21;
          room.boss.x=clamp(room.boss.x,-MAP,MAP);room.boss.y=clamp(room.boss.y,-MAP,MAP);
          alive.forEach(p=>{if(dist(p,room.boss)<65)damagePlayer(room,p,room.boss.dmg*1.55);});
        },40);
      },750);
    }
  },

  berserk(room, boss, alive, now) {
    if(tickGroggy(room, boss, now)) return;
    const target=alive.reduce((a,b)=>dist(a,boss)<dist(b,boss)?a:b);
    const dx=target.x-boss.x,dy=target.y-boss.y,d=Math.hypot(dx,dy);
    const [nx,ny]=norm(dx,dy);
    const phase2=boss.hp<boss.maxHp*0.4;
    const phase3=boss.hp<boss.maxHp*0.2;

    if(!boss.p2ann&&phase2){boss.p2ann=true;io.to(room.id).emit('bossAction',{type:'berserk'});}
    if(!boss.p3ann&&phase3){boss.p3ann=true;io.to(room.id).emit('bossAction',{type:'berserk3'});}

    const spd=phase3?boss.speed*3.5:phase2?boss.speed*2.5:boss.speed*1.5;
    if(d>65){boss.x+=nx*spd;boss.y+=ny*spd;}
    else{
      const cd=phase3?200:phase2?450:900;
      if(!boss.lastMelee||now-boss.lastMelee>cd){
        boss.lastMelee=now;
        const mult=phase3?2.5:phase2?1.8:1.2;
        damagePlayer(room,target,boss.dmg*mult);
        // 2페이즈+: 주변 플레이어도 광역 타격
        if(phase2){
          alive.forEach(p=>{if(p!==target&&dist(p,boss)<110)damagePlayer(room,p,boss.dmg*0.75);});
        }
        io.to(room.id).emit('bossAction',{type:'melee',x:boss.x,y:boss.y});
      }
    }

    // 산탄 강화 (더 넓고 빠르게)
    const shotCD=phase3?700:phase2?1000:1800;
    if(!boss.lastShot||now-boss.lastShot>shotCD){
      boss.lastShot=now;
      const ang=Math.atan2(dy,dx);
      const count=phase3?16:phase2?10:6;
      const spread=phase3?Math.PI*1.5:phase2?Math.PI*1.1:Math.PI*0.7;
      for(let i=0;i<count;i++){
        const a=ang+(i/(count-1)-0.5)*spread;
        const spd2=phase3?11.05:phase2?9.1:7.8;
        const pid=`p${room.projId++}`;
        room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,vx:Math.cos(a)*spd2,vy:Math.sin(a)*spd2,dmg:boss.dmg*0.62,ttl:130};
      }
      io.to(room.id).emit('bossAction',{type:'spread',x:boss.x,y:boss.y});
    }

    // 회전 스핀 공격: 주기적 전방위 버스트
    const spinCD=phase2?3000:5000;
    if(!boss.lastSpin||now-boss.lastSpin>spinCD){
      boss.lastSpin=now;
      const waves=phase3?3:2;
      for(let w=0;w<waves;w++){
        setTimeout(()=>{
          if(!room.boss||!rooms[room.id])return;
          const b=room.boss;
          const wCount=phase3?24:16;
          for(let i=0;i<wCount;i++){
            const a=(i/wCount)*Math.PI*2+w*(Math.PI/wCount);
            const pid=`p${room.projId++}`;
            room.projectiles[pid]={id:pid,x:b.x,y:b.y,
              vx:Math.cos(a)*9.75,vy:Math.sin(a)*9.75,dmg:b.dmg*0.58,ttl:140};
          }
        },w*480);
      }
      io.to(room.id).emit('bossAction',{type:'berserk',x:boss.x,y:boss.y});
    }

    // 3페이즈 전용: 지뢰 설치 (느린 투사체, 오래 지속)
    if(phase3&&(!boss.lastMine||now-boss.lastMine>2200)){
      boss.lastMine=now;
      for(let i=0;i<5;i++){
        const a=(i/5)*Math.PI*2+Math.random()*0.4;
        const pid=`p${room.projId++}`;
        room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,
          vx:Math.cos(a)*3.25,vy:Math.sin(a)*3.25,dmg:boss.dmg*1.15,ttl:420};
      }
    }
  },

  final(room, boss, alive, now) {
    if(tickGroggy(room, boss, now)) return;
    const target=alive.reduce((a,b)=>dist(a,boss)<dist(b,boss)?a:b);
    const dx=target.x-boss.x,dy=target.y-boss.y,d=Math.hypot(dx,dy);
    const [nx,ny]=norm(dx,dy);
    const phase=boss.hp>boss.maxHp*0.65?1:boss.hp>boss.maxHp*0.35?2:3;

    if(!boss.ph2ann&&phase>=2){boss.ph2ann=true;io.to(room.id).emit('bossAction',{type:'phase',n:2});}
    if(!boss.ph3ann&&phase>=3){boss.ph3ann=true;io.to(room.id).emit('bossAction',{type:'phase',n:3});}

    const spd=boss.speed*(0.85+phase*0.5);
    if(!boss.isCharging&&d>75){boss.x+=nx*spd;boss.y+=ny*spd;}
    if(d<75&&(!boss.lastMelee||now-boss.lastMelee>Math.max(250,900/phase))){
      boss.lastMelee=now;
      damagePlayer(room,target,boss.dmg*(1+(phase-1)*0.5));
      if(phase>=2){
        alive.forEach(p=>{if(p!==target&&dist(p,boss)<100)damagePlayer(room,p,boss.dmg*0.75);});
      }
      io.to(room.id).emit('bossAction',{type:'melee',x:boss.x,y:boss.y});
    }

    // 삼중 스파이럴 (phase1부터, phase마다 arm 추가)
    const spiralCD=phase>=3?120:phase>=2?175:260;
    if(!boss.lastSpiral||now-boss.lastSpiral>spiralCD){
      boss.lastSpiral=now;
      boss.spiralAngle=(boss.spiralAngle||0)+(phase>=3?0.65:phase>=2?0.5:0.4);
      const arms=phase>=3?3:phase>=2?2:1;
      for(let arm=0;arm<arms;arm++){
        const a=boss.spiralAngle+arm*(Math.PI*2/arms);
        const pid=`p${room.projId++}`;
        room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,
          vx:Math.cos(a)*(6.5+phase)*1.3,vy:Math.sin(a)*(6.5+phase)*1.3,dmg:boss.dmg*0.52,ttl:145};
      }
    }

    // 유도탄 (phase1부터 존재, 점점 강화)
    const homingCD=phase>=3?1400:phase>=2?2000:3200;
    if(!boss.lastHoming||now-boss.lastHoming>homingCD){
      boss.lastHoming=now;
      const cnt=phase>=3?10:phase>=2?6:3;
      for(let i=0;i<cnt;i++){
        const t2=alive[i%alive.length];
        setTimeout(()=>{
          if(!room.boss||!rooms[room.id])return;
          const b=room.boss;
          const ang=Math.atan2(t2.y-b.y,t2.x-b.x);
          const pid=`p${room.projId++}`;
          const spd2=phase>=3?9.1:7.15;
          room.projectiles[pid]={id:pid,x:b.x,y:b.y,
            vx:Math.cos(ang)*spd2,vy:Math.sin(ang)*spd2,
            dmg:b.dmg*(phase>=3?0.92:0.72),ttl:175,homing:t2.id};
        },i*175);
      }
      io.to(room.id).emit('bossAction',{type:'homing_warn',x:boss.x,y:boss.y});
    }

    // 2페이즈+: 산탄 추가
    if(phase>=2&&(!boss.lastShot||now-boss.lastShot>(phase>=3?1000:1900))){
      boss.lastShot=now;
      const ang=Math.atan2(dy,dx);
      const count=phase>=3?14:8;
      const spread=phase>=3?Math.PI*1.1:Math.PI*0.8;
      for(let i=0;i<count;i++){
        const a=ang+(i/(count-1)-0.5)*spread;
        const pid=`p${room.projId++}`;
        room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,
          vx:Math.cos(a)*9.75,vy:Math.sin(a)*9.75,dmg:boss.dmg*0.62,ttl:135};
      }
      io.to(room.id).emit('bossAction',{type:'spread',x:boss.x,y:boss.y});
    }

    // 3페이즈: 16방향 2웨이브 버스트 + 차지
    if(phase>=3){
      if(!boss.lastCross||now-boss.lastCross>1800){
        boss.lastCross=now;
        boss.crossRot=(boss.crossRot||0)+Math.PI/8;
        for(let w=0;w<2;w++){
          setTimeout(()=>{
            if(!room.boss||!rooms[room.id])return;
            const b=room.boss;
            for(let i=0;i<16;i++){
              const a=(i/16)*Math.PI*2+b.crossRot+w*(Math.PI/16);
              const pid=`p${room.projId++}`;
              room.projectiles[pid]={id:pid,x:b.x,y:b.y,
                vx:Math.cos(a)*11.7,vy:Math.sin(a)*11.7,dmg:b.dmg*0.68,ttl:135};
            }
          },w*380);
        }
        io.to(room.id).emit('bossAction',{type:'spin',x:boss.x,y:boss.y});
      }
      if(!boss.lastCharge||now-boss.lastCharge>2500){
        boss.lastCharge=now;
        const t2=alive[Math.floor(Math.random()*alive.length)];
        const tx=t2.x,ty=t2.y;
        io.to(room.id).emit('bossAction',{type:'charge_warn',tx,ty,delay:0});
        setTimeout(()=>{
          if(!room.boss||!rooms[room.id])return;
          const b=room.boss;
          b.isCharging=true;
          const [cx,cy]=norm(tx-b.x,ty-b.y);
          let ticks=0;
          const iv=setInterval(()=>{
            if(!room.boss||ticks++>26){if(room.boss)room.boss.isCharging=false;clearInterval(iv);return;}
            room.boss.x+=cx*16;room.boss.y+=cy*16;
            room.boss.x=clamp(room.boss.x,-MAP,MAP);room.boss.y=clamp(room.boss.y,-MAP,MAP);
            alive.forEach(p=>{if(dist(p,room.boss)<62)damagePlayer(room,p,room.boss.dmg*1.85);});
          },40);
        },700);
      }
    }
  }
};

// ===== 유틸 =====

function reviveDead(room) {
  Object.values(room.players).forEach(p=>{
    if(p.hp<=0){
      p.hp=Math.floor(p.maxHp*0.5);
      io.to(room.id).emit('playerRevived',{playerId:p.id,hp:p.hp,maxHp:p.maxHp});
    }
  });
}

function onBossDead(room) {
  // 기믹 상태 정리
  room.pillars=null; room.soulFragments=null;
  room.neutralGauge=0; room.neutralMult=0; room.neutralDeadline=null;
  reviveDead(room);
  room.boss=null; room.projectiles={}; room.projId=0;
  io.to(room.id).emit('bossDead',{stage:room.stage+1});
  io.to(room.id).emit('clearAllProjectiles');
  const node=room.mapNodes&&room.mapNodes.find(n=>n.id===room.currentNodeId);
  if(node)node.cleared=true;
  if(room.stage>=STAGE_CONFIG.length-1){
    setTimeout(()=>{room.state='game_clear';io.to(room.id).emit('gameClear');},2500);
  } else {
    setTimeout(()=>{
      room.stage++;
      room.mapNodes=generateMap(); room.currentNodeId=0;
      room.state='map';
      io.to(room.id).emit('stageCleared',{nextStage:room.stage+1});
      setTimeout(()=>io.to(room.id).emit('mapState',{nodes:room.mapNodes,currentNodeId:0,stage:room.stage+1}),3200);
    },2500);
  }
}

// ===== AI 루프 =====
setInterval(()=>{
  const now=Date.now();
  Object.values(rooms).forEach(room=>{
    const alive=Object.values(room.players).filter(p=>p.hp>0);

    // 재생
    room._rt=(room._rt||0)+50;
    if(room._rt>=3000){
      room._rt=0;
      alive.forEach(p=>{
        if(p.regenRate){p.hp=Math.min(p.maxHp,p.hp+p.regenRate);
          io.to(room.id).emit('playerHealthUpdate',{playerId:p.id,hp:Math.floor(p.hp),maxHp:p.maxHp});}
      });
    }

    if(alive.length===0&&Object.keys(room.players).length>0&&
       (room.state==='room_mob'||room.state==='boss')){
      room.state='game_over'; io.to(room.id).emit('gameOver'); return;
    }

    // 투사체
    if(room.projectiles&&(room.state==='room_mob'||room.state==='boss')){
      const dead=[];
      Object.values(room.projectiles).forEach(proj=>{
        // 유도탄 조향
        if(proj.homing){
          const pt=alive.find(p=>p.id===proj.homing)||alive[0];
          if(pt){
            const [hx,hy]=norm(pt.x-proj.x,pt.y-proj.y);
            proj.vx=proj.vx*0.94+hx*0.4; proj.vy=proj.vy*0.94+hy*0.4;
            const spd=Math.hypot(proj.vx,proj.vy);
            if(spd>6.5){proj.vx=(proj.vx/spd)*6.5;proj.vy=(proj.vy/spd)*6.5;}
          }
        }
        proj.x+=proj.vx; proj.y+=proj.vy;
        if(--proj.ttl<=0||Math.abs(proj.x)>MAP+200||Math.abs(proj.y)>MAP+200){dead.push(proj.id);return;}
        // 배리어 충돌 — 투사체 차단
        if(room.barriers){
          for(const bar of room.barriers){
            if(dist(proj,bar)<250){dead.push(proj.id);io.to(room.id).emit('projDestroy',proj.id);return;}
          }
        }
        alive.forEach(p=>{
          if(proj.hit?.has(p.id))return;
          if(dist(proj,p)<22){
            (proj.hit||(proj.hit=new Set())).add(p.id);
            damagePlayer(room,p,proj.dmg);
            dead.push(proj.id);
          }
        });
      });
      dead.forEach(id=>{delete room.projectiles[id];io.to(room.id).emit('projDestroy',id);});
      if(Object.keys(room.projectiles).length>0)
        io.to(room.id).emit('projUpdate',room.projectiles);
    }

    // 일반 웨이브 AI
    if(room.state==='room_mob'){
      Object.values(room.enemies).forEach(enemy=>{
        if(alive.length===0)return;
        let target=alive.find(p=>p.role==='tanker'&&dist(p,enemy)<400)
          ||alive.reduce((a,b)=>dist(a,enemy)<dist(b,enemy)?a:b);
        if(!target)return;

        // 배리어 체크
        let blocked=false;
        if(room.barriers){
          room.barriers.forEach(bar=>{
            if(dist(enemy,bar)<250){
              const [bx,by]=norm(enemy.x-bar.x,enemy.y-bar.y);
              enemy.x+=bx*3; enemy.y+=by*3; blocked=true;
            }
          });
        }
        if(blocked)return;

        const dx=target.x-enemy.x,dy=target.y-enemy.y,d=Math.hypot(dx,dy);
        const [nx,ny]=norm(dx,dy);

        if(enemy.type==='melee'){
          if(enemy.isCharging)return;
          // 5초마다 짧은 돌진
          if(d>80&&d<500&&(!enemy.lastCharge||now-enemy.lastCharge>5000)){
            enemy.lastCharge=now; enemy.isCharging=true;
            const [cx,cy]=[nx,ny];
            io.to(room.id).emit('enemyCharge',{id:enemy.id,x:enemy.x,y:enemy.y});
            let ct=0;
            const iv=setInterval(()=>{
              const e2=room.enemies&&room.enemies[enemy.id];
              if(!rooms[room.id]||!e2||ct++>10){if(e2)e2.isCharging=false;clearInterval(iv);return;}
              e2.x=clamp(e2.x+cx*15,-MAP+30,MAP-30);
              e2.y=clamp(e2.y+cy*15,-MAP+30,MAP-30);
              Object.values(room.players).forEach(p=>{
                if(p.hp>0&&dist(p,e2)<48)damagePlayer(room,p,enemy.dmg*1.3);
              });
            },40);
          } else if(d<45){
            if(!enemy.lastAtk||now-enemy.lastAtk>1200){
              enemy.lastAtk=now;
              damagePlayer(room,target,enemy.dmg);
              io.to(room.id).emit('enemyAttack',{id:enemy.id,x:enemy.x,y:enemy.y});
            }
          } else {
            enemy.x+=nx*enemy.speed; enemy.y+=ny*enemy.speed;
            enemy.x=clamp(enemy.x,-MAP+30,MAP-30); enemy.y=clamp(enemy.y,-MAP+30,MAP-30);
          }
        } else if(enemy.type==='elite'){
          if(enemy.isCharging)return;
          // 거리 유지 후 원거리 공격
          const keepE=280;
          if(d>keepE){enemy.x+=nx*enemy.speed;enemy.y+=ny*enemy.speed;}
          else if(d<keepE-80){enemy.x-=nx*enemy.speed;enemy.y-=ny*enemy.speed;}
          enemy.x=clamp(enemy.x,-MAP+30,MAP-30); enemy.y=clamp(enemy.y,-MAP+30,MAP-30);
          // 3방향 원거리 공격
          if(!enemy.lastAtk||now-enemy.lastAtk>1800){
            enemy.lastAtk=now;
            for(let s=-1;s<=1;s++){
              const ang=Math.atan2(dy,dx)+s*0.2;
              const pid=`p${room.projId++}`;
              room.projectiles[pid]={id:pid,x:enemy.x,y:enemy.y,
                vx:Math.cos(ang)*7.15,vy:Math.sin(ang)*7.15,dmg:enemy.dmg,ttl:155};
              // 실제 pid로 emit — 클라이언트가 projDestroy로 정상 제거
              io.to(room.id).emit('enemyShoot',{id:pid,x:enemy.x,y:enemy.y,
                vx:Math.cos(ang)*7.15,vy:Math.sin(ang)*7.15});
            }
          }
          // 차지 (5초마다)
          if(!enemy.lastCharge||now-enemy.lastCharge>5000){
            enemy.lastCharge=now;
            enemy.isCharging=true;
            const [cx,cy]=[nx,ny];
            io.to(room.id).emit('eliteCharge',{id:enemy.id,tx:target.x,ty:target.y});
            let ticks=0;
            const iv=setInterval(()=>{
              const e2=room.enemies&&room.enemies[enemy.id];
              if(!rooms[room.id]||!e2||ticks++>20){if(e2)e2.isCharging=false;clearInterval(iv);return;}
              e2.x=clamp(e2.x+cx*18,-MAP+30,MAP-30);
              e2.y=clamp(e2.y+cy*18,-MAP+30,MAP-30);
              Object.values(room.players).forEach(p=>{
                if(p.hp>0&&dist(p,e2)<55)damagePlayer(room,p,enemy.dmg*1.6);
              });
            },40);
          }
        } else {
          const keep=260;
          if(d>keep){enemy.x+=nx*enemy.speed;enemy.y+=ny*enemy.speed;}
          else if(d<keep-60){enemy.x-=nx*enemy.speed;enemy.y-=ny*enemy.speed;}
          enemy.x=clamp(enemy.x,-MAP+30,MAP-30); enemy.y=clamp(enemy.y,-MAP+30,MAP-30);
          if(!enemy.lastAtk||now-enemy.lastAtk>2200){
            enemy.lastAtk=now;
            const pid=`p${room.projId++}`;
            room.projectiles[pid]={id:pid,x:enemy.x,y:enemy.y,vx:nx*5.85,vy:ny*5.85,dmg:enemy.dmg,ttl:140};
            io.to(room.id).emit('enemyShoot',{id:pid,x:enemy.x,y:enemy.y,vx:nx*5.85,vy:ny*5.85});
          }
          // 10초마다 현위치 400px 이내 순간이동
          if(!enemy.lastTele||now-enemy.lastTele>10000){
            enemy.lastTele=now;
            const ta=Math.random()*Math.PI*2, tr=100+Math.random()*300;
            enemy.x=clamp(enemy.x+Math.cos(ta)*tr,-MAP+30,MAP-30);
            enemy.y=clamp(enemy.y+Math.sin(ta)*tr,-MAP+30,MAP-30);
            io.to(room.id).emit('enemyTele',{id:enemy.id,x:enemy.x,y:enemy.y});
          }
        }

        // ── 분리 행동: 적끼리 겹침 방지 ──
        const SEP_RADIUS=42;
        let sepX=0,sepY=0;
        Object.values(room.enemies).forEach(other=>{
          if(other.id===enemy.id)return;
          const sd=dist(enemy,other);
          if(sd<SEP_RADIUS&&sd>0){
            const [sx,sy]=norm(enemy.x-other.x,enemy.y-other.y);
            const force=(SEP_RADIUS-sd)/SEP_RADIUS;
            sepX+=sx*force*5;
            sepY+=sy*force*5;
          }
        });
        if(sepX!==0||sepY!==0){
          enemy.x=clamp(enemy.x+sepX,-MAP+30,MAP-30);
          enemy.y=clamp(enemy.y+sepY,-MAP+30,MAP-30);
        }
      });
      io.to(room.id).emit('enemyUpdate',room.enemies);

      if(room.waveTotal>0&&room.waveKilled>=room.waveTotal&&Object.keys(room.enemies).length===0)
        onMobRoomClear(room);
    }

    // 보스 AI
    if(room.state==='boss'&&room.boss&&alive.length>0){
      const boss=room.boss;
      const fn=BOSS_AI[boss.pattern];
      if(fn) fn(room,boss,alive,now);
      boss.x=clamp(boss.x,-MAP,MAP); boss.y=clamp(boss.y,-MAP,MAP);
      io.to(room.id).emit('bossUpdate',{x:boss.x,y:boss.y,hp:boss.hp,maxHp:boss.maxHp});
    }

    // 배리어 만료
    if(room.barriers){
      const t=Date.now();
      room.barriers=room.barriers.filter(b=>{
        if(b.expires<t){io.to(room.id).emit('barrierRemoved',b.id);return false;}
        return true;
      });
    }
  });
},50);

// ===== 소켓 =====
io.on('connection',socket=>{
  socket.on('getRooms',()=>socket.emit('roomList',
    Object.values(rooms).filter(r=>r.state==='lobby'&&Object.keys(r.players).length<4)
      .map(r=>({id:r.id,count:Object.keys(r.players).length}))));

  socket.on('createRoom',()=>{
    let id;
    do{id=Math.random().toString(36).substring(2,7).toUpperCase();}while(rooms[id]);
    rooms[id]={id,players:{},state:'lobby',stage:0,wave:0,enemies:{},boss:null,
               projectiles:{},projId:0,upgradeVotes:{},waveTotal:0,waveKilled:0,_rt:0,barriers:[]};
    doJoin(socket,id); socket.emit('roomCreated',id);
  });

  socket.on('joinRoom',roomId=>{
    const room=rooms[roomId];
    if(!room)return socket.emit('joinError','존재하지 않는 방');
    if(room.state!=='lobby')return socket.emit('joinError','이미 게임 중');
    if(Object.keys(room.players).length>=4)return socket.emit('joinError','방이 꽉 찼습니다');
    doJoin(socket,roomId);
  });

  function doJoin(socket,roomId){
    socket.join(roomId); socket.roomId=roomId;
    const room=rooms[roomId];
    room.players[socket.id]={id:socket.id,roomId,x:Math.random()*200-100,y:Math.random()*200-100,
      role:null,ready:false,hp:100,maxHp:100,damageMult:1,defenseMult:1,speedMult:1,skillMult:1,
      cdMult:1,aspdMult:1,regenRate:0,invincible:false,
      xp:0,level:1,pendingUpgrades:0,inventory:[],equipped:{},
      equipDmg:1,equipDef:1,equipSpeed:1,equipHeal:1,equipHealR:1,equipRange:1};
    io.to(roomId).emit('lobbyUpdate',getLobbyState(room));
  }

  socket.on('selectRole',data=>{
    const room=rooms[socket.roomId];if(!room||room.state!=='lobby')return;
    const role=typeof data==='string'?data:data.role;
    const name=typeof data==='object'?((data.name||'').trim().slice(0,10)||'영혼'):'영혼';
    room.players[socket.id].role=role;
    room.players[socket.id].name=name;
    io.to(socket.roomId).emit('lobbyUpdate',getLobbyState(room));
  });

  socket.on('setReady',ready=>{
    const room=rooms[socket.roomId];if(!room||room.state!=='lobby')return;
    const p=room.players[socket.id];if(!p.role)return;
    p.ready=ready;
    io.to(socket.roomId).emit('lobbyUpdate',getLobbyState(room));
    const ps=Object.values(room.players);
    if(ps.length>0&&ps.every(p=>p.ready&&p.role))startGame(room);
  });

  socket.on('playerMovement',data=>{
    const room=rooms[socket.roomId];if(!room)return;
    const p=room.players[socket.id];
    if(p){p.x=data.x;p.y=data.y;}
    socket.to(socket.roomId).emit('playerMoved',{playerId:socket.id,x:data.x,y:data.y});
  });

  socket.on('hitEnemy',data=>{
    const room=rooms[socket.roomId];if(!room)return;
    const me=room.players[socket.id];if(!me)return;
    const dmg=data.damage*(me.damageMult||1)*(me.skillMult||1)*(me.equipDmg||1);

    if(room.state==='room_mob'&&room.enemies[data.enemyId]){
      const e=room.enemies[data.enemyId];
      e.hp-=dmg;
      if(e.hp<=0){
        const xpGain=e.type==='melee'?5:e.type==='elite'?20:7;
        delete room.enemies[data.enemyId]; room.waveKilled++;
        io.to(room.id).emit('enemyDeath',data.enemyId);
        // 경험치 지급 (레벨당 필요 XP 20% 증가)
        Object.values(room.players).forEach(p=>{
          if(p.hp<=0)return;
          const prev=getPlayerLevel(p.xp||0);
          p.xp=(p.xp||0)+xpGain;
          const cur=getPlayerLevel(p.xp);
          io.to(p.id).emit('xpUpdate',{xp:cur.xpInLevel,level:cur.lv,xpMax:cur.xpMax});
          if(cur.lv>prev.lv){
            p.level=cur.lv;
            p.damageMult=(p.damageMult||1)*1.02;
            p.defenseMult=(p.defenseMult||1)*0.97;
            io.to(p.id).emit('levelUpAuto',{level:p.level});
            emitStats(room,p);
          }
        });
      }
    }
    if((room.state==='boss'||room.state==='playing')&&room.boss&&data.enemyId==='boss'){
      const boss=room.boss;
      const groggyMult=boss.groggy?1.5:1;
      // 스턴 중 피해 50% 증가
      const stunMult=boss.stunned?1.5:1.0;
      // 기믹 미해결 시 피해 90% 감소
      const mechBlock=(boss.phase2Triggered&&!room.phase2MechanicSolved)||
                      (boss.phase3Triggered&&!room.phase3MechanicSolved);
      const blockMult=mechBlock?0.1:1.0;
      const fullDmg=dmg*groggyMult*stunMult;
      boss.hp=Math.max(0,boss.hp-fullDmg*blockMult);
      // 3페이즈: 무력화 게이지 충전
      if(boss.phase3Triggered&&!room.phase3MechanicSolved&&!room.phase3Failed){
        room.neutralGauge=Math.min(100,(room.neutralGauge||0)+fullDmg*(room.neutralMult||0)*0.05);
        if(room.neutralGauge>=100){
          room.phase3MechanicSolved=true;
          io.to(room.id).emit('bossAction',{type:'mechanic3_solved'});
        }
      }
      if(boss.hp<=0)onBossDead(room);
    }
  });

  socket.on('healPlayer',data=>{
    const room=rooms[socket.roomId];if(!room)return;
    const me=room.players[socket.id];
    const amt=(data.amount||12)*(me.skillMult||1)*(me.equipHeal||1);
    const targets=data.targetId?[room.players[data.targetId]]:Object.values(room.players).filter(p=>p.hp>0);
    targets.forEach(t=>{
      if(!t||t.hp>=t.maxHp)return;
      t.hp=Math.min(t.maxHp,t.hp+amt);
      io.to(room.id).emit('playerHealthUpdate',{playerId:t.id,hp:Math.floor(t.hp),maxHp:t.maxHp});
    });
  });

  socket.on('useSkill',data=>{
    socket.to(socket.roomId).emit('skillUsed',data);
    // 힐러 무적
    if(data.type==='healer_invincible'){
      const room=rooms[socket.roomId];if(!room)return;
      Object.values(room.players).forEach(p=>{
        p.invincible=true;
        setTimeout(()=>{p.invincible=false;},5000);
      });
      io.to(room.id).emit('partyInvincible',{duration:5000});
      // 1초마다 HP 2 회복 (5회)
      for(let i=1;i<=5;i++){
        setTimeout(()=>{
          if(!rooms[room.id])return;
          Object.values(room.players).forEach(p=>{
            if(p.hp>0){p.hp=Math.min(p.maxHp,p.hp+2);
              io.to(room.id).emit('playerHealthUpdate',{playerId:p.id,hp:Math.floor(p.hp),maxHp:p.maxHp});}
          });
        },i*1000);
      }
    }
    // 탱커 배리어
    if(data.type==='tanker_barrier'){
      const room=rooms[socket.roomId];if(!room)return;
      const bid=`bar${Date.now()}`;
      room.barriers=room.barriers||[];
      room.barriers.push({id:bid,x:data.x,y:data.y,expires:Date.now()+5000});
      io.to(room.id).emit('barrierPlaced',{id:bid,x:data.x,y:data.y,duration:5000});
    }
  });

  socket.on('selectUpgrade',upgradeId=>{
    const room=rooms[socket.roomId];if(!room)return;
    const p=room.players[socket.id];if(!p)return;
    if(upgradeId!=='skip'){
      const up=UPGRADES.find(u=>u.id===upgradeId);if(!up)return;
      up.apply(p);
      io.to(room.id).emit('playerHealthUpdate',{playerId:p.id,hp:Math.floor(p.hp),maxHp:p.maxHp});
      emitStats(room,p);
    }
    // 영혼의 성장 방 투표 처리
    if(room.state==='room_upgrade'){
      room.roomVotes=room.roomVotes||{};
      if(!room.roomVotes[socket.id]){
        room.roomVotes[socket.id]=upgradeId;
        checkUpgradeRoomDone(room);
      }
    }
  });

  // ===== 장비 장착/해제 =====
  socket.on('equipItem',({itemId})=>{
    const room=rooms[socket.roomId];if(!room)return;
    const p=room.players[socket.id];if(!p)return;
    const inv=p.inventory||[];
    const idx=inv.findIndex(i=>i.id===itemId);if(idx===-1)return;
    const item=inv[idx];
    if(item.roles&&!item.roles.includes(p.role))return;
    inv.splice(idx,1);
    const eq=p.equipped=p.equipped||{};
    if(eq[item.type]){
      const old=ITEMS_LIST.find(i=>i.id===eq[item.type]);
      if(old&&inv.length<9)inv.push(old);
    }
    eq[item.type]=item.id; p.inventory=inv;
    applyEquipStats(p); emitStats(room,p);
  });

  socket.on('unequipItem',(slot)=>{
    const room=rooms[socket.roomId];if(!room)return;
    const p=room.players[socket.id];if(!p)return;
    const eq=p.equipped=p.equipped||{};if(!eq[slot])return;
    const inv=p.inventory||[];if(inv.length>=9)return;
    const item=ITEMS_LIST.find(i=>i.id===eq[slot]);
    if(item)inv.push(item);
    delete eq[slot]; p.inventory=inv;
    applyEquipStats(p); emitStats(room,p);
  });

  // ===== 맵 방 선택 =====
  socket.on('selectRoom',nodeId=>{
    const room=rooms[socket.roomId];if(!room||room.state!=='map')return;
    const node=room.mapNodes&&room.mapNodes.find(n=>n.id===nodeId);
    if(!node||node.cleared)return;
    const parentOk=room.mapNodes.some(n=>n.cleared&&n.children.includes(nodeId));
    if(!parentOk)return;
    room.currentNodeId=nodeId;
    enterRoom(room,node);
  });

  // ===== 장비 방 아이템 선택 =====
  socket.on('selectEquipItem',itemId=>{
    const room=rooms[socket.roomId];if(!room||room.state!=='room_equip')return;
    if(room.equipVotes[socket.id])return;
    room.equipVotes[socket.id]=itemId||'skip';
    const p=room.players[socket.id];
    if(itemId&&itemId!=='skip'){
      const item=ITEMS_LIST.find(i=>i.id===itemId);
      if(item){
        const inv=p.inventory=p.inventory||[];
        if(inv.length<9){
          inv.push(item);
          const eq=p.equipped=p.equipped||{};
          if(!eq[item.type]&&(!item.roles||item.roles.includes(p.role))){
            eq[item.type]=item.id; applyEquipStats(p);
          }
          emitStats(room,p);
        }
      }
    }
    checkEquipRoomDone(room);
  });

  socket.on('disconnect',()=>{
    const room=rooms[socket.roomId];if(!room)return;
    delete room.players[socket.id];
    io.to(socket.roomId).emit('playerDisconnected',socket.id);
    if(Object.keys(room.players).length===0)delete rooms[socket.roomId];
    else if(room.state==='lobby')io.to(socket.roomId).emit('lobbyUpdate',getLobbyState(room));
    else if(room.state==='room_upgrade')checkUpgradeRoomDone(room);
  });
});

function startGame(room){
  room.state='map'; room.stage=0;
  room.mapNodes=generateMap(); room.currentNodeId=0;
  room.waveTotal=0; room.waveKilled=0; room.equipVotes={};
  Object.values(room.players).forEach(p=>{
    if(p.role==='tanker'){p.maxHp=150;p.hp=150;}
    else if(p.role==='healer'){p.maxHp=80;p.hp=80;}
    else{p.maxHp=100;p.hp=100;}
    p.xp=0;p.level=1;p.pendingUpgrades=0;p.inventory=[];p.equipped={};
    applyEquipStats(p);
  });
  io.to(room.id).emit('gameStart',{
    players:Object.values(room.players).map(p=>({id:p.id,role:p.role,x:p.x,y:p.y,hp:p.hp,maxHp:p.maxHp}))
  });
  setTimeout(()=>io.to(room.id).emit('mapState',{nodes:room.mapNodes,currentNodeId:0,stage:room.stage+1}),1800);
}

// ===== 방 진입 =====
function enterRoom(room,node){
  if(node.type==='equipment')    enterEquipRoom(room,node);
  else if(node.type==='mob')     enterMobRoom(room,node);
  else if(node.type==='boss')    enterBossRoom(room,node);
  else if(node.type==='upgrade') enterUpgradeRoom(room,node);
}

function enterEquipRoom(room,node){
  room.state='room_equip'; room.equipVotes={};
  io.to(room.id).emit('roomEntered',{nodeId:node.id,type:'equipment'});
  Object.values(room.players).forEach(p=>{
    const eligible=ITEMS_LIST.filter(i=>!i.roles||i.roles.includes(p.role));
    const offers=[...eligible].sort(()=>Math.random()-0.5).slice(0,Math.min(3,eligible.length));
    io.to(p.id).emit('equipOffer',{offers:offers.map(i=>({...i}))});
  });
}

function checkEquipRoomDone(room){
  if(Object.keys(room.equipVotes).length>=Object.keys(room.players).length){
    const node=room.mapNodes.find(n=>n.id===room.currentNodeId);
    if(node)node.cleared=true;
    room.state='map';
    io.to(room.id).emit('equipRoomClear');
    setTimeout(()=>io.to(room.id).emit('mapState',{nodes:room.mapNodes,currentNodeId:room.currentNodeId,stage:room.stage+1}),1500);
  }
}

function enterMobRoom(room,node){
  room.state='room_mob';
  io.to(room.id).emit('roomEntered',{nodeId:node.id,type:'mob'});
  const floor=node.floor||1;
  const sc=STAGE_CONFIG[room.stage];
  const wc=sc.waves[Math.min(Math.floor((floor-1)/2),sc.waves.length-1)];
  const mul=1+(floor-1)*0.12;
  const mel=Math.round(wc.melee*mul);
  const rng=Math.round(wc.ranged*mul);
  room.enemies={}; room.projectiles={}; room.projId=0;
  // 층별 엘리트 등장 수 (5층~10층)
  const eliteByFloor={5:1,6:2,7:2,8:2,9:3,10:3};
  const eliteCount=eliteByFloor[floor]||0;
  room.waveTotal=mel+rng+eliteCount; room.waveKilled=0;
  const ps=Object.values(room.players);
  const cx=ps.reduce((s,p)=>s+p.x,0)/(ps.length||1);
  const cy=ps.reduce((s,p)=>s+p.y,0)/(ps.length||1);
  const toSpawn=[];
  for(let i=0;i<mel;i++) toSpawn.push({type:'melee',hp:wc.hp,dmg:wc.dmg,speed:8});
  for(let i=0;i<rng;i++) toSpawn.push({type:'ranged',hp:wc.hp*0.6|0,dmg:wc.dmg*0.8,speed:5});
  for(let i=0;i<eliteCount;i++) toSpawn.push({type:'elite',hp:500,dmg:Math.max(18,wc.dmg*1.5|0),speed:6});
  for(let i=toSpawn.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[toSpawn[i],toSpawn[j]]=[toSpawn[j],toSpawn[i]];}
  io.to(room.id).emit('waveStart',{stage:room.stage+1,wave:1,totalWaves:1,enemies:{}});
  let spawned=0;
  (function spawnBatch(){
    if(!rooms[room.id]||room.state!=='room_mob')return;
    const end=Math.min(spawned+8,toSpawn.length);
    const batch=[];
    for(let i=spawned;i<end;i++){
      const e=toSpawn[i]; const id=`e${gEid++}`;
      const angle=Math.random()*Math.PI*2, r=450+Math.random()*200;
      batch.push({id,type:e.type,
        x:clamp(cx+Math.cos(angle)*r,-MAP+50,MAP-50),
        y:clamp(cy+Math.sin(angle)*r,-MAP+50,MAP-50),
        hp:e.hp,maxHp:e.hp,dmg:e.dmg,speed:e.speed});
    }
    // ① 스폰 경고 (위치+타입 미리 전송)
    io.to(room.id).emit('spawnWarn',batch.map(e=>({id:e.id,type:e.type,x:e.x,y:e.y})));
    // ② 1.5초 후 실제 스폰
    setTimeout(()=>{
      if(!rooms[room.id]||room.state!=='room_mob')return;
      batch.forEach(e=>{ room.enemies[e.id]=e; });
      spawned=end;
      if(spawned<toSpawn.length)setTimeout(spawnBatch,1500);
    },1500);
  })();
}

function onMobRoomClear(room){
  room.waveTotal=0; reviveDead(room);
  room.projectiles={}; room.projId=0;
  io.to(room.id).emit('clearAllProjectiles');
  const node=room.mapNodes.find(n=>n.id===room.currentNodeId);
  if(node)node.cleared=true;
  io.to(room.id).emit('mobRoomClear');
  setTimeout(()=>{
    room.state='map';
    io.to(room.id).emit('mapState',{nodes:room.mapNodes,currentNodeId:room.currentNodeId,stage:room.stage+1});
  },2500);
}

function enterBossRoom(room,node){
  room.state='boss'; room.enemies={}; room.projectiles={}; room.projId=0;
  const bc=STAGE_CONFIG[room.stage].boss;
  room.boss={...bc,maxHp:bc.hp,x:0,y:-400};
  io.to(room.id).emit('roomEntered',{nodeId:node.id,type:'boss'});
  io.to(room.id).emit('bossSpawn',{name:bc.name,hp:bc.hp,maxHp:bc.hp,stage:room.stage+1,isFinal:bc.isFinal||false});
}

function enterUpgradeRoom(room,node){
  room.state='room_upgrade'; room.roomVotes={};
  io.to(room.id).emit('roomEntered',{nodeId:node.id,type:'upgrade'});
  Object.values(room.players).forEach(p=>{
    const opts=[...UPGRADES].sort(()=>Math.random()-0.5).slice(0,3);
    io.to(p.id).emit('upgradeOffer',{upgrades:opts.map(u=>({id:u.id,name:u.name,desc:u.desc}))});
  });
}

function checkUpgradeRoomDone(room){
  if(Object.keys(room.roomVotes||{}).length>=Object.keys(room.players).length){
    const node=room.mapNodes.find(n=>n.id===room.currentNodeId);
    if(node)node.cleared=true;
    room.state='map';
    io.to(room.id).emit('upgRoomClear');
    setTimeout(()=>io.to(room.id).emit('mapState',{nodes:room.mapNodes,currentNodeId:room.currentNodeId,stage:room.stage+1}),1800);
  }
}

const PORT = process.env.PORT || 8081;
server.listen(PORT, ()=>console.log(`서버 실행 중: http://localhost:${PORT}`));
