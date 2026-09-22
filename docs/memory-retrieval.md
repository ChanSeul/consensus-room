# 필요한 메모리 문서와 외부 근거를 전달하는 방법

문서 선택은 파일명·링크 설명·제목과 소제목을 사용한다. 기능 이름의 띄어쓰기와 별칭을 맞춘 뒤 주제 일치를 우선한다. `승인`, `취소` 같은 일반 단어 하나만 겹치는 문서로 네 자리를 채우지 않는다. 자기 역할의 리뷰 절차는 리뷰 요청에 계속 포함한다.

`ProjectMemoryReader.select`, `buildPrompt`, `buildManifest`의 기존 호출 형태는 유지한다. `selectWithDiagnostics`는 선택·제외 이유와 UTF-8 바이트를 반환한다. 라우터와 최대 네 문서, 문서당 80KB·전체 180KB 제한을 유지한다. 심볼릭 링크, 역할이 다른 문서와 메모리 루트 밖 경로는 읽지 않는다. 인덱스 전문은 전달하지 않는다.

계획·감사 프롬프트의 주제와 승인된 계획을 우선 검색한다. 사용자 대화도 함께 보며, Consensus Room의 역할 설명을 업무 주제로 취급하지 않는다. 이 추출은 `shared/prompts.ts`의 형식에 의존하므로 해당 형식을 바꿀 때 생성된 프롬프트로 선별 테스트를 실행한다.

## 위키 문서와 원문 연결

위키는 현재 동작, 판단 이유, 이전 실패, 원문 출처, 관련 코드·테스트, 마지막 확인 커밋을 연결하는 짧은 안내 문서다. 검증 완료 후에만 갱신하고 새 요구사항·분석 이벤트·백엔드 계약을 추정해서 기록하지 않는다. 원문과 코드가 달라졌으면 먼저 다시 확인한다.

기존 frontmatter는 그대로 둔다. 외부 근거 저장소에 실제 등록된 원문만 본문의 단일 `wiki-evidence` JSON 블록으로 연결한다. 블록 모양은 다음과 같다. 아래 해시는 예시이며 실제 문서에 복사하지 않는다.

````markdown
```wiki-evidence
{"dependencies":[{"sourceId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","contentHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]}
```
````

두 해시는 64자리 소문자 SHA-256이다. 한 문서에 최대 64개의 서로 다른 원문을 연결한다. 원문을 위키 안에 복제하지 않는다. 외부 스냅샷이 없는 문서는 연결하지 않았다는 사실과 확인 범위를 일반 문장으로 적는다.

생성자의 선택적 `MemoryReaderOptions.resolveEvidenceStatus`는 원문 의존 목록을 받아 `current | changed | unavailable | missing`을 동기 또는 비동기로 반환한다. 외부 저장소의 `status` 함수를 이 옵션으로 연결한다. reader는 네트워크 수집이나 DB 갱신을 수행하지 않는다.

- `current`: 저장소가 기록한 원문 해시와 같다. 작성자·플랫폼·제품 결정의 유효성까지 증명하지 않는다.
- `changed`: 원문을 다시 확인한 뒤 해당 판단을 사용한다. 자동으로 결정 변경이라고 해석하지 않는다.
- `unavailable`: 상태 조회 실패·미연결·잘못된 참조다. 최신이라고 간주하지 않는다.
- `missing`: 연결한 원문이 없다. 출처 확인 전에는 최신 결정의 근거로 사용하지 않는다.

상태는 본문 밖에 표시하며 메모리 본문과 SHA-256은 변형하지 않는다. 재개 턴의 manifest에도 상태를 표시하지만 본문은 반복 전달하지 않는다. 갱신된 위키 전문을 기존 세션에 자동 재주입하는 기능은 포함하지 않는다. 원문 전달 이력과 변경분 전달은 외부 근거 모듈이 담당한다.

## 고정 질문 평가

