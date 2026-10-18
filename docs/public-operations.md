# 자신의 방 운영하기

처음 설치는 [시작 안내](getting-started.md), 실제 세션 수신은 [인터럽트 연결](mediator-interrupts.md)을 따른다. 아래 명령은 Consensus Room을 복제한 폴더에서 실행한다. 기본값 외의 설정 파일을 사용한다면 모든 명령에 `--config /absolute/private/path/room.json`을 붙인다.

## 상태·열기·중지·재시작

```sh
npm run cr -- status
npm run cr -- open
npm run cr -- stop
npm run cr -- start
```

`status`는 저장한 PID의 시작 시각·명령·프로세스 그룹과 현재 프로세스를 대조하고 인증된 health 응답을 확인한다. 출력 URL에는 토큰이 없다. `running`은 서버 준비 상태이며 모델·외부 계정·중재 세션의 준비 상태를 뜻하지 않는다. `open`은 비공개 시작 URL을 읽어 기본 브라우저에 전달한다.

`stop`과 `restart`는 해당 checkout·데이터 폴더에서 시작한 정확한 서버만 정상 종료한다. 다른 포트 소유자나 프로세스 그룹을 종료하지 않는다. 다음 상황에서는 거부한다.

- PID 재사용·기록 불일치·권한 부족 등으로 서버 신원을 확인하지 못한다.
- 실행 중 액션·진행 중 연속 실행·예약된 재시도·원문 수집 후 재개 대기가 있다.
- 기존 유지보수 잠금이 있거나 인증된 작업 상태를 읽지 못한다.

```sh
npm run cr -- api GET /api/topics
npm run cr -- api GET "/api/topics/$CR_TOPIC_ID/resume"
```

거부되면 해당 토픽의 `runningAction`, `autoRetryAt`, `continuation`, `evidenceResume`와 다음 허용 행동을 확인한다. 현재 작업과 예약을 사용자의 권한 안에서 공식 API로 정리하거나 끝날 때까지 기다린다. 잠금·DB 행을 지워 유휴 상태로 만들지 않는다. `--force`는 제공하지 않는다. 신원이 불명확하면 비공개 데이터 폴더의 `server-process.json`과 실제 프로세스를 비교해 소유자를 먼저 확인한다.

```sh
npm run cr -- restart
npm run cr -- status
```

`restart`는 후보 타입 검사와 웹 빌드를 먼저 끝낸 뒤 기존 서버를 중지한다. 후보 검사 실패 시 기존 서버를 유지한다. 중지 경계의 `maintenance.lock`은 엔진의 새 작업 시작을 막고 CLI가 만든 잠금은 작업 후 해제한다. 재기동 실패 시 성공으로 처리하지 않으며 오류가 가리키는 `server-logs`의 비공개 로그와 `status`를 확인한다. 재시작은 새 권한·예산·중재 대화를 만들지 않는다. 별도 터미널의 Codex bridge도 자동 서비스로 설치하지 않는다. 서버 재시작 뒤 연결 상태를 확인하고 필요하면 같은 설정으로 bridge를 다시 실행한다.

CLI가 강제 종료되어 잠금이 남아도 임의로 삭제하지 않는다. CLI는 자신이 남긴 `public-cli` 잠금에 한해, 60분이 지났고 소유 프로세스가 확실히 종료됐으며 파일이 바뀌지 않았을 때만 다음 중지·재시작에서 회수한다. 다른 도구의 잠금, 손상된 기록, 살아 있거나 확인할 수 없는 PID는 보존한다.

## 코드 갱신

실행 중인 토픽을 보존하고 같은 checkout에서 갱신한다. 개인 데이터 폴더와 작업 트리는 그대로 사용한다.

```sh
git status --short
git pull --ff-only
npm ci
npm run cr -- restart
npm run cr -- status
```

관련 없는 로컬 변경이나 fast-forward 실패는 보존한 채 해결한다. `reset --hard`·`git clean`으로 정리하지 않는다. 특히 개인 데이터 폴더를 Git 정리 대상으로 삼지 않는다. 재시작이 작업 때문에 거부되면 위 상태 확인 절차를 따른다. 새 bridge 코드도 쓰려면 기존 연결 프로세스를 종료한 뒤 다시 실행하거나 Claude 채널 연결을 다시 연다. 소스 갱신·서버 기동·실제 모델 실행·인터럽트 수신은 각각 확인한다.

## 개인 설정과 역할 변경

