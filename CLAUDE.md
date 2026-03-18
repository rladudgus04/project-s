# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Start the server
node server.js
# Server runs at http://localhost:8081
```

No build step, linter, or test framework is configured.

## Architecture

**Soul Journey** - 실시간 멀티플레이어 2D 액션 게임

- **Backend**: [server.js](server.js) — Node.js + Express 5 + Socket.IO 4. HTTP 서버(포트 8081), 적 스폰 루프(5초), 적 AI 루프(50ms 틱), 플레이어 상태 관리
- **Frontend**: [public/index.html](public/index.html) — Phaser 3.55.2 (HTML5 게임 프레임워크) + Socket.IO 클라이언트. 빌드 없이 인라인 스크립트로 구성

### 핵심 구조

**서버 (`server.js`)**
- Socket.IO 이벤트: `selectRole`, `playerMove`, `playerAttack`, `disconnect`
- 4000×4000 월드에서 플레이어 좌표/HP/역할 관리
- 적 타입: Melee(HP 100, 70%) / Ranger(HP 50, 30%), 탱커 우선 타겟팅(400px 이내)

**클라이언트 (`public/index.html`)**
- 역할 선택 UI → Phaser 씬 시작 흐름
- 역할 3종: Attacker(딜러), Tanker(탱커, 피해 50% 감소), Healer(회복, Z키로 120px 범위 힐)
- Z키: 역할별 스킬 발동 (Attacker=빨간 슬래시, Tanker=파란 창, Healer=초록 오라)
- Socket 이벤트 수신: `currentPlayers`, `newPlayer`, `playerMoved`, `playerHealthUpdate`, `enemyUpdate`, `enemyDied`
