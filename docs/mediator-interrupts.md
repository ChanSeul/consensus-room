# 중재자 세션 인터럽트

planner·runner·reviewer가 사용자 결정, 증거 부족, 실패, 계획 승인, 전달 또는 논의 결론을 기다리면 서버가 개입 요청을 저장한다. 중재자 연결 프로세스는 현재 역할 배정의 `profileId`와 `sessionId`를 확인해 그 세션에만 전달한다. Root를 구독하면 같은 중재자가 담당하는 하위 주제도 받는다.

- Codex: 실행 중이면 현재 턴에 `turn/steer`, 대기 중이면 같은 세션에 `turn/start`한다. 새 세션을 만들거나 모델·추론 설정을 덮어쓰지 않는다. 실행 중 턴을 취소하는 `turn/interrupt`는 사용하지 않는다.
- Claude Code: MCP channel 알림으로 요청을 넣는다. Claude가 바쁘면 채널 처리 시점까지 대기할 수 있다. `consensus_interrupt_ack` 도구 호출로 실제 수신을 확인한다.
- 알림에는 요청 ID, 주제, 요청 역할, 현재 상태, 제한된 정지 사유와 `resume` 경로가 들어간다. 전체 로그를 다시 주입하지 않는다. 알림은 재개·추가 예산·범위 변경 승인이 아니다.

계획 리뷰와 구현 리뷰의 내부 읽기·교정 응답까지 각각 5회마다 점검 요청을 남긴다. 이 집계는 배포 이후 완료 응답부터 시작하며 기존 리뷰 한도·세션·체크포인트를 변경하지 않는다. 실패·취소·범위가 바뀐 늦은 응답은 세지 않는다. 재시작과 재시도는 횟수를 초기화하지 않고, 캐시된 응답 재생은 새 왕복이 아니다.

점검은 작업을 멈추지 않는다. 요청은 정상 단계 전환에도 남고 실제 정지·승인 대기로 전환되면 그 알림에 합쳐진다. 다음 5회가 먼저 끝나면 최신 점검 요청으로 합치며 모든 도달 기록은 타임라인에 남는다. 범위 세대·계획 epoch 변경이나 CLOSED는 이전 요청을 닫는다. 연결 프로세스가 없는 환경은 요청만 저장하며, 수정·재개가 실행됐다고 표시하지 않는다.

## 연결 준비

각 사용자의 컴퓨터에서 자신의 Claude/Codex 로그인으로 실행한다. 웹에서는 지시를 입력하지 않는다. 서버의 사용자 권한으로 중재자 profile과 역할을 먼저 배정하고 실제 세션 ID를 기록한다. `GET /api/mediation/context?topic=<topic-id>`에서 현재 참여자·배정 버전을 확인한다. 연결 프로세스는 배정을 변경하지 않는다.

연결 프로세스에 다음 환경변수를 전달한다. 토큰을 저장소나 로그에 쓰지 않는다.

| 변수 | 값 |
|---|---|
| `CONSENSUS_ROOM_URL` | 토큰 없는 로컬 주소. 예: `http://127.0.0.1:4317` |
| `CONSENSUS_ROOM_TOKEN` | 해당 서버의 인증 토큰 |
| `CONSENSUS_ROOM_TOPIC_ID` | 연결을 시작할 주제 ID. 서버가 현재 배정의 상위 주제(전역 배정이면 해당 트리의 Root)로 구독 범위를 맞춘다. |
| `CONSENSUS_MEDIATOR` | 현재 `participant@version` |
| `CONSENSUS_MEDIATOR_SESSION_ID` | 역할 배정에 기록한 실제 세션 ID |
| `CONSENSUS_CODEX_SOCKET` | 선택. 현재 Codex app-server의 제어 소켓 |

Codex는 기존 app-server에 연결할 수 있는 `codex app-server proxy`가 필요하다. 수신 세션을 그 서버에 열어 둔 뒤 별도 터미널에서 실행한다.

```sh
npm run mediator:interrupts -- codex
```

이 명령은 연결 프로세스를 유지한다. 종료하거나 재부팅했다면 같은 설정으로 다시 실행한다. CLI가 proxy를 지원하지 않거나 제어 소켓에 연결할 수 없으면 UI에 실패가 표시된다. 자동으로 다른 모델 세션을 만들지 않는다.

