const express = require('express');
const app = express();
const server = require('http').Server(app);
const io = require('socket.io')(server);
app.use(express.static(__dirname + '/public'));

const MAP = 1100; // 맵 경계 -MAP ~ MAP

const STAGE_CONFIG = [
  { waves:[{melee:36,ranged:10,hp:80,dmg:8},{melee:36,ranged:18,hp:90,dmg:10},{melee:30,ranged:23,hp:100,dmg:12}],
    boss:{name:'안개의 수호자',hp:1800,dmg:18,speed:8.8,pattern:'charge'} },
  { waves:[{melee:26,ranged:23,hp:110,dmg:12},{melee:28,ranged:24,hp:120,dmg:14},{melee:29,ranged:25,hp:130,dmg:16}],
    boss:{name:'심연의 파수꾼',hp:3000,dmg:20,speed:6.0,pattern:'spin'} },
  { waves:[{melee:28,ranged:24,hp:140,dmg:15},{melee:30,ranged:25,hp:150,dmg:18},{melee:32,ranged:26,hp:160,dmg:20}],
    boss:{name:'황혼의 군주',hp:4200,dmg:22,speed:5.5,pattern:'cross'} },
  { waves:[{melee:30,ranged:25,hp:170,dmg:20},{melee:32,ranged:27,hp:180,dmg:22},{melee:34,ranged:28,hp:200,dmg:25}],
    boss:{name:'혼돈의 지배자',hp:5400,dmg:24,speed:7.0,pattern:'berserk'} },
  { waves:[{melee:32,ranged:27,hp:200,dmg:25},{melee:35,ranged:29,hp:220,dmg:28},{melee:38,ranged:30,hp:250,dmg:30}],
    boss:{name:'어둠의 왕',hp:10500,dmg:30,speed:7.5,pattern:'final',isFinal:true} },
];

const UPGRADES = [
  { id:'damage_up',  name:'영혼의 불꽃',   desc:'공격 데미지 +25%',      apply:p=>{p.damageMult=(p.damageMult||1)*1.25;} },
  { id:'hp_up',      name:'생명의 정수',   desc:'최대 HP +40, 즉시 회복', apply:p=>{p.maxHp+=40;p.hp=Math.min(p.hp+40,p.maxHp);} },
  { id:'speed_up',   name:'바람의 발걸음', desc:'이동 속도 +20%',         apply:p=>{p.speedMult=(p.speedMult||1)*1.2;} },
  { id:'defense_up', name:'수호의 갑옷',   desc:'받는 데미지 -20%',       apply:p=>{p.defenseMult=(p.defenseMult||1)*0.8;} },
  { id:'skill_up',   name:'스킬 증폭',     desc:'스킬 데미지 +30%',       apply:p=>{p.skillMult=(p.skillMult||1)*1.3;} },
  { id:'regen',      name:'재생의 결정',   desc:'3초마다 HP 5 회복',      apply:p=>{p.regenRate=(p.regenRate||0)+5;} },
  { id:'heal_burst', name:'치유의 물결',   desc:'즉시 HP 50 회복',        apply:p=>{p.hp=Math.min(p.hp+50,p.maxHp);} },
];

const rooms = {};
let gEid = 0;

function dist(a,b) { return Math.hypot(a.x-b.x,a.y-b.y); }
function norm(dx,dy) { const d=Math.hypot(dx,dy)||1; return [dx/d,dy/d]; }
function clamp(v,mn,mx) { return Math.max(mn,Math.min(mx,v)); }
function getLobbyState(room) {
  return { roomId:room.id, players:Object.values(room.players).map(p=>({id:p.id,role:p.role,ready:p.ready})) };
}

