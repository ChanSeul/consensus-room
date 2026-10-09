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

## 작업 방식(ticket·planned)

토픽은 ticket 또는 planned 방식으로 진행한다. 새 토픽의 기본값은 ticket 이다. 사용자나 중재자가 방식을 고른다. 엔진은 제목·크기·키워드로 방식을 정하지 않는다.

| 방식 | 흐름 | 시작 행동 |
|---|---|---|
| ticket | 구현 → 코드 리뷰 → 필요한 수정 → 전달 준비 → 완료 | `implement` |
| planned | 계획 왕복 → 사용자 승인 → 구현 → 코드 리뷰 → 필요한 수정 → 전달 준비 → 완료 | `plan` |

ticket 은 계획을 쓰지 않는다. 계획 작성·감사·종결·ACK·계획 해시 합의를 구현의 조건으로 요구하지 않는다.

planned 의 계획 왕복은 같은 플래너 세션과 같은 계획 리뷰어 세션이 주고받는다.

1. 플래너가 계획 폴더(`plan/*.md`, 기본 `plan.md`)에 계획을 쓰고 `ready` 로 답한다.
2. 엔진이 폴더를 한 판으로 확정한다. 판의 버전은 폴더 내용의 SHA-256 이다.
3. 리뷰어가 그 판의 경로와 직전 판 대비 변경분을 받는다.
4. 리뷰어가 `changes` 로 답하면, 플래너가 같은 계획을 고친다.
5. 리뷰어가 `agree` 로 답하면, 토픽이 사용자 승인 대기로 간다.

두 세션은 상대의 응답 원문만 받는다. 엔진은 응답을 요약하거나 판정하지 않는다. 종결·ACK·재계획 턴은 없다. 판이 바뀌면 이전 승인은 무효가 된다.

방식은 `POST /api/topics/:id/workflow-mode`(`{ mode, reason }`)로 바꾼다. 방식을 바꿔도 실행은 시작하지 않는다. 승인한 계획을 고치려면 `return-to-planning` 을 쓴다. 사용법은 [중재 정책](mediation/policy.md)에 있다.

## 세션 그래프와 실행 편집

중재 세션에서 새로 만든 주제와 하위 작업 진행률은 웹을 보고 있는 동안 자동으로 갱신됩니다. 관리 주제가 없는 기존 작업 묶음은 왼쪽 **관리 주제 없는 작업 묶음**에서 펼쳐 다음 단계를 열 수 있습니다.

가운데 **Graph / 대화창** 탭으로 전환합니다. Graph는 선택한 주제와 하위 주제의 세션, 참조 원문, 미착수 실행 단계를 보여 줍니다. 노드를 누르면 현재 모델·추론 설정, 세션 ID, 전달 원문과 통신 기록을 오른쪽에서 확인합니다. 이전 세션은 필터로 펼칩니다.

점선은 역할 흐름이나 원문 등록 관계입니다. 실선은 원문 전달 기록이며, 통신선은 중재 요청의 대기·전송·수신 확인·실패 상태를 표시합니다. 이전 계획 흐름의 계획 확인(ACK)과 본문 조각 전달은 과거 기록으로만 보입니다. 세션 ID가 없는 과거 중재 요청은 발신 역할을 적고 주제에서 연결합니다. 기록이 없는 직접 통신을 추정하지 않습니다. 실행 중인 노드는 애니메이션으로 표시하고, 조회 실패 시 이전 실행 표시를 지웁니다. 외부 Host-review 설치가 없거나 실행 프로세스를 확인할 수 없으면 미연결·관측 없음으로 표시합니다.

**파이프라인 편집**에서 미착수 작업 노드를 추가·삭제하고, 출력 포트에서 다음 작업의 입력 포트를 선택해 의존 관계를 연결합니다. 연결선을 선택해 대상을 확인한 뒤 삭제하거나, 노드 설정의 선행 작업 버튼으로 연결을 삭제합니다. 이 연결은 실제 다음 단계의 시작 조건입니다. 각 작업은 자기 작업 방식(ticket·planned)의 절차를 따릅니다. 마지막 통합 검증은 유지합니다.

- **편집안 저장**: 이 브라우저에 초안을 보관합니다. 실행 구성에는 아직 반영하지 않습니다.
- **실행에 적용**: 버전을 확인해 서버에 반영합니다. 다른 세션이 먼저 바꿨으면 충돌을 알리고 편집안을 유지합니다. **편집 취소 · 최신본 불러오기**로 서버의 최신 구성으로 돌아간 뒤 다시 편집할 수 있습니다.
- 이미 연결된 작업은 보호됩니다. 시작된 단계의 문맥·승인에 영향을 주는 변경, 순환 연결, 완료된 작업 삭제는 거부합니다. 바뀐 원문은 사실로 전달되고, 영향은 작업자·중재자가 판단합니다.
- 새 파이프라인 생성 응답을 받지 못하면 편집을 잠그고 요청을 이 브라우저에 보관합니다. 새로고침 후에도 **실행에 적용**을 다시 눌러 같은 요청의 결과를 확인합니다. 중복 생성을 막기 위해 브라우저 저장소를 사용할 수 없으면 새 생성 요청을 보내지 않습니다.
- 새 실행 파이프라인은 큰 그림 주제에서 만들고, 적용 후 단계별 작업 패널에서 다음 준비 단계를 엽니다. 파이프라인 저장·적용 자체가 모델을 실행하지는 않습니다.

## 중재자 배정 예시

인증 헤더 `x-consensus-token`과 새 `Idempotency-Key`를 사용해 먼저 프로필을 만든다. 모델·추론 강도는 실제 중재 세션에서 사용 중인 값으로 바꾼다.

```text
POST /api/agent-profiles
{ "id": "my-mediator", "provider": "codex", "model": "your-model", "effort": "medium", "options": {} }

POST /api/role-assignments
{ "scope": "global", "role": "mediator", "participant": "my-mediator", "profileId": "my-mediator", "sessionId": "actual-session-id", "expectedVersion": 0 }
```

처음 배정할 때 버전은 0이다. 기존 배정이 있으면 조회한 현재 버전을 넣고, 반환된 새 버전을 이후 호출에 사용한다. 중재자의 변경 요청에는 `x-consensus-actor: mediator`, `x-consensus-mediator: my-mediator`, `x-consensus-mediator-version: <반환된 버전>`을 추가한다. 배정 변경은 사용자 권한으로만 한다. Claude 중재자는 provider와 실제 세션 값을 Claude에 맞춘다. planner·implementer·reviewer도 각 역할의 프로필을 별도로 배정할 수 있다.