실제 질문과 정답 문서 목록은 운영 자료이므로 공개 저장소에 넣지 않는다. 먼저 질문과 필수·금지 문서를 확정하고 파일 해시를 보관한다. 원본 알고리즘과 새 알고리즘은 동일한 문서 집합에서 실행하고 `corpusSHA256`과 `casesSHA256`이 같은 결과만 비교한다. 위키 추가 후 결과는 별도로 기록한다.

```sh
npx tsx scripts/evaluate-memory.ts --memory /path/to/memory --cases /private/path/cases.json
# 변경 전 reader 모듈을 별도로 보존했을 때
npx tsx scripts/evaluate-memory.ts --memory /path/to/memory --cases /private/path/cases.json --reader /private/path/baseline.ts
```

질문 파일은 `{id, query, required: string[], forbidden: string[], mode?: "raw" | "plan" | "audit", expectEmpty?: boolean}` 객체의 배열이다. 평가기는 두 역할로 실행하고 문서 경로·누락·금지 문서·본문 바이트만 출력한다. `expectEmpty: true`인 질문은 라우터 외 문서를 하나라도 선택하면 실패한다. 필수 문서가 빈 배열이라는 이유만으로 이 조건을 추정하지 않는다. 필수 문서 누락·금지 문서 선택·빈 결과 조건 위반·실행 중 문서 변경이 있으면 실패 종료한다. 금지 목록만 통과했다고 모든 선택 문서가 관련 있다고 해석하지 않는다. 이 결과는 검색 평가이며 모델 토큰·전체 작업시간 측정은 아니다.

## 실제 작업 관측

측정용 모델 호출은 추가하지 않는다. 실제 배포 시 적용 커밋을 고정하고, 변경 전 비교 대상과 변경 후 완료 작업 20건의 topic ID·작업 종류·확인한 사용자 정정 횟수를 비공개 cohort JSON에 기록한다. 정정 횟수를 확인하지 못했으면 `null`로 둔다.

```json
{"implementationCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","entries":[]}
```

`entries`의 항목은 `{topicId, cohort: "before" | "after", kind, userCorrections: number | null}`이다. 같은 작업을 두 집단에 넣을 수 없다.

```sh
npx tsx scripts/observe-memory.ts --db /private/path/consensus-room.sqlite --cohort /private/path/cohort.json
```

도구는 SQLite를 읽기 전용으로 연다. `CLOSED` 작업의 모든 실행을 읽고 작업 종류·역할·단계·모델·추론 강도·재개 여부별로 나눠 보고한다. 진행 중 작업은 제외하고 불완전한 계측은 `null`로 남긴다. 입력 토큰에 캐시 입력이 포함되므로 둘을 더하지 않는다. `durationMs` 합계는 모델 실행시간이며 생성부터 종료까지 시간은 사용자 대기도 포함한다. 반복 실행 횟수는 재작업 여부를 검토할 자료이지, 모든 반복이 잘못된 작업이라는 뜻은 아니다.

20건 미만이면 표본 부족으로 표시한다. 20건 이상이어도 관측 자료임을 표시하며 자동으로 속도 향상을 선언하지 않는다. 비교할 모델·작업 조건이나 정정 기록이 부족하면 효과는 미확정이다.

## 검증 경계

공개 진입점 `buildPrompt`·`buildManifest`의 소비자는 어댑터 stdin이다. 테스트는 주제별 필수 문서, 거부할 일반 단어, 역할·경로·용량, 원문 상태와 실패 뒤 재확인, 본문 해시 보존을 확인한다. 원문 resolver는 정상·실패를 재현하며 임의 sleep을 사용하지 않는다. 새 문서 형식은 이전 결함 복원 대상이 없고, 기존 오선택은 변경 전 reader로 RED를 확인한다.

선별·상태 조회는 읽기 전용이라 중복 제출 비용과 사용자 화면 focus·sheet는 해당하지 않는다. 이 테스트가 실제 외부 원문 수집·제품 승인·iOS 화면·모델 작업 성공률을 증명하지는 않는다. 외부 저장소와 연결한 통합 테스트 및 이후 운영 관측을 별도로 구분한다.
