# 자신의 프로젝트에서 시작하기

공유하는 것은 작업 흐름과 검증 계약이다. 로그인 계정, 프로젝트 경로, 역할·세션 배정, 원문 자료, DB와 실행 로그는 각 사용자의 로컬 환경에 둔다. Private와 Public은 같은 핵심 엔진을 사용하며 개인 운영 스크립트와 데이터는 Public에 포함하지 않는다.

## 준비

macOS·Linux를 대상으로 하며 Windows는 지원하지 않는다. Node.js 26 이상, npm, Git, `ps`·`pgrep`, Claude Code·Codex CLI가 필요하다. 기본 역할은 Claude 계획·구현과 Codex 리뷰이므로 두 CLI에 자신의 계정으로 로그인한다. 공급자가 요구하는 권한·샌드박스 의존성도 준비한다. macOS에서는 중첩 샌드박스를 피하도록 사용자 터미널에서 서버를 시작한다.

CLI 설치·로그인은 [Codex 공식 안내](https://learn.chatgpt.com/docs/codex/cli)와 [Claude Code 공식 안내](https://code.claude.com/docs/en/overview)를 따른다. 설치 후 `codex --version`, `claude --version`을 확인한다. CR은 공급자 CLI를 설치하거나 계정을 복사하지 않는다. 2026-10-18의 로컬 기능 확인 환경은 macOS, Codex `0.163.0-alpha.10.2` 앱 번들 CLI, Claude Code `2.1.301`이었다. 이를 최소 버전으로 해석하지 않는다. 일반 배포판·다른 버전은 `doctor`가 출력하는 필수 실행 옵션과 선택적인 app-server·queue 기능을 확인해야 한다.

대상 프로젝트는 커밋이 하나 이상 있는 로컬 Git 저장소여야 한다. 언어는 제한하지 않는다. 프로젝트의 `AGENTS.md` 등 기존 지침과 합의한 계획에 따라 검사·빌드 명령을 정한다. 포함된 Swift 정적 검사 도구는 선택 기능이며 모든 언어의 검사를 대신하지 않는다.

## 1. 설치·개인 설정·서버 시작

```sh
git clone https://github.com/ChanSeul/consensus-room.git
cd consensus-room
npm ci
npm run cr -- init
npm run cr -- doctor
npm run cr -- start
npm run cr -- configure
npm run cr -- open
```

`init`은 터미널에서 누락된 저장소 절대 경로와 Claude·Codex 모델 ID를 묻는다. 모델은 자신의 계정에서 실제 사용할 수 있는 값을 고른다. 추론 강도의 기본값은 `medium`이며 공급자가 지원하는 값으로 선택한다. 플래너와 구현자의 모델을 나누려면 `--implementation-model`·`--implementation-effort`를 지정한다. 자동화에서는 질문에 답하는 대신 다음 플래그를 사용한다. 변수에는 먼저 자신의 실제 값을 넣는다.

```sh
npm run cr -- init --repository "$CR_PROJECT" \
  --claude-model "$CR_CLAUDE_MODEL" --codex-model "$CR_CODEX_MODEL"
```

기본 설정은 아래 기본 데이터 폴더의 `room.json`이며 파일 권한은 `0600`이다. `init`은 기존 설정을 덮어쓰지 않는다. `--config /absolute/private/path/room.json`으로 위치를 바꾸면 이후 **모든** `cr` 명령에 같은 `--config`를 붙인다. `--data-dir`과 `--port`도 초기화 때 지정할 수 있다. `--data-dir`만 바꿔도 기본 설정 파일 위치는 바뀌지 않으므로 독립 방마다 `--config`도 구분한다. 개인 설정과 데이터는 대상 프로젝트와 Consensus Room checkout 밖에 둔다. 설정에는 로그인 토큰을 넣지 않는다.

`doctor`는 실행 파일·CLI 도움말의 기능·경로·선택 연결을 읽기 전용으로 검사한다. `npm run cr -- doctor --json`으로 결과를 저장할 수 있다. 로그인 파일의 존재나 버전·기능 검사는 실제 인증·모델 사용 권한을 보장하지 않는다. 모델 턴이나 외부 앱 요청은 보내지 않는다. 선택한 메모리·스킬·Figma가 없으면 경고할 수 있다. 실패 항목은 안내에 따라 해결한다. 웹은 빌드 의존성을 점검하며 실제 후보 산출물은 `start`가 준비한다.

`start`는 후보 코드의 타입 검사와 웹 빌드를 마친 뒤 별도 서버 프로세스를 시작한다. 터미널을 닫아도 서버는 유지된다. 서버는 localhost에만 열린다. `open`은 인증 URL을 출력하지 않고 브라우저에서 연다. 비공개 데이터 폴더의 `consensus-room.url`에는 인증 토큰이 들어 있으므로 공유하거나 커밋하지 않는다.

`configure`는 설정의 Claude 플래너·구현자와 Codex 리뷰어를 전역 역할에 배정한다. 같은 설정은 다시 실행해도 유지하며, 다른 기존 배정은 거부한다. 의도한 역할 변경에만 `configure --replace`를 사용한다.

## 2. 이미 열린 중재 대화 연결

자신의 Claude 또는 Codex 앱·CLI에서 중재에 쓸 대화를 먼저 연다. 그 앱·CLI가 제공하는 **실제 세션 ID**, 현재 모델 ID와 추론 강도를 확인한다. 임의 ID나 다른 대화의 ID를 만들지 않는다. 다음은 Codex 예시다. Claude 대화라면 `--provider claude`로 바꾼다.

```sh
printf '열어 둔 중재 대화의 실제 세션 ID: '
read -r CR_SESSION_ID
printf '그 대화의 현재 모델 ID: '
read -r CR_SESSION_MODEL
printf '그 대화의 현재 추론 강도: '
read -r CR_SESSION_EFFORT
npm run cr -- connect --provider codex --participant my-mediator \
  --session "$CR_SESSION_ID" --model "$CR_SESSION_MODEL" --effort "$CR_SESSION_EFFORT"
```

`connect`는 현재 대화를 배정하고 배정 버전을 로컬에 보관한다. 대화를 새로 열거나 기존 대화의 모델을 바꾸지 않으며, 수신 성공을 검사하지 않는다. 기본 배정은 전역이다. 특정 토픽만 맡기려면 `--topic <실제 토픽 ID>`를 붙인다. 기존 중재자를 교체하는 사용자의 명시적 선택에만 `--replace`를 쓴다.

## 3. 토픽 생성과 실행

다음 명령은 ticket 실행 주제를 만든다. 생성은 모델을 호출하지 않으며 별도 작업 트리를 준비한다. 결과의 `id`를 입력해 같은 주제를 계속 사용한다.

```sh
npm run cr -- topic --title "첫 작업" --mode ticket --goal "사용자와 합의한 작은 변경을 구현하고 검증한다."
printf '생성 결과의 토픽 id: '
read -r CR_TOPIC_ID
npm run cr -- api GET "/api/mediation/context?topic=$CR_TOPIC_ID"
npm run cr -- api GET "/api/topics/$CR_TOPIC_ID/resume"
npm run cr -- briefing --topic "$CR_TOPIC_ID"
```

`briefing`이 출력한 진입 지침을 **connect에 지정한 기존 대화에 붙여넣는다.** 출력에는 공개 정책의 로컬 경로, 실제 프로젝트·토픽·배정과 context·resume 조회 명령이 들어가며 인증 토큰은 없다. 세션을 배정하는 것만으로 그 대화가 CR 사용법을 전달받지는 않는다.

중재자는 [중재 정책](mediation/policy.md)과 대상 프로젝트 지침을 읽고 context → resume 순서로 현재 배정·상태·승인·예산·열린 요청·다음 허용 행동을 확인한다. 실행 전에 [세션 인터럽트](mediator-interrupts.md)의 Codex bridge 또는 Claude 채널을 연결한다. Codex bridge는 별도 터미널에서 계속 실행해야 하며 자동 서비스가 아니다.

`resume`에 차단 사유가 없고 사용자가 해당 실행을 요청했다면 ticket은 다음 명령으로 시작한다.

```sh
npm run cr -- api POST "/api/topics/$CR_TOPIC_ID/actions/implement" --body '{}'
```

planned로 진행하려면 위 ticket 예제 대신 다음처럼 만든다. 새 ID의 `briefing`을 같은 대화에 전달하고 이 토픽의 인터럽트 연결을 준비한 뒤 `actions/plan`을 호출한다. CLI는 planned 실행 주제에 누락된 Claude·Codex 참여자 좌석을 준비한다. 좌석 준비는 모델 실행이나 실제 세션 수신이 아니다. 도중에 실패하면 생성된 ID를 보존하고 `npm run cr -- participants --topic "$CR_TOPIC_ID"`로 이어 간다.

```sh
npm run cr -- topic --title "구조 개선" --mode planned --goal "합의한 구조 변경의 계획을 검토하고 구현한다."
printf 'planned 생성 결과의 토픽 id: '
read -r CR_TOPIC_ID
npm run cr -- briefing --topic "$CR_TOPIC_ID"
npm run cr -- api GET "/api/topics/$CR_TOPIC_ID/resume"
```

```sh
npm run cr -- api POST "/api/topics/$CR_TOPIC_ID/actions/plan" --body '{}'
```

planned는 계획 리뷰 뒤 사용자 승인을 기다린다. 현재 계획과 해시를 검토하고 승인 의사가 있을 때만 `actions/approve`에 `{ "planSHA256": "현재 64자리 해시" }`를 보낸 뒤 `implement`를 호출한다. 결정문은 [운영 안내](public-operations.md#api-호출과-응답-유실)에 따라 `--body-file`로 보낸다. 승인·추가 예산·푸시·병합 권한은 토픽 생성이나 자율중재 ON만으로 생기지 않는다. 이후에도 매 단계 `resume`의 허용 행동을 따른다.

CLI의 `api`는 같은 로컬 서버의 REST API만 사용한다. 변경 요청은 저장한 중재자 신원·버전을 기본으로 보내며, 사용자만 할 수 있는 결정에는 명시적으로 `--as user`를 쓴다. 배정이 달라져 `STALE_MEDIATOR_ASSIGNMENT`가 나오면 멈추고 현재 배정을 확인한다. DB를 직접 고치거나 다른 신원으로 자동 재시도하지 않는다.

Goal·Source·논의, 관리 주제·하위 실행 주제와 브레인스토밍 API는 [주제 구조](topic-structure.md)를 따른다. `topic --group`은 관리 주제, `--parent <실제 관리 주제 ID>`는 하위 주제를 만든다.

## 개인 자료와 선택 연결

| 설정 | 기본값과 용도 |
|---|---|
| `repositoryPath` | `init`에서 선택한 실제 작업 저장소 |
| `dataDirectory` | macOS: `~/Library/Application Support/ConsensusRoom`, Linux: `${XDG_DATA_HOME:-~/.local/share}/consensus-room` |
| `port` | `4317`. 여러 독립 방은 데이터 폴더와 포트를 모두 구분 |
| `memoryDirectory` | 기본 `<repository>/.consensus-room/memory`. 선택한 원문·위키 폴더이며 없으면 기존 프로젝트 지침으로 시작 |
| `standingReferencePath` | 선택한 상시 참조 문서의 절대 경로. 기본값 없음 |
| `claudeSkillDirectories`, `codexSkillDirectories` | 선택한 스킬 폴더의 절대 경로 배열. CLI 초기 설정은 빈 목록 |
| `codexHome`, `claudeConfigDirectory` | 선택. 자신의 CLI 계정·설정 위치. 각각 `CODEX_HOME`, `CLAUDE_CONFIG_DIR`로 전달 |
| `figmaMcpUrl` | 기본 `null`. Claude 작업자에게 제공할 로컬 Figma Desktop MCP의 인증정보 없는 localhost URL |

설정은 `room.json`에서 편집한다. 경로는 절대 경로를 사용하며 변경 적용은 [운영 안내](public-operations.md)를 따른다. 작성자의 개인 스킬·메모리·인증 파일·DB·다른 프로젝트 자료를 복사할 필요가 없다. 프로젝트 안에 자신의 자료를 둘 때는 해당 Git ignore 정책을 정한다. `tools/host-review`·`tools/work-admission`은 Consensus Room 자체 개발에 선택적으로 설치하는 도구이며 일반 프로젝트 중재의 설치 요건이 아니다.

Jira·Slack·Figma·Google Sheets 원문은 자신의 계정 권한으로 읽는다. 서버의 자동 수집은 **Codex 앱 연결** 또는 명시적으로 인증한 REST 수집기를 사용한다. Claude MCP에 연결했다고 서버가 그 계정을 물려받지 않는다. Sheets는 비공개 데이터 폴더의 `evidence-apps.json`에 자신의 Google Drive `googleDriveLinkId`를 지정한다. Claude 작업자의 선택적 Figma Desktop MCP와 서버의 Codex 앱 Figma 수집은 별도 경로다. 자세한 계정 선택·승인·수집 계약은 [외부 원문](external-evidence.md)을 따른다. Source의 링크 등록만으로 읽기 완료를 판정하지 않는다.

Linux용 경로와 플랫폼 분기가 있어도 실제 공급자 CLI·샌드박스·외부 서비스까지 포함한 Linux 종단 간 성공을 보장하지 않는다. 해당 호스트에서 실제 실행·전달·수신을 확인해야 한다. macOS도 `doctor` 결과만으로 모든 공급자 E2E가 검증됐다고 판단하지 않는다.

기존 환경변수와 `npm run build` → `CONSENSUS_ROOM_REPOSITORY="/absolute/path/to/your-project" npm start` 방식도 지원한다. CLI가 관리하는 서버와는 시작·종료 방식을 섞지 않는다. 기존 방식의 환경변수·인증과 운영 범위는 [운영 안내](public-operations.md#기존-npm-start-방식)를 참고한다.

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

### 계획 항목 coverage(planned 전용, 2026-10-11)

planned 계획은 구현할 항목 목록을 fenced 블록 ```` ```plan-items ```` 으로 선언한다(`{"version":1,"items":[{"id":"R-1","requirement":"…","done":"…"}]}`, 여러 .md 의 블록을 합치며 id 는 묶음 전체에서 유일하다. 항목 수 상한은 없다). 목록의 버전은 계획 판 sha 그대로다. 엔진은 다음을 기계적으로 확인하고, 항목의 의미·구현의 정확성·근거의 진실성은 리뷰어·중재자·사용자가 판단한다.

1. 플래너가 `ready` 로 답했는데 블록이 없거나 형식이 틀리면 판을 확정하지 않고 같은 플래너 세션에 `check-result`(`plan-items`) 사실로 돌려준다. 같은 내용으로 되풀이하면 중재자 정지다. 승인(`approve`)과 구현 진입·재개·리뷰 진입도 목록 없는 승인 계획을 거부한다 — 보완은 `return-to-planning`(같은 플래너 세션이 목록을 보완한 뒤 리뷰·승인)이나 명시적 `workflow-mode` ticket 전환이다. 자동으로 바꾸지 않는다.
2. 구현자의 `done` 봉투는 `planItems`(항목마다 `id`·`status` implemented/not-implemented·`evidence`)가 선언 집합과 정확히 같고 전부 implemented 여야 리뷰로 간다. 아니면 교정 사실을 받아 같은 세션에서 이어 가고, 같은 보고를 되풀이하면 중재자 정지다.
3. 코드 리뷰어의 `approve` 봉투는 `planItems`(항목마다 satisfied/unimplemented/unverified)가 선언 집합과 같아야 한다(아니면 같은 리뷰 세션·같은 리뷰 원장으로 판정만 다시 받는다). 하나라도 satisfied 가 아니면 `changes` 와 같이 수정 턴으로 간다. 전 항목 satisfied 일 때만 READY_TO_DELIVER 이고, 그 판정은 승인 판·범위 세대·planEpoch·검토 트리·리뷰 세션·원장에 결속된 영수증(READY 전이 사건의 `planCoverage`)으로 남는다.
4. commit·push·close(단계 닫기 포함)는 영수증이 지금 승인 판·검토 트리와 일치할 때만 된다. 영수증이 없는 planned(이 계약 전에 READY 에 이른 토픽 포함)와 낡은 영수증은 거부하고 보완 경로(`resume` reentry CODEX_REVIEW·`return-to-planning`·ticket 전환)를 안내한다. 복구(`discard-orphan-commit`·`reconcile-delivery`)와 닫힌 단계의 push 는 이 검사를 지나지 않는다. 묶음에 없는 planned 의 닫기(`close`, API 의 `closeStage`)는 영수증 대조에 더해 현재 작업 트리가 최종 리뷰 스냅샷과 같은지도 확인한다(commit 과 같은 대조 — 기준 HEAD 는 마지막 확정 커밋 또는 리뷰 HEAD, 내용은 리뷰 HEAD 기준 diff 해시). 영수증은 리뷰 기록에 결속되므로 리뷰 뒤 바뀐 파일은 이 대조로만 드러난다. 커밋·clean 은 요구하지 않으며, 바뀌었으면 다시 리뷰(`resume` reentry CODEX_REVIEW)한 뒤 닫는다. ticket 닫기와 묶음 단계 닫기(결과 커밋 검증)는 이전과 같다.
5. 매 planned 왕복 턴은 승인 계획 사실에 항목 id 목록을 싣는다 — 기존 세션도 항목별 보고 의무와 형식을 안다. ticket(이전 계획이 남은 ticket 포함)은 이 계약을 지나지 않는다.

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

## 역할 배정 API

일반 설치에서는 위 `configure`·`connect`를 사용한다. 역할별 세부 배정은 `GET/POST /api/agent-profiles`, `GET/POST /api/role-assignments`와 [역할 계약](../src/shared/roles.ts)을 따른다. 직접 API를 쓸 때도 모델·세션 ID는 실제 대화와 일치해야 한다.

처음 배정할 때 `expectedVersion`은 0이다. 기존 배정이 있으면 조회한 현재 버전을 넣고 반환된 새 버전을 이후 호출에 사용한다. 배정 변경은 사용자 권한으로만 한다. CLI는 인증 헤더·Idempotency-Key를 관리하고, 중재자 변경 요청에는 저장한 참여자와 배정 버전을 함께 보낸다. 프로필·배정의 존재와 인터럽트의 실제 전달·수신은 별도로 확인한다.