// ===== 대미지 =====
function damagePlayer(room, player, base) {
  if (!player || player.hp<=0 || player.invincible) return;
  // 수호물 내부 무적
  if(room.barriers && room.barriers.length>0){
    for(const bar of room.barriers){if(dist(player,bar)<250)return;}
  }
  const mult = (player.defenseMult||1) * (player.role==='tanker'?0.5:1);
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
    const target = alive.reduce((a,b)=>dist(a,boss)<dist(b,boss)?a:b);
    const dx=target.x-boss.x, dy=target.y-boss.y, d=Math.hypot(dx,dy);
    const [nx,ny]=norm(dx,dy);
    const phase2 = boss.hp < boss.maxHp*0.5;

    // 2페이즈 진입 알림
    if(phase2 && !boss.phase2Announced) {
      boss.phase2Announced = true;
      io.to(room.id).emit('bossAction',{type:'phase2',x:boss.x,y:boss.y});
    }
    // 그로기 (15초마다)
    if(tickGroggy(room, boss, now)) return;

    // 기본 이동
    if (!boss.isCharging && d>80) {
      boss.x+=nx*boss.speed; boss.y+=ny*boss.speed;
    }
    // 근접 공격
    if (d<80 && (!boss.lastMelee||now-boss.lastMelee>1000)) {
      boss.lastMelee=now;
      damagePlayer(room,target,boss.dmg);
      io.to(room.id).emit('bossAction',{type:'melee',x:boss.x,y:boss.y});
    }
    // 차지 공격 — 쿨타임 단축, 돌진 속도 대폭 상승
    if (!boss.isCharging && (!boss.lastCharge||now-boss.lastCharge>(phase2?1400:2200))) {
      boss.lastCharge=now;
      const count = phase2 ? 3 : 1;
      for (let c=0;c<count;c++) {
        const t2 = alive[Math.floor(Math.random()*alive.length)];
        const tx=t2.x, ty=t2.y;
        io.to(room.id).emit('bossAction',{type:'charge_warn',tx,ty,delay:c*2000});
        setTimeout(()=>{
          if(!boss)return;
          boss.isCharging=true;
          const cx=tx-boss.x, cy=ty-boss.y, cd=Math.hypot(cx,cy)||1;
          const [bx,by]=[cx/cd,cy/cd];
          let ticks=0;
          const iv=setInterval(()=>{
            if(!boss||ticks++>28){boss.isCharging=false;clearInterval(iv);
              // 차지 후 8방향 부채꼴 탄막
              const ang=Math.atan2(by,bx);
              for(let i=-3;i<=3;i++){
                const a2=ang+i*0.28;
                const pid=`p${room.projId++}`;
                room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,vx:Math.cos(a2)*8,vy:Math.sin(a2)*8,dmg:boss.dmg*0.3,ttl:130};
              }
              // phase2: 추가 반대 방향 탄막
              if(phase2){
                for(let i=0;i<4;i++){
                  const a2=ang+Math.PI+(i-1.5)*0.4;
                  const pid=`p${room.projId++}`;
                  room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,vx:Math.cos(a2)*6,vy:Math.sin(a2)*6,dmg:boss.dmg*0.25,ttl:110};
                }
              }
              io.to(room.id).emit('bossAction',{type:'spread',x:boss.x,y:boss.y});
              return;
            }
            boss.x+=bx*22; boss.y+=by*22;
            boss.x=clamp(boss.x,-MAP,MAP); boss.y=clamp(boss.y,-MAP,MAP);
            alive.forEach(p=>{if(dist(p,boss)<60)damagePlayer(room,p,boss.dmg*0.8);});
          },40);
        },500+c*400);
      }
    }
    // 2페이즈: 원형 탄막 (쿨 단축, 12발)
    if (phase2 && (!boss.lastSpin||now-boss.lastSpin>2500)) {
      boss.lastSpin=now;
      for(let i=0;i<12;i++){
        const a=(i/12)*Math.PI*2;
        const pid=`p${room.projId++}`;
        room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,vx:Math.cos(a)*6,vy:Math.sin(a)*6,dmg:boss.dmg*0.55,ttl:120};
      }
      io.to(room.id).emit('bossAction',{type:'spin',x:boss.x,y:boss.y});
    }
  },

  spin(room, boss, alive, now) {
    if(tickGroggy(room, boss, now)) return;
    const target = alive.reduce((a,b)=>dist(a,boss)<dist(b,boss)?a:b);
    const dx=target.x-boss.x, dy=target.y-boss.y, d=Math.hypot(dx,dy);
    const [nx,ny]=norm(dx,dy);
    const phase2 = boss.hp < boss.maxHp*0.5;

    // 거리 유지 이동 (이동속도 phase에 따라 증가)
    const moveSpd = phase2 ? boss.speed*1.8 : boss.speed;
    const keep=220;
    if(d>keep+40){boss.x+=nx*moveSpd;boss.y+=ny*moveSpd;}
    else if(d<keep-40){boss.x-=nx*moveSpd;boss.y-=ny*moveSpd;}

    // 스파이럴 탄막: 매 150ms마다 발사 (phase2는 더 빠름)
    const spiralCD = phase2 ? 150 : 220;
    if(!boss.lastSpiral||now-boss.lastSpiral>spiralCD) {
      boss.lastSpiral=now;
      boss.spiralAngle=(boss.spiralAngle||0)+(phase2?0.6:0.38);
      // 기본: 1발, phase2: 반대방향 동시 2발
      const arms = phase2 ? 2 : 1;
      for(let arm=0;arm<arms;arm++){
        const a=boss.spiralAngle+arm*Math.PI;
        const pid=`p${room.projId++}`;
        room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,
          vx:Math.cos(a)*6,vy:Math.sin(a)*6,dmg:boss.dmg*0.5,ttl:150};
      }
    }

    // 유도탄: 플레이어 수와 무관하게 count발 발사 (같은 플레이어에게 여러 발 가능)
    const homingCD = phase2 ? 2200 : 4000;
    if(!boss.lastHoming||now-boss.lastHoming>homingCD) {
      boss.lastHoming=now;
      const count = phase2 ? 6 : 3;
      for(let i=0;i<count;i++){
        // alive 배열 순환 — 플레이어가 적어도 count발 모두 발사
        const p = alive[i % alive.length];
        setTimeout(()=>{
          if(!boss||!room.projectiles)return;
          const ang=Math.atan2(p.y-boss.y,p.x-boss.x);
          const pid=`p${room.projId++}`;
          room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,
            vx:Math.cos(ang)*4.5,vy:Math.sin(ang)*4.5,
            dmg:boss.dmg*0.7,ttl:180,homing:p.id};
        },i*250);
      }
      io.to(room.id).emit('bossAction',{type:'homing_warn',x:boss.x,y:boss.y});
    }

    // 순간이동: 플레이어 주변 랜덤 위치로 (원점 기준 버그 수정)
    const teleCD = phase2 ? 3000 : 5000;
    if(!boss.lastTele||now-boss.lastTele>teleCD){
      boss.lastTele=now;
      // 랜덤 플레이어 근처 200~400px로 순간이동
      const tp = alive[Math.floor(Math.random()*alive.length)];
      const tAngle=Math.random()*Math.PI*2;
      const tDist=220+Math.random()*180;
      boss.x=clamp(tp.x+Math.cos(tAngle)*tDist, -MAP+80, MAP-80);
      boss.y=clamp(tp.y+Math.sin(tAngle)*tDist, -MAP+80, MAP-80);
      // 순간이동 직후 8방향 탄막 폭발
      for(let i=0;i<8;i++){
        const ba=(i/8)*Math.PI*2;
        const pid=`p${room.projId++}`;
        room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,
          vx:Math.cos(ba)*5,vy:Math.sin(ba)*5,dmg:boss.dmg*0.55,ttl:120};
      }
      io.to(room.id).emit('bossAction',{type:'teleport',x:boss.x,y:boss.y});
    }

    // 근접 타격
    if(d<75&&(!boss.lastMelee||now-boss.lastMelee>1000)){
      boss.lastMelee=now;
      damagePlayer(room,target,boss.dmg);
      io.to(room.id).emit('bossAction',{type:'melee',x:boss.x,y:boss.y});
    }
  },

  cross(room, boss, alive, now) {
    if(tickGroggy(room, boss, now)) return;
    const target=alive.reduce((a,b)=>dist(a,boss)<dist(b,boss)?a:b);
    const dx=target.x-boss.x,dy=target.y-boss.y,d=Math.hypot(dx,dy);
    const [nx,ny]=norm(dx,dy);
    const phase2=boss.hp<boss.maxHp*0.45;

    if(!boss.isCharging&&d>90){boss.x+=nx*boss.speed;boss.y+=ny*boss.speed;}
    if(d<90&&(!boss.lastMelee||now-boss.lastMelee>1100)){
      boss.lastMelee=now;
      damagePlayer(room,target,boss.dmg);
      io.to(room.id).emit('bossAction',{type:'melee',x:boss.x,y:boss.y});
    }
    // 십자 탄막 (3s마다)
    if(!boss.lastCross||now-boss.lastCross>(phase2?2000:3200)){
      boss.lastCross=now;
      const dirs=phase2?[[1,0],[-1,0],[0,1],[0,-1],[0.707,0.707],[-0.707,0.707],[0.707,-0.707],[-0.707,-0.707]]
                       :[[1,0],[-1,0],[0,1],[0,-1]];
      dirs.forEach(([vx,vy])=>{
        // 각 방향에 3발씩
        for(let n=0;n<3;n++){
          setTimeout(()=>{
            if(!boss)return;
            const pid=`p${room.projId++}`;
            room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,vx:vx*6,vy:vy*6,dmg:boss.dmg*0.65,ttl:130};
          },n*180);
        }
      });
      io.to(room.id).emit('bossAction',{type:'cross',x:boss.x,y:boss.y,phase:phase2?2:1});
    }
    // 차지 (2.8s마다, 속도 상승)
    if(!boss.lastCharge||now-boss.lastCharge>2800){
      boss.lastCharge=now;
      const t2=alive[Math.floor(Math.random()*alive.length)];
      const tx=t2.x,ty=t2.y;
      io.to(room.id).emit('bossAction',{type:'charge_warn',tx,ty,delay:0});
      setTimeout(()=>{
        if(!boss)return;
        boss.isCharging=true;
        const [cx,cy]=norm(tx-boss.x,ty-boss.y);
        let ticks=0;
        const iv=setInterval(()=>{
          if(!boss||ticks++>22){boss.isCharging=false;clearInterval(iv);return;}
          boss.x+=cx*18;boss.y+=cy*18;
          boss.x=clamp(boss.x,-MAP,MAP);boss.y=clamp(boss.y,-MAP,MAP);
          alive.forEach(p=>{if(dist(p,boss)<55)damagePlayer(room,p,boss.dmg*1.4);});
        },40);
      },900);
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

    const spd=phase3?boss.speed*3:phase2?boss.speed*2:boss.speed;
    if(d>65){boss.x+=nx*spd;boss.y+=ny*spd;}
    else{
      const cd=phase3?300:phase2?600:1100;
      if(!boss.lastMelee||now-boss.lastMelee>cd){
        boss.lastMelee=now;
        const mult=phase3?2:phase2?1.5:1;
        damagePlayer(room,target,boss.dmg*mult);
        io.to(room.id).emit('bossAction',{type:'melee',x:boss.x,y:boss.y});
      }
    }
    // 산탄 (2.5s마다 → 1.2s)
    const shotCD=phase2?1200:2500;
    if(!boss.lastShot||now-boss.lastShot>shotCD){
      boss.lastShot=now;
      const ang=Math.atan2(dy,dx);
      const count=phase3?12:phase2?8:5;
      const spread=phase2?Math.PI:Math.PI*0.6;
      for(let i=0;i<count;i++){
        const a=ang+(i/(count-1)-0.5)*spread;
        const pid=`p${room.projId++}`;
        room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,vx:Math.cos(a)*5.5,vy:Math.sin(a)*5.5,dmg:boss.dmg*0.55,ttl:120};
      }
      io.to(room.id).emit('bossAction',{type:'spread',x:boss.x,y:boss.y});
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

    const spd=boss.speed*(0.6+phase*0.35);
    if(!boss.isCharging&&d>75){boss.x+=nx*spd;boss.y+=ny*spd;}
    if(d<75&&(!boss.lastMelee||now-boss.lastMelee>Math.max(350,1000/phase))){
      boss.lastMelee=now;
      damagePlayer(room,target,boss.dmg*(1+(phase-1)*0.35));
      io.to(room.id).emit('bossAction',{type:'melee',x:boss.x,y:boss.y});
    }

    // 1페이즈: 스파이럴
    if(phase>=1&&(!boss.lastSpiral||now-boss.lastSpiral>(phase>=3?200:300))){
      boss.lastSpiral=now;
      boss.spiralAngle=(boss.spiralAngle||0)+(phase>=3?0.55:0.35);
      [0,Math.PI].slice(0,phase>=2?2:1).forEach(offset=>{
        const a=boss.spiralAngle+offset;
        const pid=`p${room.projId++}`;
        room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,vx:Math.cos(a)*6,vy:Math.sin(a)*6,dmg:boss.dmg*0.5,ttl:130};
      });
    }

    // 2페이즈+: 유도탄
    if(phase>=2&&(!boss.lastHoming||now-boss.lastHoming>2200)){
      boss.lastHoming=now;
      const cnt=phase>=3?8:5;
      for(let i=0;i<cnt;i++){
        const t2=alive[i%alive.length];
        setTimeout(()=>{
          if(!boss||!room.projectiles)return;
          const ang=Math.atan2(t2.y-boss.y,t2.x-boss.x);
          const pid=`p${room.projId++}`;
          room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,vx:Math.cos(ang)*4.5,vy:Math.sin(ang)*4.5,
            dmg:boss.dmg*0.7,ttl:150,homing:t2.id};
        },i*220);
      }
      io.to(room.id).emit('bossAction',{type:'homing_warn',x:boss.x,y:boss.y});
    }

    // 3페이즈: 십자 + 차지
    if(phase>=3) {
      if(!boss.lastCross||now-boss.lastCross>2500){
        boss.lastCross=now;
        for(let i=0;i<8;i++){
          const a=(i/8)*Math.PI*2;
          const pid=`p${room.projId++}`;
          room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,vx:Math.cos(a)*7,vy:Math.sin(a)*7,dmg:boss.dmg*0.6,ttl:120};
        }
        io.to(room.id).emit('bossAction',{type:'spin',x:boss.x,y:boss.y});
      }
      if(!boss.lastCharge||now-boss.lastCharge>3500){
        boss.lastCharge=now;
        const t2=alive[Math.floor(Math.random()*alive.length)];
        const tx=t2.x,ty=t2.y;
        io.to(room.id).emit('bossAction',{type:'charge_warn',tx,ty,delay:0});
        setTimeout(()=>{
          if(!boss)return;
          boss.isCharging=true;
          const [cx,cy]=norm(tx-boss.x,ty-boss.y);
          let ticks=0;
          const iv=setInterval(()=>{
            if(!boss||ticks++>24){boss.isCharging=false;clearInterval(iv);return;}
            boss.x+=cx*12;boss.y+=cy*12;
            boss.x=clamp(boss.x,-MAP,MAP);boss.y=clamp(boss.y,-MAP,MAP);
            alive.forEach(p=>{if(dist(p,boss)<55)damagePlayer(room,p,boss.dmg*1.6);});
          },40);
        },900);
      }
    }
  }
};

