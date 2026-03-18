const express = require('express');
const app = express();
const server = require('http').Server(app);
const io = require('socket.io')(server);
app.use(express.static(__dirname + '/public'));

const MAP = 1100; // 맵 경계 -MAP ~ MAP

const STAGE_CONFIG = [
  { waves:[{melee:4,ranged:1,hp:80,dmg:8},{melee:6,ranged:2,hp:90,dmg:10},{melee:7,ranged:3,hp:100,dmg:12}],
    boss:{name:'안개의 수호자',hp:1800,dmg:20,speed:2.2,pattern:'charge'} },
  { waves:[{melee:6,ranged:3,hp:110,dmg:12},{melee:8,ranged:4,hp:120,dmg:14},{melee:9,ranged:5,hp:130,dmg:16}],
    boss:{name:'심연의 파수꾼',hp:3000,dmg:28,speed:2.4,pattern:'spin'} },
  { waves:[{melee:8,ranged:4,hp:140,dmg:15},{melee:10,ranged:5,hp:150,dmg:18},{melee:12,ranged:6,hp:160,dmg:20}],
    boss:{name:'황혼의 군주',hp:4200,dmg:32,speed:2.4,pattern:'cross'} },
  { waves:[{melee:10,ranged:5,hp:170,dmg:20},{melee:12,ranged:7,hp:180,dmg:22},{melee:14,ranged:8,hp:200,dmg:25}],
    boss:{name:'혼돈의 지배자',hp:5400,dmg:38,speed:2.6,pattern:'berserk'} },
  { waves:[{melee:12,ranged:7,hp:200,dmg:25},{melee:15,ranged:9,hp:220,dmg:28},{melee:18,ranged:10,hp:250,dmg:30}],
    boss:{name:'어둠의 왕',hp:10500,dmg:45,speed:2.8,pattern:'final',isFinal:true} },
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
  const mult = (player.defenseMult||1) * (player.role==='tanker'?0.5:1);
  player.hp = Math.max(0, player.hp - base*mult);
  io.to(room.id).emit('playerHealthUpdate',{playerId:player.id,hp:Math.floor(player.hp),maxHp:player.maxHp});
}