`init`이 출력한 `room.json`을 편집한다. 로그인 토큰이나 외부 서비스 자격증명은 넣지 않는다. 선택 설정은 [시작 안내의 표](getting-started.md#개인-자료와-선택-연결)를 참고한다.

**포트·데이터 폴더·작업 프로젝트 경로는 기존 설정으로 서버를 먼저 중지한 뒤 변경한다.** 순서는 `stop` → 설정 편집 → `doctor` → `start` → `configure`다. 변경한 포트·데이터 폴더로 기존 서버에 `restart`를 시도하면 잘못된 방에 연결하지 않도록 거부할 수 있다. 다른 프로젝트의 독립 방은 새 설정 파일·데이터 폴더·포트로 구분한다.

```sh
npm run cr -- stop
# 서버가 중지된 뒤 room.json의 포트·데이터·프로젝트 경로를 편집한다.
npm run cr -- doctor
npm run cr -- start
npm run cr -- configure
```

모델·스킬·메모리·상시 참조 등 서버 시작 설정을 바꿀 때는 편집 후 다음 순서로 적용한다.

```sh
npm run cr -- doctor
npm run cr -- restart
```

역할 모델·추론 프로필도 바꾸려는 의도라면 현재 전역 배정을 확인한 뒤 별도로 적용한다.

```sh
npm run cr -- api GET '/api/role-assignments?scope=global'
npm run cr -- configure --replace
```

`configure --replace`는 전역 플래너·구현자·리뷰어 배정을 갱신한다. 기존 토픽별 배정이나 이미 열린 세션의 모델을 일괄 변경하지 않는다. 중재 대화 교체는 실제 새 세션의 모델·추론 강도를 확인하고 `connect ... --replace`로 명시한다. 이어 `briefing --topic "$CR_TOPIC_ID"`의 지침을 그 대화에 전달하고 연결 프로세스를 다시 준비한다. 배정이 바뀐 bridge가 다른 세션을 자동 채택하도록 하지 않는다.

기본 `medium`을 포함한 추론 강도와 모델 ID는 계정에서 지원하는 값으로 고른다. `doctor`는 도움말 기능·로그인 파일 존재 등을 읽으며 계정 인증·모델 사용 가능 여부는 검증하지 않는다. 선택적인 Figma URL의 TCP 응답도 MCP 신원·자료 접근 성공을 보장하지 않는다.

## API 호출과 응답 유실

CLI는 localhost의 `/api/` 경로만 호출한다. 인증 토큰은 비공개 시작 URL에서 읽어 헤더로 보내며 직접 복사할 필요가 없다. GET의 기본 신원은 사용자, 변경의 기본 신원은 저장한 중재자다. 사용자만 가능한 결정은 사용자의 실제 의사를 확인한 뒤 `--as user`로 보낸다. 배정·한도 변경이나 불명확한 인터럽트 재전송 권한을 얻으려고 이 옵션을 우회로로 쓰지 않는다.

결정문·URL·긴 본문은 비공개 JSON 파일에 저장하고 `--body-file`로 보낸다. 예를 들어 planned의 **현재 계획을 검토하고 승인한 사용자**는 아래 본문의 해시를 실제 값으로 바꾼 파일을 준비한다.

```json
{ "planSHA256": "검토한 현재 계획의 64자리 SHA-256" }
```

```sh
printf '준비한 승인 JSON 파일의 절대 경로: '
read -r CR_APPROVAL_FILE
npm run cr -- api POST "/api/topics/$CR_TOPIC_ID/actions/approve" \
  --as user --body-file "$CR_APPROVAL_FILE"
npm run cr -- api GET "/api/topics/$CR_TOPIC_ID/resume"
```

CLI는 모든 변경 요청을 보내기 전에 `<dataDirectory>/cli-requests/<request-id>.json`에 저장하고 `Idempotency-Key`를 보낸다. 이 기록과 헤더만으로 모든 API의 중복 실행이 방지되지는 않는다. 응답 유실·시간 초과가 나면 요청 ID·기록 파일을 보존하고 현재 상태를 먼저 조회한다.

토픽 생성, 프로필·역할 배정, 참여자 연결, 토픽 actions 경로는 서버 요청 원장을 사용한다. 이 경로에서 같은 요청을 다시 확인할 때는 **같은 메서드·경로·본문·신원**과 `--request-id <기존 요청 ID>`를 사용한다. 새 ID로 같은 생성·실행을 반복하지 않는다. 다른 경로는 재호출 안전성을 따로 확인해야 한다. 예를 들어 강제 원문 수집과 인터럽트 재전송은 같은 ID라도 동작이 다시 실행될 수 있다. CLI는 해당 경로에서 자동 재호출을 안내하지 않는다. 같은 ID에 다른 요청을 보내면 CLI가 거부한다. 저장 파일에는 결정문·세션 신원이 있으므로 공개하지 않는다.

`topic`도 `--request-id`를 받는다. planned 토픽 생성은 성공했지만 참여자 준비만 실패했다면 오류에 나온 토픽 ID로 `participants`를 실행한다. 토픽을 새로 만들지 않는다.

`STALE_MEDIATOR_ASSIGNMENT`나 저장한 연결과 현재 배정의 불일치는 재시도 전에 현재 context를 확인한다. 사용자만 배정을 바꿀 수 있다. 실패한 호출을 성공으로 표시하거나 DB·잠금을 직접 수정하지 않는다. 액션의 `accepted` 응답은 접수 기록이다. 실제 진행·결과는 `resume`과 타임라인으로 확인한다.

## 보존할 로컬 자료

개인 데이터 폴더에는 `mediator.json`, 인증 URL, DB, 요청 기록, 토픽 작업 트리, 원문 스냅샷과 로그가 있다. 기본 `room.json`은 기본 데이터 폴더에 있으며 `--config`로 지정한 파일도 별도로 보존한다. 저장소를 다시 복제했다고 이 상태를 옮기거나 초기화하지 않는다. 별도 방을 만들 때는 데이터 폴더·포트·설정 파일을 모두 구분한다. 작성자의 인증·DB·개인 스킬이나 다른 프로젝트 자료를 복사하지 않는다.

호스트 검사만으로 macOS·Linux의 실제 공급자 흐름 전체를 확인할 수 없다. CLI·샌드박스·모델 권한·외부 앱·세션 수신은 해당 환경에서 실제 결과로 확인한다. Windows는 지원 대상이 아니다.

## 기존 npm start 방식

기존 전경 실행도 지원한다. 이 방식은 CLI의 비공개 설정 파일을 자동으로 읽지 않는다. 별도 사용 시 자신의 환경변수를 명시한다.

```sh
npm run build
CONSENSUS_ROOM_REPOSITORY="/absolute/path/to/your-project" npm start
```

| 환경변수 | 용도 |
|---|---|
| `CONSENSUS_ROOM_REPOSITORY` | 실제 작업 Git 저장소. 생략하면 현재 디렉터리 |
| `CONSENSUS_ROOM_DATA_DIR` | 기본 데이터 폴더 대신 사용할 경로. 직접 지정하면 먼저 폴더를 만들고 경로를 확인 |
| `CONSENSUS_ROOM_PORT` | 기본 `4317` |
| `CONSENSUS_ROOM_CLAUDE_MODEL`, `CONSENSUS_ROOM_CODEX_MODEL` | 본인 계정에서 선택한 모델 |
| `CONSENSUS_ROOM_CLAUDE_EFFORT`, `CONSENSUS_ROOM_CODEX_EFFORT` | 해당 모델이 지원하는 추론 강도 |
| `CONSENSUS_ROOM_MEMORY_DIR`, `CONSENSUS_ROOM_STANDING_REFERENCE` | 자신의 메모리 폴더·상시 참조 파일 |
| `CONSENSUS_ROOM_CLAUDE_SKILL_DIRS`, `CONSENSUS_ROOM_CODEX_SKILL_DIRS` | 콜론으로 구분한 스킬 경로. 빈 문자열이면 사용하지 않음 |
| `CONSENSUS_ROOM_FIGMA_MCP_URL` | 선택적 Claude Figma Desktop MCP. 빈 문자열이면 끔 |

직접 실행의 기본 스킬 경로는 `~/.claude/skills`, `~/.codex/skills`·`~/.codex/skills/.system`이며 CLI 초기 설정의 빈 목록과 다르다. 직접 실행의 Figma 기본 주소는 `http://127.0.0.1:3845/mcp`, CLI 초기 설정은 `null`이다. 모델·역할·중재 연결도 자신의 값으로 설정한다. 같은 방을 두 방식으로 동시에 시작하지 않으며, CLI가 신원을 확인하지 못하는 기존 서버를 `stop`·`restart`로 강제 종료하려 하지 않는다.