// ===== 웨이브/보스 =====
function spawnWave(room) {
  const sc=STAGE_CONFIG[room.stage], wc=sc.waves[room.wave];
  room.enemies={}; room.projectiles={}; room.projId=0;
  room.waveTotal=wc.melee+wc.ranged; room.waveKilled=0;

  const ps=Object.values(room.players);
  const cx=ps.reduce((s,p)=>s+p.x,0)/(ps.length||1);
  const cy=ps.reduce((s,p)=>s+p.y,0)/(ps.length||1);

  // 등장 대기열 셔플 (혼합 등장)
  const toSpawn=[];
  for(let i=0;i<wc.melee;i++)  toSpawn.push({type:'melee', hp:wc.hp,         dmg:wc.dmg,     speed:8});
  for(let i=0;i<wc.ranged;i++) toSpawn.push({type:'ranged',hp:wc.hp*0.6|0,   dmg:wc.dmg*0.8, speed:5});
  for(let i=toSpawn.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[toSpawn[i],toSpawn[j]]=[toSpawn[j],toSpawn[i]];}

  io.to(room.id).emit('waveStart',{stage:room.stage+1,wave:room.wave+1,
    totalWaves:sc.waves.length,enemies:{}});

  // 배치 스폰 (8마리씩 1.5초 간격)
  const BATCH=8, DELAY=1500;
  let spawned=0;
  (function spawnBatch(){
    if(!rooms[room.id]||room.state!=='playing')return;
    const end=Math.min(spawned+BATCH,toSpawn.length);
    for(let i=spawned;i<end;i++){
      const e=toSpawn[i];
      const id=`e${gEid++}`;
      const angle=Math.random()*Math.PI*2, r=450+Math.random()*200;
      const x=clamp(cx+Math.cos(angle)*r,-MAP+50,MAP-50);
      const y=clamp(cy+Math.sin(angle)*r,-MAP+50,MAP-50);
      room.enemies[id]={id,type:e.type,x,y,hp:e.hp,maxHp:e.hp,dmg:e.dmg,speed:e.speed};
    }
    spawned=end;
    if(spawned<toSpawn.length) setTimeout(spawnBatch,DELAY);
  })();
}