연결 프로세스는 요청이 없어도 약 30~55초마다 동일 세션의 연결을 확인한다. Codex 확인은 `initialize`와 `thread/read`만 사용하므로 모델 턴을 시작하지 않는다. 결과는 `POST /api/topics/<구독 주제>/interrupts/connection`에 저장하며, 90초 동안 새 확인이 없으면 만료로 표시한다. `resume.mediation.connection`과 `activity.mediationConnection`은 같은 배정을 상속하는 모든 하위 작업에서 연결 불가·확인 만료·구독 범위 불일치를 보여 준다. 연결할 제어 통로가 없는 데스크톱 앱을 브릿지만으로 연결할 수는 없다. 앱의 설정이나 세션을 임의로 바꾸지 않고 연결 불가 상태를 유지한다.

`GET /api/topics/<시작 주제>/interrupts/connection?provider=codex&sessionId=<세션>`은 구독 주제와 연결 상태를 반환한다. 이 경로도 현재 배정 신원과 세션을 검사한다. 종료된 단계에서 시작해도 같은 상위 배정의 다음 단계 요청을 받으며, 별도 하위 배정은 기존처럼 제외한다.

Claude는 같은 환경변수를 상속한 MCP stdio 서버를 등록한다. 로컬 MCP 설정의 예시는 다음과 같다. 경로는 자신의 설치 위치로 바꾼다.

```json
{
  "mcpServers": {
    "consensus-room": {
      "command": "npm",
      "args": ["--silent", "--prefix", "/path/to/consensus-room", "run", "mediator:interrupts", "--", "claude"]
    }
  }
}
```

Claude Code에서 이 서버를 채널로 활성화해야 한다. 직접 만든 채널은 현재 개발 채널 옵션이 필요하다. 본인이 검토한 로컬 서버에만 적용하며 조직의 채널 허용 정책도 충족해야 한다. 기존 중재 세션을 이어 여는 예시:

```sh
claude --resume "$CONSENSUS_MEDIATOR_SESSION_ID" \
  --dangerously-load-development-channels server:consensus-room
```

MCP 서버 연결만으로 채널 수신이 보장되지는 않는다. 채널을 활성화하지 않으면 Claude가 알림을 버릴 수 있다. UI의 `세션에 전달됨`은 전송 완료이며, Claude의 `중재자 수신 확인`은 ACK 도구 호출을 받은 상태다. Codex는 app-server의 턴 입력 수락까지 확인하며 모델의 판단 완료를 뜻하지 않는다.

## 실패와 재배정

같은 정지에는 요청 ID 하나를 사용한다. 이미 전달한 요청은 반복해서 보내지 않고 서버 재시작 후에도 기록을 유지한다. 새 배정은 미해결 요청을 받을 수 있으며 이전 배정의 조회·응답은 거부한다. 주제 상태가 바뀌면 이전 요청을 닫는다.

제어 연결이 턴 입력 전 종료된 경우에는 요청을 보존하고 60초 이상 간격으로 연결 복구를 기다린다. 이 경우 실제 전달 시도 한도를 소진하지 않는다. 명확히 거부된 전송은 지연을 두고 최대 3회 시도한다. 응답 유실·연결 단절로 수락 여부가 불명확하면 `전송 결과 확인 필요`로 남긴다. 실제 세션을 확인한 사용자가 다음 API로 재전송을 요청할 수 있다. 중재자 호출로는 강제 재전송할 수 없다.

```text
POST /api/topics/<topic-id>/interrupts/<interrupt-id>/retry
{ "reason": "실제 세션에서 미수신 확인" }
```

UI와 `GET /api/topics/<topic-id>/resume`의 `mediation.interrupt`에 미연결·대기·전송·수신 확인·실패 상태를 표시한다. 연결 프로세스 없이 자동 세션 인터럽트가 작동한다고 간주하지 않는다.

중재자는 현재 `resume`을 확인한 뒤 실제 처리를 시작할 때 `POST /api/topics/<topic-id>/interrupts/<interrupt-id>/handling`에 자신의 `{provider, sessionId}`를 보낸다. 이 기록은 전달 영수증과 별개이며 승인·재개·완료를 뜻하지 않는다. `mediation.intervention`과 `activity.mediationIntervention`에는 전달 상태, 처리 시작 시각, 이후 서버가 새 실행을 시작한 시각과 action ID가 각각 보존된다. 새 실행 시작은 모델의 실제 진척이나 성공을 보장하지 않으며, 중재자 처리 기록이 없으면 중재자가 재개시켰다고 추정하지 않는다. 재배정·범위 변경과 응답 미확인 재전송의 기존 경계는 유지한다.

공급자 계약: [Codex app-server](https://developers.openai.com/codex/app-server), [Claude 채널](https://code.claude.com/docs/en/channels-reference).
