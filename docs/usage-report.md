# 작업별 토큰과 시간을 확인하기

`python3 scripts/report-usage.py --output ~/Downloads/room-usage`는 운영 DB와 세션 파일을 읽어 JSON·Markdown을 만든다.
서버·모델을 실행하거나 원본 기록을 수정하지 않는다. Python 표준 라이브러리만 필요하다.

기본 입력은 `~/Library/Application Support/ConsensusRoom`과 `~/.claude/projects`다.
다른 위치는 `--room-home`, `--claude-projects`로 지정한다. `--topic ID_OR_SLUG`,
`--from 2026-09-01T00:00:00+09:00 --to 2026-10-01T00:00:00+09:00`으로 범위를 선택한다.
기간은 시작 포함·끝 제외이며 요청 첫 관측 시각과 실행 종료 시각으로 선택한다. 경계에 걸친 실행은 나누지 않는다.

## 중재자와 사전 감사 연결

토픽의 현재 worktree와 범위 변경 기록의 이전 worktree, 관리형 Codex 홈, host-review와 work-admission 원장은 자동으로 찾는다.
중재자와 사전 감사처럼 작업 연결을 자동으로 증명할 수 없는 세션은 `--mapping FILE.json`에 명시한다.
자세한 파일을 먼저 지정한 다음 상위 디렉터리를 지정하면 같은 파일은 한 번만 읽으며 앞선 역할을 사용한다.

```json
{
  "sources": [
    {"path": "/local/audit-agent.jsonl", "provider": "claude", "role": "pre-audit"},
    {"path": "/local/mediator-session", "provider": "claude", "role": "mediator"}
  ],
  "reviewJobs": {"REVIEW_JOB_ID": "TOPIC_ID"},
  "admissionTasks": {"ADMISSION_TASK_ID": "TOPIC_ID"}
}
```

`provider`는 `claude` 또는 `codex`, `role`은 `runner`, `mediator`, `pre-audit`, `host-review`, `work-admission`이다.
`sources`의 `topic`은 선택 사항이다. 생략하면 Codex cwd로 연결 가능한 경우만 연결하고 나머지는 공통·미배정으로 남긴다.
여러 작업이 섞인 세션을 시간만으로 한 단계에 몰아넣지 않는다. 단일 worktree 아래 기록도 다른 목적으로 실행했다면
mapping에서 정확한 파일의 역할을 먼저 지정한다. 원본 메시지나 도구 결과 본문은 보고서에 넣지 않는다.

## 숫자가 의미하는 것

- 토큰 합계는 원본 요청에서 관측한 값이다. Claude의 부분 응답은 요청별 누적 최댓값으로 합친다.
  요청 ID가 빠진 사본은 같은 메시지에 명시된 요청 ID가 하나일 때만 합친다. 여러 ID가 있으면 모호한 사본은 경고로 남긴다.
  모든 사본을 합친 뒤 첫 관측 시각으로 기간을 선택한다. 부모 `result` 집계는 하위 에이전트 토큰과 다시 더하지 않는다.
- Codex는 중복된 누적 이벤트를 제거하고 요청별 `last_token_usage`를 합친다. 누적값이 초기화되는 재개도 처리한다.
  다른 형식만 남은 기록은 실행별 보고값으로 보존하며 원본 요청 합계에 추정해 넣지 않는다.
- `executionObservations`는 원장에 남은 별도 관측이다. 원본 요청 합계에 더하지 않는다.
  CLI·원본 대조의 불일치와 필드 누락은 `coverage`에 남긴다. 미제공 수치를 0으로 단정하지 않는다.
- `reportedCostUSD`는 실행 원장이 보고한 금액만의 합이다. 요금제 사용량이나 청구서를 뜻하지 않는다.
  토큰에 임의 단가를 곱하거나 사전 감사의 입력 환산 토큰을 달러로 합산하지 않는다.
- 실행시간 합계는 병렬 실행을 각각 포함한다. union은 기록된 실행 구간의 중복을 제거한다.
  envelope는 첫 실행 시작부터 마지막 종료까지의 경과이며 사람의 실제 대기시간은 아니다.
  세 값 모두 기록된 실행만 대상으로 하고, JSONL 행 간격을 모델 가동시간으로 추정하지 않는다.
- 기간이나 토픽이 다른 작업, 모델이 다른 실행끼리 절감률을 계산하지 않는다. 프롬프트 바이트 감소도 전체 비용 감소와 다르다.

JSON에는 출처 경로·SHA-256·요청 위치·실행별 관측·미배정 항목을 보존한다. 파일 권한은 600이다.
**실제 보고서와 mapping은 비공개 로컬 산출물이다.** 공개 저장소에는 도구·문서·익명화된 테스트만 넣는다.

검증: `python3 -m unittest discover -s tests/host-review -p test_usage_report.py -v`.