function spawnBoss(room) {
  room.state='boss';
  const bc=STAGE_CONFIG[room.stage].boss;
  room.boss={...bc,maxHp:bc.hp,x:0,y:-400};
  room.projectiles={}; room.projId=0;
  io.to(room.id).emit('bossSpawn',{name:bc.name,hp:bc.hp,maxHp:bc.hp,stage:room.stage+1,isFinal:bc.isFinal||false});
}

function offerUpgrades(room) {
  room.upgradeVotes={};
  Object.values(room.players).forEach(player=>{
    const opts=[...UPGRADES].sort(()=>Math.random()-0.5).slice(0,3);
    io.to(player.id).emit('upgradeOffer',opts.map(u=>({id:u.id,name:u.name,desc:u.desc})));
  });
}

function checkUpgradesDone(room) {
  if(Object.keys(room.upgradeVotes).length>=Object.keys(room.players).length){
    io.to(room.id).emit('upgradesDone');
    setTimeout(()=>{room.wave++;room.state='playing';spawnWave(room);},1500);
  }
}

function reviveDead(room) {
  Object.values(room.players).forEach(p=>{
    if(p.hp<=0){
      p.hp=Math.floor(p.maxHp*0.5);
      io.to(room.id).emit('playerRevived',{playerId:p.id,hp:p.hp,maxHp:p.maxHp});
    }
  });
}

