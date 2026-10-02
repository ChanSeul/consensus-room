# 자신의 프로젝트에서 시작하기

공유하는 것은 작업 흐름과 검증 계약이다. 로그인 계정, 프로젝트 경로, 역할·세션 배정, 원문 자료, DB와 실행 로그는 각 사용자의 로컬 환경에 둔다. Private와 Public은 같은 핵심 엔진을 사용하며 개인 운영 스크립트와 데이터는 Public에 포함하지 않는다.

## 준비

macOS·Linux를 대상으로 한다. Node.js 26 이상, npm, Git, 사용할 Claude Code/Codex CLI가 필요하다. 각 CLI에 자신의 계정으로 로그인한다. 공급자가 요구하는 권한·샌드박스와 연결한 Jira·Figma·Slack 읽기 권한도 자신의 환경에서 준비한다. 저장소를 복제해도 작성자의 계정이나 외부 서비스 권한을 받는 것은 아니다.

```sh
git clone https://github.com/ChanSeul/consensus-room.git
cd consensus-room
npm ci
npm run build
CONSENSUS_ROOM_REPOSITORY="/absolute/path/to/your-project" npm start
```

대상 프로젝트는 로컬 Git 저장소여야 한다. 언어는 제한하지 않는다. 프로젝트의 `AGENTS.md` 등 기존 지침과 합의한 계획에 따라 검사·빌드 명령을 정한다. 포함된 Swift 정적 검사 도구는 선택 기능이며 모든 언어의 검사를 대신하지 않는다.

서버는 localhost에만 열린다. 터미널에 표시한 시작 URL을 브라우저에서 열고 같은 서버 주소·토큰으로 중재 세션을 연결한다. 인증된 시작 URL은 데이터 폴더의 `consensus-room.url`에도 저장된다. URL의 토큰을 공유하거나 커밋하지 않는다.

## 로컬 설정

| 환경변수 | 기본값과 용도 |
|---|---|
| `CONSENSUS_ROOM_REPOSITORY` | 서버 실행 디렉터리. 실제 작업할 Git 저장소를 명시하는 것을 권장 |
| `CONSENSUS_ROOM_DATA_DIR` | macOS: `~/Library/Application Support/ConsensusRoom`, Linux: `${XDG_DATA_HOME:-~/.local/share}/consensus-room` |
| `CONSENSUS_ROOM_MEMORY_DIR` | `<repository>/.consensus-room/memory`. 선택한 원문·위키를 둘 폴더이며, 없으면 기존 프로젝트 지침으로 시작 |
| `CONSENSUS_ROOM_CLAUDE_SKILL_DIRS` | `~/.claude/skills`. 콜론으로 경로를 구분, 빈 문자열이면 사용하지 않음 |
| `CONSENSUS_ROOM_CODEX_SKILL_DIRS` | `~/.codex/skills`, `~/.codex/skills/.system`. 같은 형식 |
| `CONSENSUS_ROOM_PORT` | `4317` |
| `CONSENSUS_ROOM_CLAUDE_MODEL`, `CONSENSUS_ROOM_CODEX_MODEL` | 자신의 계정에서 사용할 모델. 시작 기본값이며 역할별 프로필로도 지정 가능 |
| `CONSENSUS_ROOM_CLAUDE_EFFORT`, `CONSENSUS_ROOM_CODEX_EFFORT` | 공급자가 지원하는 추론 설정 |

`CONSENSUS_ROOM_DATA_DIR`을 직접 지정하면 먼저 폴더를 만든다. 존재하지 않는 경로는 빈 방을 잘못 여는 사고를 막기 위해 거부한다. 여러 독립 방을 동시에 실행한다면 데이터 폴더와 포트를 모두 구분한다. 로컬 자료·설정을 프로젝트 안에 두면 해당 프로젝트의 Git ignore 정책도 정한다.

## 작업 흐름

1. Claude 또는 Codex 세션을 열고 중재자 역할과 실제 세션 ID를 연결한다. 역할 배정 API는 `GET/POST /api/agent-profiles`, `GET/POST /api/role-assignments`이며 세부 계약은 [역할 계약](../src/shared/roles.ts)을 따른다.
2. Goal, Source 또는 브레인스토밍 중 출발점을 정한다. [주제 구조](topic-structure.md)의 생성 계약으로 Root·관리 주제와 말단 실행 주제를 만든다.
3. 중재 세션에서 Goal·계획·승인·사용자 결정을 처리한다. 웹에서 계층과 진행 상황을 확인한다. 자율중재는 항상 ON이다.
4. 작업자가 중재를 요청하면 같은 세션에서 이어받도록 [세션 인터럽트](mediator-interrupts.md)를 연결한다.

Source 모드는 지정한 링크를 증거 목록에 등록한다. 호스트의 연결 도구 또는 별도 인증한 읽기 수집기로 실제 원문을 확보한 뒤 Goal을 확정한다. 다른 사용자의 Jira·Figma·Slack 로그인이나 MCP 연결을 복사하지 않는다.

Linux용 기본 경로와 플랫폼 분기는 계약 검사로 확인한다. 실제 공급자 CLI·샌드박스·외부 서비스까지 포함한 Linux 종단 간 실행은 각 환경에서 확인해야 한다.

## 중재자 배정 예시

인증 헤더 `x-consensus-token`과 새 `Idempotency-Key`를 사용해 먼저 프로필을 만든다. 모델·추론 강도는 실제 중재 세션에서 사용 중인 값으로 바꾼다.

```text
POST /api/agent-profiles
{ "id": "my-mediator", "provider": "codex", "model": "your-model", "effort": "medium", "options": {} }

POST /api/role-assignments
{ "scope": "global", "role": "mediator", "participant": "my-mediator", "profileId": "my-mediator", "sessionId": "actual-session-id", "expectedVersion": 0 }
```

처음 배정할 때 버전은 0이다. 기존 배정이 있으면 조회한 현재 버전을 넣고, 반환된 새 버전을 이후 호출에 사용한다. 중재자의 변경 요청에는 `x-consensus-actor: mediator`, `x-consensus-mediator: my-mediator`, `x-consensus-mediator-version: <반환된 버전>`을 추가한다. 배정 변경은 사용자 권한으로만 한다. Claude 중재자는 provider와 실제 세션 값을 Claude에 맞춘다. planner·implementer·reviewer도 각 역할의 프로필을 별도로 배정할 수 있다.