// ===== 보스 패턴 =====
const BOSS_AI = {

  charge(room, boss, alive, now) {
    const target = alive.reduce((a,b)=>dist(a,boss)<dist(b,boss)?a:b);
    const dx=target.x-boss.x, dy=target.y-boss.y, d=Math.hypot(dx,dy);
    const [nx,ny]=norm(dx,dy);
    const phase2 = boss.hp < boss.maxHp*0.5;

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
    // 차지 공격 (3.5s마다)
    if (!boss.isCharging && (!boss.lastCharge||now-boss.lastCharge>(phase2?2200:3500))) {
      boss.lastCharge=now;
      const count = phase2 ? 2 : 1;
      let delay = 0;
      for (let c=0;c<count;c++) {
        const t2 = alive[Math.floor(Math.random()*alive.length)];
        const tx=t2.x, ty=t2.y;
        io.to(room.id).emit('bossAction',{type:'charge_warn',tx,ty,delay:delay*1000});
        setTimeout(()=>{
          if(!boss)return;
          boss.isCharging=true;
          const cx=tx-boss.x, cy=ty-boss.y, cd=Math.hypot(cx,cy)||1;
          const [bx,by]=[cx/cd,cy/cd];
          let ticks=0;
          const iv=setInterval(()=>{
            if(!boss||ticks++>20){boss.isCharging=false;clearInterval(iv);
              // 차지 후 부채꼴 탄막
              const ang=Math.atan2(by,bx);
              for(let i=-2;i<=2;i++){
                const a2=ang+i*0.3;
                const pid=`p${room.projId++}`;
                room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,vx:Math.cos(a2)*6,vy:Math.sin(a2)*6,dmg:boss.dmg*0.6,ttl:120};
              }
              io.to(room.id).emit('bossAction',{type:'spread',x:boss.x,y:boss.y});
              return;
            }
            boss.x+=bx*10; boss.y+=by*10;
            boss.x=clamp(boss.x,-MAP,MAP); boss.y=clamp(boss.y,-MAP,MAP);
            alive.forEach(p=>{if(dist(p,boss)<55)damagePlayer(room,p,boss.dmg*1.5);});
          },40);
        },900+delay*900);
        delay++;
      }
    }
    // 2페이즈: 추가 원형 탄막
    if (phase2 && (!boss.lastSpin||now-boss.lastSpin>4000)) {
      boss.lastSpin=now;
      for(let i=0;i<8;i++){
        const a=(i/8)*Math.PI*2;
        const pid=`p${room.projId++}`;
        room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,vx:Math.cos(a)*5,vy:Math.sin(a)*5,dmg:boss.dmg*0.5,ttl:110};
      }
      io.to(room.id).emit('bossAction',{type:'spin',x:boss.x,y:boss.y});
    }
  },

  spin(room, boss, alive, now) {
    const target = alive.reduce((a,b)=>dist(a,boss)<dist(b,boss)?a:b);
    const dx=target.x-boss.x, dy=target.y-boss.y, d=Math.hypot(dx,dy);
    const [nx,ny]=norm(dx,dy);
    const phase2 = boss.hp < boss.maxHp*0.5;

    // 거리 유지 이동
    const keep=200;
    if(d>keep+50){boss.x+=nx*boss.speed;boss.y+=ny*boss.speed;}
    else if(d<keep-50){boss.x-=nx*boss.speed;boss.y-=ny*boss.speed;}

    // 스파이럴 탄막 (0.3s마다 한 발씩 각도 회전)
    if(!boss.lastSpiral||now-boss.lastSpiral>300) {
      boss.lastSpiral=now;
      boss.spiralAngle=(boss.spiralAngle||0)+(phase2?0.45:0.28);
      const pid=`p${room.projId++}`;
      room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,
        vx:Math.cos(boss.spiralAngle)*5.5,vy:Math.sin(boss.spiralAngle)*5.5,dmg:boss.dmg*0.5,ttl:140};
      if(phase2){
        const a2=boss.spiralAngle+Math.PI;
        const pid2=`p${room.projId++}`;
        room.projectiles[pid2]={id:pid2,x:boss.x,y:boss.y,vx:Math.cos(a2)*5.5,vy:Math.sin(a2)*5.5,dmg:boss.dmg*0.5,ttl:140};
      }
    }
    // 유도탄 (4s마다)
    if(!boss.lastHoming||now-boss.lastHoming>(phase2?2500:4500)) {
      boss.lastHoming=now;
      const count=phase2?6:4;
      alive.slice(0,count).forEach((p,i)=>{
        setTimeout(()=>{
          if(!boss||!room.projectiles)return;
          const ang=Math.atan2(p.y-boss.y,p.x-boss.x);
          const pid=`p${room.projId++}`;
          room.projectiles[pid]={id:pid,x:boss.x,y:boss.y,vx:Math.cos(ang)*4,vy:Math.sin(ang)*4,
            dmg:boss.dmg*0.7,ttl:160,homing:p.id};
        },i*300);
      });
      io.to(room.id).emit('bossAction',{type:'homing_warn',x:boss.x,y:boss.y});
    }
    // 순간이동 (2페이즈, 6s마다)
    if(phase2&&(!boss.lastTele||now-boss.lastTele>6000)){
      boss.lastTele=now;
      const angle=Math.random()*Math.PI*2, r=200+Math.random()*300;
      boss.x=clamp(Math.cos(angle)*r,-MAP,MAP);
      boss.y=clamp(Math.sin(angle)*r,-MAP,MAP);
      io.to(room.id).emit('bossAction',{type:'teleport',x:boss.x,y:boss.y});
    }
    // 근접시 타격
    if(d<80&&(!boss.lastMelee||now-boss.lastMelee>1200)){
      boss.lastMelee=now;
      damagePlayer(room,target,boss.dmg);
      io.to(room.id).emit('bossAction',{type:'melee',x:boss.x,y:boss.y});
    }
  },

  cross(room, boss, alive, now) {
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
    // 차지 (4s마다)
    if(!boss.lastCharge||now-boss.lastCharge>4000){
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
          boss.x+=cx*11;boss.y+=cy*11;
          boss.x=clamp(boss.x,-MAP,MAP);boss.y=clamp(boss.y,-MAP,MAP);
          alive.forEach(p=>{if(dist(p,boss)<55)damagePlayer(room,p,boss.dmg*1.4);});
        },40);
      },900);
    }
  },

  berserk(room, boss, alive, now) {
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

  const spawn=(type,hp,dmg,speed)=>{
    const id=`e${gEid++}`;
    const angle=Math.random()*Math.PI*2, r=450+Math.random()*200;
    const x=clamp(cx+Math.cos(angle)*r,-MAP+50,MAP-50);
    const y=clamp(cy+Math.sin(angle)*r,-MAP+50,MAP-50);
    room.enemies[id]={id,type,x,y,hp,maxHp:hp,dmg,speed};
  };
  for(let i=0;i<wc.melee;i++)  spawn('melee', wc.hp,         wc.dmg,     4);
  for(let i=0;i<wc.ranged;i++) spawn('ranged', wc.hp*0.6|0,  wc.dmg*0.8, 3);

  io.to(room.id).emit('waveStart',{stage:room.stage+1,wave:room.wave+1,
    totalWaves:sc.waves.length,enemies:room.enemies});
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

function onWaveClear(room) {
  room.waveTotal=0;
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
  io.to(room.id).emit('bossDead',{stage:room.stage+1});
  room.boss=null; room.projectiles={};
  if(room.stage>=STAGE_CONFIG.length-1){
    setTimeout(()=>{room.state='game_clear';io.to(room.id).emit('gameClear');},2500);
  } else {
    setTimeout(()=>{
      room.stage++;room.wave=0;room.state='upgrade';
      io.to(room.id).emit('stageCleared',{nextStage:room.stage+1});
      offerUpgrades(room);
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
            if(dist(enemy,bar)<220){
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
      room.boss.hp=Math.max(0,room.boss.hp-dmg);
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