function onWaveClear(room) {
  room.waveTotal=0;
  reviveDead(room); // 사망 플레이어 50% 체력으로 부활
  // 업그레이드 화면 전환 시 모든 투사체 제거
  room.projectiles={}; room.projId=0;
  io.to(room.id).emit('clearAllProjectiles');
  const sc=STAGE_CONFIG[room.stage];
  if(room.wave>=sc.waves.length-1){
    io.to(room.id).emit('preBossWarning',{stage:room.stage+1,name:sc.boss.name});
    setTimeout(()=>spawnBoss(room),4000);
  } else {
    room.state='upgrade';
    io.to(room.id).emit('waveClear',{stage:room.stage+1,wave:room.wave+1});
    offerUpgrades(room);
  }
}

function onBossDead(room) {
  reviveDead(room); // 보스 처치 시 사망 플레이어 부활
  room.boss=null; room.projectiles={}; room.projId=0;
  io.to(room.id).emit('bossDead',{stage:room.stage+1});
  io.to(room.id).emit('clearAllProjectiles'); // 남은 투사체 모두 제거
  if(room.stage>=STAGE_CONFIG.length-1){
    setTimeout(()=>{room.state='game_clear';io.to(room.id).emit('gameClear');},2500);
  } else {
    setTimeout(()=>{
      room.stage++;room.wave=0;room.state='upgrade';
      io.to(room.id).emit('stageCleared',{nextStage:room.stage+1});
      setTimeout(()=>offerUpgrades(room),3200); // 스테이지 전환 애니메이션 완료 후 업그레이드
    },2000);
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
       (room.state==='playing'||room.state==='boss')){
      room.state='game_over'; io.to(room.id).emit('gameOver'); return;
    }

    // 투사체
    if(room.projectiles&&(room.state==='playing'||room.state==='boss')){
      const dead=[];
      Object.values(room.projectiles).forEach(proj=>{
        // 유도탄 조향
        if(proj.homing){
          const pt=alive.find(p=>p.id===proj.homing)||alive[0];
          if(pt){
            const [hx,hy]=norm(pt.x-proj.x,pt.y-proj.y);
            proj.vx=proj.vx*0.94+hx*0.4; proj.vy=proj.vy*0.94+hy*0.4;
            const spd=Math.hypot(proj.vx,proj.vy);
            if(spd>5){proj.vx=(proj.vx/spd)*5;proj.vy=(proj.vy/spd)*5;}
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
    if(room.state==='playing'){
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
          if(d<45){
            if(!enemy.lastAtk||now-enemy.lastAtk>1200){
              enemy.lastAtk=now;
              damagePlayer(room,target,enemy.dmg);
              io.to(room.id).emit('enemyAttack',{id:enemy.id,x:enemy.x,y:enemy.y});
            }
          } else {
            enemy.x+=nx*enemy.speed; enemy.y+=ny*enemy.speed;
            enemy.x=clamp(enemy.x,-MAP+30,MAP-30); enemy.y=clamp(enemy.y,-MAP+30,MAP-30);
          }
        } else {
          const keep=260;
          if(d>keep){enemy.x+=nx*enemy.speed;enemy.y+=ny*enemy.speed;}
          else if(d<keep-60){enemy.x-=nx*enemy.speed;enemy.y-=ny*enemy.speed;}
          enemy.x=clamp(enemy.x,-MAP+30,MAP-30); enemy.y=clamp(enemy.y,-MAP+30,MAP-30);
          if(!enemy.lastAtk||now-enemy.lastAtk>2200){
            enemy.lastAtk=now;
            const pid=`p${room.projId++}`;
            room.projectiles[pid]={id:pid,x:enemy.x,y:enemy.y,vx:nx*4.5,vy:ny*4.5,dmg:enemy.dmg,ttl:140};
            io.to(room.id).emit('enemyShoot',{id:pid,x:enemy.x,y:enemy.y,vx:nx*4.5,vy:ny*4.5});
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
        onWaveClear(room);
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
      role:null,ready:false,hp:100,maxHp:100,damageMult:1,defenseMult:1,speedMult:1,skillMult:1,regenRate:0,
      invincible:false};
    io.to(roomId).emit('lobbyUpdate',getLobbyState(room));
  }

  socket.on('selectRole',role=>{
    const room=rooms[socket.roomId];if(!room||room.state!=='lobby')return;
    room.players[socket.id].role=role;
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
    const dmg=data.damage*(me.damageMult||1)*(me.skillMult||1);

    if(room.state==='playing'&&room.enemies[data.enemyId]){
      const e=room.enemies[data.enemyId];
      e.hp-=dmg;
      if(e.hp<=0){delete room.enemies[data.enemyId];room.waveKilled++;io.to(room.id).emit('enemyDeath',data.enemyId);}
    }
    if((room.state==='boss'||room.state==='playing')&&room.boss&&data.enemyId==='boss'){
      const groggyMult = room.boss.groggy ? 1.5 : 1; // 그로기 중 피해 1.5배
      room.boss.hp=Math.max(0,room.boss.hp-dmg*groggyMult);
      if(room.boss.hp<=0)onBossDead(room);
    }
  });

  socket.on('healPlayer',data=>{
    const room=rooms[socket.roomId];if(!room)return;
    const me=room.players[socket.id];
    const amt=(data.amount||12)*(me.skillMult||1);
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
      room.barriers.push({id:bid,x:data.x,y:data.y,expires:Date.now()+10000});
      io.to(room.id).emit('barrierPlaced',{id:bid,x:data.x,y:data.y,duration:10000});
    }
  });

  socket.on('selectUpgrade',upgradeId=>{
    const room=rooms[socket.roomId];if(!room||room.state!=='upgrade')return;
    const p=room.players[socket.id];if(!p||room.upgradeVotes[socket.id])return;
    const up=UPGRADES.find(u=>u.id===upgradeId);if(!up)return;
    up.apply(p);
    room.upgradeVotes[socket.id]=upgradeId;
    socket.emit('upgradeApplied',{hp:p.hp,maxHp:p.maxHp,speedMult:p.speedMult,skillMult:p.skillMult});
    io.to(room.id).emit('playerHealthUpdate',{playerId:socket.id,hp:Math.floor(p.hp),maxHp:p.maxHp});
    checkUpgradesDone(room);
  });

  socket.on('skipUpgrade',()=>{
    const room=rooms[socket.roomId];if(!room||room.state!=='upgrade')return;
    if(!room.upgradeVotes[socket.id])room.upgradeVotes[socket.id]='skip';
    checkUpgradesDone(room);
  });

  socket.on('disconnect',()=>{
    const room=rooms[socket.roomId];if(!room)return;
    delete room.players[socket.id];
    io.to(socket.roomId).emit('playerDisconnected',socket.id);
    if(Object.keys(room.players).length===0)delete rooms[socket.roomId];
    else if(room.state==='lobby')io.to(socket.roomId).emit('lobbyUpdate',getLobbyState(room));
    else if(room.state==='upgrade')checkUpgradesDone(room);
  });
});

function startGame(room){
  room.state='playing';room.stage=0;room.wave=0;
  Object.values(room.players).forEach(p=>{
    if(p.role==='tanker'){p.maxHp=150;p.hp=150;}
    else if(p.role==='healer'){p.maxHp=80;p.hp=80;}
    else{p.maxHp=100;p.hp=100;}
  });
  io.to(room.id).emit('gameStart',{
    players:Object.values(room.players).map(p=>({id:p.id,role:p.role,x:p.x,y:p.y,hp:p.hp,maxHp:p.maxHp}))
  });
  setTimeout(()=>spawnWave(room),1500);
}

const PORT = process.env.PORT || 8081;
server.listen(PORT, ()=>console.log(`서버 실행 중: http://localhost:${PORT}`));
