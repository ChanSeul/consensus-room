# 작업 시작과 주제 계층

중재자는 Claude 또는 Codex 세션에서 사용자의 Goal·Source·논의 주제를 받는다. 웹에는 지시 입력란이나 자율중재 토글이 없다. 세션·예산·현재 배정과 승인 검사는 기존 계약을 따른다.

큰 그림을 먼저 정하고, 현재 말단 주제만 상세 계획·구현·검증하는 점진적 진행이 기본이다. 결과를 확인한 뒤 다음 단계를 구체화하며 미래 단계의 상세 계획을 처음부터 모두 작성하지 않는다. 별도의 웹 작업 묶음 생성 모드는 제공하지 않는다. 이미 저장된 작업 묶음과 단계 결과는 기존 화면에서 이어서 관리한다.

## 세 가지 출발점

`POST /api/topics`는 `entry`로 출발점을 받는다. 생성은 모델을 호출하지 않는다. 중재자는 필요한 참여자·예산을 준비하고 다음 허용 액션을 실행한다.

```json
{"title":"검색 속도 개선","entry":{"mode":"goal","goal":"대표 검색의 지연을 측정하고 병목을 줄인다."}}
```

Goal 모드는 DRAFT에서 `actions/plan`으로 바로 계획을 시작한다.

```json
{"title":"주문 화면 구현","entry":{"mode":"sources","sources":[{"url":"https://example.atlassian.net/browse/APP-1","label":"주문 요구사항"}]}}
```

Source 모드는 DRAFT에서 원문 확인을 기다린다. 중재자가 제안한 URL은 기존 근거 목록 승인·수집 절차를 따른다. 각 사용자의 연결된 계정으로 원문을 읽고 요구사항·대안·결정을 구분한다. 링크 등록은 읽기 완료가 아니다. `GET /api/topics/:id/evidence`의 `ready`와 현재 `digest`를 확인한 뒤 다음 요청으로 Goal을 확정한다.

```json
{"goal":"확인한 요구사항을 충족하는 주문 화면을 만든다.","evidenceDigest":"현재 evidence 응답의 digest"}
```

요청 경로는 `POST /api/topics/:id/goal`이다. 실제 digest는 64자리 해시다. 시작 Source가 빠졌거나 미수집·오래된 근거이면 거부한다. Goal을 만든 뒤 원문이 바뀌면 현재 digest로 Goal을 다시 확인한 뒤 `actions/plan`을 호출한다. Goal 확정은 계획 승인을 대체하지 않는다. 계획의 근거 검토·해시 승인·구현 게이트는 그대로 남는다.

```json
{"title":"어떤 문제부터 풀지 논의","entry":{"mode":"brainstorm"}}
```

브레인스토밍은 BRAINSTORM_READY에서 `actions/brainstorm`으로 한 라운드씩 논의한다. `actions/brainstorm-plan`에 `{ "decision": "선택 이유", "goal": "달성할 결과" }`를 보내면 Goal을 저장하고 계획을 시작한다. 이전 클라이언트가 goal을 생략하면 명시한 decision을 Goal로 사용한다. `actions/brainstorm-close`는 논의만 마친다.

## 관리 주제와 실행 주제

- `topicKind: "group"`은 큰 그림을 관리한다. 구현용 worktree를 만들지 않으며 실행 계획·승인·구현을 거부한다. 브레인스토밍은 가능하고, `brainstorm-plan`은 Goal만 확정한다.
- `topicKind: "task"`가 기본값이며 말단 계획·구현을 담당한다. 각 실행 주제는 별도 worktree를 쓴다.
- `parentTopicId`에 Goal이 확정된 관리 주제 ID를 지정해 하위 주제를 만든다. 중간 관리 주제도 같은 방식으로 여러 단계 연결한다. 기존 부모를 바꾸거나 실행 주제를 관리 주제로 변환하지 않는다.
- 부모 연결은 생성 뒤 바꾸지 않는다. 하위 주제가 생긴 상위 Goal은 고정되며, 새 큰 범위는 새 관리 주제로 시작한다. 이 경계로 진행 중인 자식의 계획 근거가 조용히 바뀌는 것을 막는다.
- 상위 Goal은 큰 그림이고 현재 말단 Goal이 구현 범위다. 상위 Source는 말단에 자동으로 승인되지 않는다. 말단에서 사용할 실제 원문은 기존 근거 선택 절차로 연결한다.
- 사이드바는 모든 하위 말단 중 종료한 개수를 표시한다. 종료에는 구현 완료 외에 논의 종료도 포함되므로 성공률로 표시하지 않는다.

```json
{"title":"제품 개선","topicKind":"group","entry":{"mode":"goal","goal":"고객이 핵심 작업을 끝내기 쉽게 만든다."}}
```

```json
{"title":"첫 화면 개선","topicKind":"group","parentTopicId":"위 응답의 UUID","entry":{"mode":"goal","goal":"첫 화면에서 다음 행동을 찾게 한다."}}
```

```json
{"title":"첫 행동 안내","parentTopicId":"중간 주제의 UUID","entry":{"mode":"goal","goal":"첫 행동 안내를 구현하고 검증한다."}}
```

모든 변경 요청에는 인증과 Idempotency-Key가 필요하다. 중재자 호출은 현재 배정 신원을 보낸다. 자식 생성은 부모의 중재자 배정을 확인하며, 생성된 자식의 실행 배정은 기존 topic → global 우선순위다. `resume`에서 저장된 entry, 계층, 다음 허용 행동을 확인한다. 예전 `startMode: plan|brainstorm` 생성 요청과 기존 주제는 호환한다. 이전 `predecessorTopicId`는 후속 쟁점 연결이며 부모 관계와 다르다.

## 기존 작업 정리

사용자는 `POST /api/topics/:id/adopt`로 부모 없는 기존 실행 주제를 Goal이 확정된 관리 주제 아래에 연결할 수 있다. 본문은 `{ "topicIds": ["기존 주제 UUID"], "workGroupIds": ["기존 작업 묶음 UUID"] }`다. 실행 중인 작업·다른 저장소·이미 다른 부모가 있는 주제는 거부하며, 한 묶음의 단계는 묶음 전체로 연결한다. 기존 계획·승인·완료 결과와 단계 문맥 해시는 보존한다. 상위 목표는 범위를 넓히는 지시가 아니며, 기존 실행 범위를 바꾸려면 별도의 범위 변경 절차가 필요하다.

작업 묶음 생성 API도 `parentTopicId`를 받는다. 연결된 묶음에서 이후 여는 단계는 같은 부모 아래에 생성된다. 웹에서는 묶음을 선택한 관리 주제의 우측 패널에서 확인한다. 사이드바에는 Root 계층을 표시하며, 하위 주제는 펼쳐서 탐색한다.
