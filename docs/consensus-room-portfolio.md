# AI 개발 작업 관리

Claude와 Codex의 계획·구현·검토, 그리고 판단에 사용한 자료를 연결한 작업 공간.

```diagram
{
  "section": "OVERVIEW",
  "lead": "Claude와 Codex의 계획·구현·검토, 그리고 판단에 사용한 자료를 연결한 작업 공간.",
  "elements": [
    {
      "kind": "image",
      "x": 0,
      "y": 0,
      "w": 511,
      "h": 332,
      "path": "images/consensus-room-session-graph.png"
    },
    {
      "kind": "node",
      "x": 0,
      "y": 349,
      "w": 158,
      "h": 69,
      "label": "역할 카드",
      "body": "누가 무엇을 담당하는가",
      "color": "blue",
      "body_size": 9
    },
    {
      "kind": "node",
      "x": 176,
      "y": 349,
      "w": 158,
      "h": 69,
      "label": "원문 카드",
      "body": "Slack · Jira · Figma",
      "color": "coral",
      "body_size": 9
    },
    {
      "kind": "node",
      "x": 352,
      "y": 349,
      "w": 159,
      "h": 69,
      "label": "연결선",
      "body": "관계와 실제 전달 기록",
      "color": "teal",
      "body_size": 9
    }
  ],
  "notes": [
    {
      "title": "시작 배경",
      "body": "도구 사이에서 계획과 자료를 옮기고, 승인·리뷰 대상을 다시 확인하는 반복 작업."
    },
    {
      "title": "핵심 설계",
      "body": "읽은 자료, 승인 계획, 검토한 코드, 실제 커밋 사이의 연결 기록."
    }
  ],
  "source": "화면: 사용자 제공 세션 그래프. 역할별 모델 배정과 상태는 촬영 당시의 사례."
}
```

## 시작 배경

도구 사이에서 계획과 자료를 옮기고, 승인·리뷰 대상을 다시 확인하는 반복 작업.

## 핵심 설계

읽은 자료, 승인 계획, 검토한 코드, 실제 커밋 사이의 연결 기록.

관련 자료: 화면: 사용자 제공 세션 그래프. 역할별 모델 배정과 상태는 촬영 당시의 사례.

# 전체 목표와 단계별 계획

전체 방향은 먼저 정하고, 실행할 단계는 앞 단계의 실제 결과를 바탕으로 구체화.

```diagram
{
  "section": "PLANNING",
  "lead": "전체 방향은 먼저 정하고, 실행할 단계는 앞 단계의 실제 결과를 바탕으로 구체화.",
  "elements": [
    {
      "kind": "group",
      "x": 0,
      "y": 10,
      "w": 511,
      "h": 153,
      "label": "이전 방식"
    },
    {
      "kind": "node",
      "x": 18,
      "y": 52,
      "w": 134,
      "h": 77,
      "label": "전체 요구사항",
      "body": "모든 단계의 세부 정보",
      "color": "gray",
      "body_size": 9
    },
    {
      "kind": "arrow",
      "points": [
        [
          152,
          91
        ],
        [
          189,
          91
        ]
      ],
      "color": "gray"
    },
    {
      "kind": "node",
      "x": 189,
      "y": 52,
      "w": 134,
      "h": 77,
      "label": "한 번에 상세화",
      "body": "큰 입력 · 빠진 근거",
      "color": "gray",
      "body_size": 9
    },
    {
      "kind": "arrow",
      "points": [
        [
          323,
          91
        ],
        [
          360,
          91
        ]
      ],
      "color": "gray"
    },
    {
      "kind": "node",
      "x": 360,
      "y": 52,
      "w": 133,
      "h": 77,
      "label": "입력 상한 도달",
      "body": "압축 · 재설명 반복",
      "color": "red",
      "body_size": 9
    },
    {
      "kind": "group",
      "x": 0,
      "y": 185,
      "w": 511,
      "h": 227,
      "label": "현재 방식"
    },
    {
      "kind": "node",
      "x": 18,
      "y": 227,
      "w": 134,
      "h": 83,
      "label": "전체 목표",
      "body": "의존 관계 · 공통 계약",
      "color": "blue",
      "body_size": 9
    },
    {
      "kind": "node",
      "x": 189,
      "y": 227,
      "w": 134,
      "h": 83,
      "label": "현재 단계",
      "body": "구현 · 검사 · 완료",
      "color": "teal",
      "body_size": 9
    },
    {
      "kind": "node",
      "x": 360,
      "y": 227,
      "w": 133,
      "h": 83,
      "label": "다음 단계",
      "body": "결과 확인 후 상세화",
      "color": "purple",
      "body_size": 9
    },
    {
      "kind": "arrow",
      "points": [
        [
          152,
          269
        ],
        [
          189,
          269
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          323,
          269
        ],
        [
          360,
          269
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "text",
      "x": 30,
      "y": 337,
      "w": 451,
      "label": "원문은 나눠 읽기  /  미래 단계는 개요 유지  /  무관한 결과는 보존",
      "align": 1,
      "size": 10
    }
  ],
  "notes": [
    {
      "title": "단계의 기준",
      "body": "파일 수나 코드 줄 수보다, 끝난 뒤 확인할 수 있는 결과."
    },
    {
      "title": "입력과 예산",
      "body": "한 번에 읽을 크기와 전체 실행 비용을 별도로 관리."
    }
  ],
  "source": ""
}
```

## 단계의 기준

파일 수나 코드 줄 수보다, 끝난 뒤 확인할 수 있는 결과.

## 입력과 예산

한 번에 읽을 크기와 전체 실행 비용을 별도로 관리.

# 화면·엔진·실행 도구의 역할

상태와 권한을 판단하는 엔진, 모델을 호출하는 런타임, 사실을 보존하는 저장소.

```diagram
{
  "section": "ARCHITECTURE",
  "lead": "상태와 권한을 판단하는 엔진, 모델을 호출하는 런타임, 사실을 보존하는 저장소.",
  "elements": [
    {
      "kind": "node",
      "x": 120,
      "y": 0,
      "w": 271,
      "h": 69,
      "label": "웹 화면 · 중재 CLI",
      "body": "진행 확인 · 결정 전달 · 재개",
      "color": "blue"
    },
    {
      "kind": "arrow",
      "points": [
        [
          255,
          69
        ],
        [
          255,
          94
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 120,
      "y": 94,
      "w": 271,
      "h": 78,
      "label": "작업 엔진",
      "body": "계획 · 승인 · 검토 · 다음 행동",
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          190,
          172
        ],
        [
          190,
          202
        ],
        [
          107,
          202
        ],
        [
          107,
          231
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          325,
          172
        ],
        [
          325,
          202
        ],
        [
          402,
          202
        ],
        [
          402,
          231
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 0,
      "y": 231,
      "w": 215,
      "h": 86,
      "label": "공통 실행 런타임",
      "body": "세션 · 사용량 · 종료 · 오류",
      "color": "purple"
    },
    {
      "kind": "node",
      "x": 296,
      "y": 231,
      "w": 215,
      "h": 86,
      "label": "저장소 · Git",
      "body": "승인 기록 · 원문 · 실제 코드",
      "color": "coral",
      "icon": "github"
    },
    {
      "kind": "arrow",
      "points": [
        [
          56,
          317
        ],
        [
          56,
          345
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          162,
          317
        ],
        [
          162,
          345
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 0,
      "y": 345,
      "w": 100,
      "h": 75,
      "label": "Claude",
      "body": "CLI 어댑터",
      "color": "coral",
      "icon": "claude",
      "size": 10,
      "body_size": 9
    },
    {
      "kind": "node",
      "x": 115,
      "y": 345,
      "w": 100,
      "h": 75,
      "label": "Codex",
      "body": "CLI 어댑터",
      "color": "gray",
      "icon": "openai",
      "size": 10,
      "body_size": 9
    },
    {
      "kind": "text",
      "x": 296,
      "y": 345,
      "w": 215,
      "label": "SQLite: 상태와 사건\n해시 파일: 원문과 결과\nworktree: 격리된 코드",
      "size": 10
    }
  ],
  "notes": [
    {
      "title": "정책의 소유자",
      "body": "작업 승인과 예산은 엔진·리뷰가 각각 소유. 런타임은 실행 결과를 반환."
    },
    {
      "title": "변경의 경계",
      "body": "공급자 실행 방식을 바꿔도 작업 승인 규칙을 함께 바꿀 필요가 없는 구조."
    }
  ],
  "source": "src/server/runtime/ · src/server/engine/ · src/server/database.ts"
}
```

## 정책의 소유자

작업 승인과 예산은 엔진·리뷰가 각각 소유. 런타임은 실행 결과를 반환.

## 변경의 경계

공급자 실행 방식을 바꿔도 작업 승인 규칙을 함께 바꿀 필요가 없는 구조.

관련 자료: src/server/runtime/ · src/server/engine/ · src/server/database.ts

# 계층별 책임과 공통 계약

수집 사실과 작업 판단을 분리하고, 다음 행동은 엔진의 공통 조건으로 실행.

```diagram
{
  "section": "ARCHITECTURE",
  "lead": "수집 사실과 작업 판단을 분리하고, 다음 행동은 엔진의 공통 조건으로 실행.",
  "elements": [
    {
      "kind": "node",
      "x": 0,
      "y": 0,
      "w": 350,
      "h": 65,
      "label": "① 수집 어댑터",
      "body": "요청 · 응답 · 오류의 실제 관측",
      "color": "blue"
    },
    {
      "kind": "node",
      "x": 0,
      "y": 87,
      "w": 350,
      "h": 65,
      "label": "② 근거 생명주기",
      "body": "현재 요청 · 미수신 · 접근 실패 · 재수집",
      "color": "blue"
    },
    {
      "kind": "node",
      "x": 0,
      "y": 174,
      "w": 350,
      "h": 65,
      "label": "③ 구현자 · 리뷰어",
      "body": "진행 가능한 범위와 후속 작업 판단",
      "color": "purple"
    },
    {
      "kind": "node",
      "x": 0,
      "y": 261,
      "w": 350,
      "h": 65,
      "label": "④ 작업 엔진",
      "body": "현재 계획의 승인 · 복구 · 완료 조건",
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 0,
      "y": 348,
      "w": 350,
      "h": 65,
      "label": "⑤ 진행 조정기",
      "body": "승인된 다음 행동과 결과 연결",
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          175,
          65
        ],
        [
          175,
          87
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          175,
          152
        ],
        [
          175,
          174
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          175,
          239
        ],
        [
          175,
          261
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          175,
          326
        ],
        [
          175,
          348
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "text",
      "x": 370,
      "y": 17,
      "w": 141,
      "label": "제품 결정 없음",
      "size": 10
    },
    {
      "kind": "text",
      "x": 370,
      "y": 105,
      "w": 141,
      "label": "성공 추정 없음",
      "size": 10
    },
    {
      "kind": "text",
      "x": 370,
      "y": 191,
      "w": 141,
      "label": "모델 판단 보존",
      "size": 10
    },
    {
      "kind": "text",
      "x": 370,
      "y": 278,
      "w": 141,
      "label": "공통 검사 재사용",
      "size": 10
    },
    {
      "kind": "text",
      "x": 370,
      "y": 365,
      "w": 141,
      "label": "승인 규칙 복제 없음",
      "size": 10
    }
  ],
  "notes": [
    {
      "title": "구조적 문제",
      "body": "서로의 내부 상태를 각자 해석하던 경로를 타입과 공통 인터페이스로 정리."
    },
    {
      "title": "검증 방식",
      "body": "타입 검사와 함께 실제 Git·API·DB 재연결로 중지·복구 소비 경로 확인."
    }
  ],
  "source": "src/server/evidence/readLifecycle.ts · src/server/workflow.ts · src/server/engine/continuation.ts"
}
```

## 구조적 문제

서로의 내부 상태를 각자 해석하던 경로를 타입과 공통 인터페이스로 정리.

## 검증 방식

타입 검사와 함께 실제 Git·API·DB 재연결로 중지·복구 소비 경로 확인.

관련 자료: src/server/evidence/readLifecycle.ts · src/server/workflow.ts · src/server/engine/continuation.ts

# 역할·프로필·배정·세션

역할은 책임, 프로필은 실행 설정, 배정은 연결 관계, 세션은 대화 기록.

```diagram
{
  "section": "PARTICIPANTS",
  "lead": "역할은 책임, 프로필은 실행 설정, 배정은 연결 관계, 세션은 대화 기록.",
  "elements": [
    {
      "kind": "node",
      "x": 0.0,
      "y": 35,
      "w": 114.25,
      "h": 113,
      "label": "역할",
      "body": "계획 · 구현 · 리뷰",
      "color": "blue"
    },
    {
      "kind": "arrow",
      "points": [
        [
          114.25,
          91.5
        ],
        [
          132.25,
          91.5
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 132.25,
      "y": 35,
      "w": 114.25,
      "h": 113,
      "label": "프로필",
      "body": "공급자 · 모델 · 강도",
      "color": "purple"
    },
    {
      "kind": "arrow",
      "points": [
        [
          246.5,
          91.5
        ],
        [
          264.5,
          91.5
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 264.5,
      "y": 35,
      "w": 114.25,
      "h": 113,
      "label": "배정",
      "body": "작업별 연결과 버전",
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          378.75,
          91.5
        ],
        [
          396.75,
          91.5
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 396.75,
      "y": 35,
      "w": 114.25,
      "h": 113,
      "label": "세션",
      "body": "호환되는 대화 기록",
      "color": "coral"
    },
    {
      "kind": "group",
      "x": 0,
      "y": 196,
      "w": 511,
      "h": 207,
      "label": "공급자 연결"
    },
    {
      "kind": "node",
      "x": 30,
      "y": 241,
      "w": 210,
      "h": 87,
      "label": "Claude",
      "body": "역할에 맞는 CLI 실행",
      "color": "coral",
      "icon": "claude"
    },
    {
      "kind": "node",
      "x": 271,
      "y": 241,
      "w": 210,
      "h": 87,
      "label": "Codex / OpenAI",
      "body": "역할에 맞는 CLI 실행",
      "color": "gray",
      "icon": "openai"
    },
    {
      "kind": "text",
      "x": 35,
      "y": 350,
      "w": 441,
      "label": "실행 전 확인: 역할 지원 · 옵션 의미 · 모델 설정 · 세션 호환성",
      "size": 10,
      "align": 1
    }
  ],
  "notes": [
    {
      "title": "현재 지원",
      "body": "Claude·Codex 어댑터. 새 공급자는 실행·권한·세션·사용량·파싱 계약 구현 필요."
    },
    {
      "title": "설정의 보존",
      "body": "지원하지 않는 옵션을 같은 이름으로 간주하거나 다른 모델로 임의 대체하지 않음."
    }
  ],
  "source": "src/shared/roles.ts · src/server/roleAssignments.ts · src/server/runtime/providers.ts"
}
```

## 현재 지원

Claude·Codex 어댑터. 새 공급자는 실행·권한·세션·사용량·파싱 계약 구현 필요.

## 설정의 보존

지원하지 않는 옵션을 같은 이름으로 간주하거나 다른 모델로 임의 대체하지 않음.

관련 자료: src/shared/roles.ts · src/server/roleAssignments.ts · src/server/runtime/providers.ts

# 중재자의 확인 순서

대화의 마지막 문장보다 서버의 현재 상태·허용 행동·배정 신원을 먼저 확인.

```diagram
{
  "section": "MEDIATION",
  "lead": "대화의 마지막 문장보다 서버의 현재 상태·허용 행동·배정 신원을 먼저 확인.",
  "elements": [
    {
      "kind": "node",
      "x": 0.0,
      "y": 10,
      "w": 158.33333333333334,
      "h": 96,
      "label": "맥락 조회",
      "body": "진행 중 작업과 목표",
      "color": "blue"
    },
    {
      "kind": "arrow",
      "points": [
        [
          158.33333333333334,
          58.0
        ],
        [
          176.33333333333334,
          58.0
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 176.33333333333334,
      "y": 10,
      "w": 158.33333333333334,
      "h": 96,
      "label": "재개 상태",
      "body": "열린 질문 · 남은 지적",
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          334.6666666666667,
          58.0
        ],
        [
          352.6666666666667,
          58.0
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 352.6666666666667,
      "y": 10,
      "w": 158.33333333333334,
      "h": 96,
      "label": "배정 확인",
      "body": "현재 중재자와 버전",
      "color": "purple"
    },
    {
      "kind": "arrow",
      "points": [
        [
          425,
          106
        ],
        [
          425,
          124
        ],
        [
          255,
          124
        ],
        [
          255,
          143
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "diamond",
      "x": 170,
      "y": 143,
      "w": 170,
      "h": 94,
      "label": "다음 행동",
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          170,
          190
        ],
        [
          86,
          190
        ],
        [
          86,
          276
        ]
      ],
      "color": "blue"
    },
    {
      "kind": "arrow",
      "points": [
        [
          255,
          237
        ],
        [
          255,
          276
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          340,
          190
        ],
        [
          425,
          190
        ],
        [
          425,
          276
        ]
      ],
      "color": "coral"
    },
    {
      "kind": "node",
      "x": 0,
      "y": 276,
      "w": 165,
      "h": 105,
      "label": "실행 중",
      "body": "중복 시작 없이\n진행 기록 확인",
      "color": "blue"
    },
    {
      "kind": "node",
      "x": 173,
      "y": 276,
      "w": 165,
      "h": 105,
      "label": "승인 범위 안",
      "body": "수정 · 재개\n다음 단계 준비",
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 346,
      "y": 276,
      "w": 165,
      "h": 105,
      "label": "실제 결정 필요",
      "body": "제품 · 권한 · 인증\n구체적인 질문",
      "color": "coral"
    }
  ],
  "notes": [
    {
      "title": "중재자 교체",
      "body": "기존 승인·질문·작업 기록을 보존한 채 같은 공식 재개 정보에서 시작."
    },
    {
      "title": "권한의 범위",
      "body": "자동 진행도 해당 작업의 로컬 완료·원격 전달·운영 설치 권한을 따라 실행."
    }
  ],
  "source": "docs/mediation/policy.md · src/server/mediationAutonomy.ts"
}
```

## 중재자 교체

기존 승인·질문·작업 기록을 보존한 채 같은 공식 재개 정보에서 시작.

## 권한의 범위

자동 진행도 해당 작업의 로컬 완료·원격 전달·운영 설치 권한을 따라 실행.

관련 자료: docs/mediation/policy.md · src/server/mediationAutonomy.ts

# 서버가 맡는 연속 실행

승인된 행동을 DB에 저장하고, 대화의 알림 수신 여부와 별도로 실행 결과를 추적.

```diagram
{
  "section": "CONTINUATION",
  "lead": "승인된 행동을 DB에 저장하고, 대화의 알림 수신 여부와 별도로 실행 결과를 추적.",
  "elements": [
    {
      "kind": "node",
      "x": 0,
      "y": 0,
      "w": 205,
      "h": 74,
      "label": "자동 진행 승인",
      "body": "계획 · 범위 · 중재자 · 전달 권한",
      "color": "blue",
      "body_size": 9
    },
    {
      "kind": "arrow",
      "points": [
        [
          205,
          37
        ],
        [
          260,
          37
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 260,
      "y": 0,
      "w": 251,
      "h": 74,
      "label": "저장된 진행 예약",
      "body": "단계 · 액션 ID · 실제 결과",
      "color": "purple",
      "body_size": 9
    },
    {
      "kind": "node",
      "x": 0.0,
      "y": 145,
      "w": 114.25,
      "h": 89,
      "label": "근거 검토",
      "body": "현재 계획 영향",
      "color": "blue"
    },
    {
      "kind": "arrow",
      "points": [
        [
          114.25,
          189.5
        ],
        [
          132.25,
          189.5
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 132.25,
      "y": 145,
      "w": 114.25,
      "h": 89,
      "label": "구현 · 리뷰",
      "body": "같은 승인 계획",
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          246.5,
          189.5
        ],
        [
          264.5,
          189.5
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 264.5,
      "y": 145,
      "w": 114.25,
      "h": 89,
      "label": "로컬 완료",
      "body": "검토한 결과",
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          378.75,
          189.5
        ],
        [
          396.75,
          189.5
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 396.75,
      "y": 145,
      "w": 114.25,
      "h": 89,
      "label": "다음 계획",
      "body": "지정된 단계",
      "color": "purple"
    },
    {
      "kind": "arrow",
      "points": [
        [
          384,
          74
        ],
        [
          384,
          113
        ],
        [
          58,
          113
        ],
        [
          58,
          145
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "group",
      "x": 0,
      "y": 276,
      "w": 511,
      "h": 140,
      "label": "중지·실패·재시작"
    },
    {
      "kind": "text",
      "x": 18,
      "y": 312,
      "w": 229,
      "label": "서버 재시작 → 예약·실행 대조\n예약만 저장 → 미실행 확인 후 진행",
      "size": 10
    },
    {
      "kind": "text",
      "x": 270,
      "y": 312,
      "w": 223,
      "label": "사용자 중지 → 명시적 재개\n새 실패 → 재개 조건 확인",
      "size": 10
    }
  ],
  "notes": [
    {
      "title": "단일 저장 단위",
      "body": "실행 상태·재개 위치·전이 사건을 하나의 DB 트랜잭션으로 기록."
    },
    {
      "title": "다음 계획의 승인",
      "body": "새 계획 승인과 필수 검사는 별도 유지. 사용자 중지를 일반 재시도로 해제하지 않음."
    }
  ],
  "source": "src/server/engine/continuation.ts · src/server/continuationStore.ts · src/shared/workflowLifecycle.ts"
}
```

## 단일 저장 단위

실행 상태·재개 위치·전이 사건을 하나의 DB 트랜잭션으로 기록.

## 다음 계획의 승인

새 계획 승인과 필수 검사는 별도 유지. 사용자 중지를 일반 재시도로 해제하지 않음.

관련 자료: src/server/engine/continuation.ts · src/server/continuationStore.ts · src/shared/workflowLifecycle.ts

# 완료 결과를 기준으로 한 단계 분리

같은 결과를 만드는 설계·구현·검사는 한 단계 안의 체크리스트로 구성.

```diagram
{
  "section": "PLANNING",
  "lead": "같은 결과를 만드는 설계·구현·검사는 한 단계 안의 체크리스트로 구성.",
  "elements": [
    {
      "kind": "group",
      "x": 0,
      "y": 0,
      "w": 511,
      "h": 133,
      "label": "지나치게 잘게 나눈 작업"
    },
    {
      "kind": "node",
      "x": 0.0,
      "y": 44,
      "w": 114.25,
      "h": 60,
      "label": "타입 작성",
      "body": "",
      "color": "gray"
    },
    {
      "kind": "arrow",
      "points": [
        [
          114.25,
          74.0
        ],
        [
          132.25,
          74.0
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 132.25,
      "y": 44,
      "w": 114.25,
      "h": 60,
      "label": "구현",
      "body": "",
      "color": "gray"
    },
    {
      "kind": "arrow",
      "points": [
        [
          246.5,
          74.0
        ],
        [
          264.5,
          74.0
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 264.5,
      "y": 44,
      "w": 114.25,
      "h": 60,
      "label": "테스트",
      "body": "",
      "color": "gray"
    },
    {
      "kind": "arrow",
      "points": [
        [
          378.75,
          74.0
        ],
        [
          396.75,
          74.0
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 396.75,
      "y": 44,
      "w": 114.25,
      "h": 60,
      "label": "설명·인계",
      "body": "",
      "color": "gray"
    },
    {
      "kind": "group",
      "x": 0,
      "y": 168,
      "w": 327,
      "h": 239,
      "label": "하나의 결과"
    },
    {
      "kind": "node",
      "x": 20,
      "y": 215,
      "w": 287,
      "h": 88,
      "label": "파서 계약 완성",
      "body": "타입 + 구현 + 테스트\n같은 입력·출력 조건",
      "color": "teal"
    },
    {
      "kind": "text",
      "x": 26,
      "y": 326,
      "w": 270,
      "label": "완료 조건 · 검사 방법 · 질문\n앞 단계 결과 확인 후 상세화",
      "size": 11
    },
    {
      "kind": "node",
      "x": 372,
      "y": 233,
      "w": 139,
      "h": 107,
      "label": "별도 단계",
      "body": "독립 검증 또는\n앞 결과가 필요한 작업",
      "color": "purple",
      "body_size": 9
    },
    {
      "kind": "arrow",
      "points": [
        [
          327,
          284
        ],
        [
          372,
          284
        ]
      ],
      "color": "teal"
    }
  ],
  "notes": [
    {
      "title": "분리 사유",
      "body": "결과 의존성, 독립 검증, 별도 되돌리기 필요성으로 설명."
    },
    {
      "title": "실행 순서",
      "body": "기본 한 단계씩 진행. 외부 결정을 기다릴 때 준비된 독립 단계 선택 가능."
    }
  ],
  "source": "src/shared/workGroups.ts · src/server/workGroups.ts"
}
```

## 분리 사유

결과 의존성, 독립 검증, 별도 되돌리기 필요성으로 설명.

## 실행 순서

기본 한 단계씩 진행. 외부 결정을 기다릴 때 준비된 독립 단계 선택 가능.

관련 자료: src/shared/workGroups.ts · src/server/workGroups.ts

# 근거 변경과 판단 보존

변경된 근거의 영향만 다시 확인하고, 관련 없는 결과와 기존 구현 의무는 보존.

```diagram
{
  "section": "EVIDENCE",
  "lead": "변경된 근거의 영향만 다시 확인하고, 관련 없는 결과와 기존 구현 의무는 보존.",
  "elements": [
    {
      "kind": "node",
      "x": 171,
      "y": 0,
      "w": 170,
      "h": 71,
      "label": "원문 변경",
      "body": "현재 계획과 대조",
      "color": "blue"
    },
    {
      "kind": "arrow",
      "points": [
        [
          256,
          71
        ],
        [
          256,
          101
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "diamond",
      "x": 170,
      "y": 101,
      "w": 172,
      "h": 105,
      "label": "계획에 영향?",
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          170,
          154
        ],
        [
          80,
          154
        ],
        [
          80,
          237
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          342,
          154
        ],
        [
          426,
          154
        ],
        [
          426,
          237
        ]
      ],
      "color": "coral"
    },
    {
      "kind": "text",
      "x": 96,
      "y": 173,
      "w": 83,
      "label": "영향 없음",
      "align": 1,
      "ink": "#087F80"
    },
    {
      "kind": "text",
      "x": 333,
      "y": 173,
      "w": 83,
      "label": "영향 있음",
      "align": 1,
      "ink": "#BF674A"
    },
    {
      "kind": "node",
      "x": 0,
      "y": 237,
      "w": 164,
      "h": 105,
      "label": "기존 판단 유지",
      "body": "계획 · 세션 · 유효한 검사\n기존 구현 의무",
      "color": "teal",
      "body_size": 9
    },
    {
      "kind": "node",
      "x": 345,
      "y": 237,
      "w": 166,
      "h": 105,
      "label": "관련 판단 갱신",
      "body": "바뀐 요구 · 근거\n영향받는 계획",
      "color": "coral",
      "body_size": 9
    },
    {
      "kind": "text",
      "x": 20,
      "y": 375,
      "w": 471,
      "label": "구현 의무의 동일성: ID + 내용 + 처분 + 근거 + 결정 여부",
      "size": 10,
      "align": 1
    }
  ],
  "notes": [
    {
      "title": "재계획 실패",
      "body": "변경을 대기 상태로 보존하고, 이전 실행의 늦은 응답을 새 결과로 수락하지 않음."
    },
    {
      "title": "판단의 구분",
      "body": "계획 뒤 수행할 구현·검증을 현재 계획에 필요한 증거 부족으로 분류하지 않음."
    }
  ],
  "source": ""
}
```

## 재계획 실패

변경을 대기 상태로 보존하고, 이전 실행의 늦은 응답을 새 결과로 수락하지 않음.

## 판단의 구분

계획 뒤 수행할 구현·검증을 현재 계획에 필요한 증거 부족으로 분류하지 않음.

# 원문의 분할 조회와 읽음 기록

자료의 출처·버전·위치와 실제 전달 구간을 함께 보존.

```diagram
{
  "section": "READING",
  "lead": "자료의 출처·버전·위치와 실제 전달 구간을 함께 보존.",
  "elements": [
    {
      "kind": "node",
      "x": 0,
      "y": 14,
      "w": 129,
      "h": 189,
      "label": "큰 원문",
      "body": "전체 문서\n버전 v3\n내용 해시",
      "color": "blue"
    },
    {
      "kind": "arrow",
      "points": [
        [
          129,
          52
        ],
        [
          175,
          52
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 175,
      "y": 14,
      "w": 145,
      "h": 76,
      "label": "조각 1",
      "body": "0 ~ 4,000 바이트",
      "color": "teal",
      "body_size": 9
    },
    {
      "kind": "node",
      "x": 175,
      "y": 112,
      "w": 145,
      "h": 76,
      "label": "조각 2",
      "body": "다음 위치부터 계속",
      "color": "teal",
      "body_size": 9
    },
    {
      "kind": "node",
      "x": 175,
      "y": 210,
      "w": 145,
      "h": 76,
      "label": "조각 3",
      "body": "완료 위치 확인",
      "color": "purple",
      "body_size": 9
    },
    {
      "kind": "arrow",
      "points": [
        [
          247,
          90
        ],
        [
          247,
          112
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          247,
          188
        ],
        [
          247,
          210
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          320,
          150
        ],
        [
          366,
          150
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 366,
      "y": 92,
      "w": 145,
      "h": 126,
      "label": "읽음 기록",
      "body": "출처 · 버전\n해시 · 범위\n역할 · 세션",
      "color": "coral",
      "body_size": 10
    },
    {
      "kind": "group",
      "x": 0,
      "y": 329,
      "w": 511,
      "h": 88,
      "label": "완료 전 확인"
    },
    {
      "kind": "text",
      "x": 18,
      "y": 363,
      "w": 476,
      "label": "필수 읽기 완료  /  추가 조회가 남으면 중간 응답  /  무진척 반복 구분",
      "size": 10,
      "align": 1
    }
  ],
  "notes": [
    {
      "title": "분할 기준",
      "body": "호출 크기와 전체 예산을 구분. 원문을 조용히 잘라 버리지 않음."
    },
    {
      "title": "세션 복구",
      "body": "실제 문맥 초과·세션 손실에서 체크포인트로 복구. 설정과 누적 사용량 보존."
    }
  ],
  "source": "docs/guarded-planning.md"
}
```

## 분할 기준

호출 크기와 전체 예산을 구분. 원문을 조용히 잘라 버리지 않음.

## 세션 복구

실제 문맥 초과·세션 손실에서 체크포인트로 복구. 설정과 누적 사용량 보존.

관련 자료: docs/guarded-planning.md

# 위키 검색과 실제 근거의 구분

색인에서 찾은 문서와 실제로 읽고 판단에 사용한 원문을 구분.

```diagram
{
  "section": "KNOWLEDGE",
  "lead": "색인에서 찾은 문서와 실제로 읽고 판단에 사용한 원문을 구분.",
  "elements": [
    {
      "kind": "node",
      "x": 0.0,
      "y": 36,
      "w": 114.25,
      "h": 108,
      "label": "질문",
      "body": "지금 해결할 문제",
      "color": "blue"
    },
    {
      "kind": "arrow",
      "points": [
        [
          114.25,
          90.0
        ],
        [
          132.25,
          90.0
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 132.25,
      "y": 36,
      "w": 114.25,
      "h": 108,
      "label": "위키 색인",
      "body": "관련 문서의 위치",
      "color": "purple"
    },
    {
      "kind": "arrow",
      "points": [
        [
          246.5,
          90.0
        ],
        [
          264.5,
          90.0
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 264.5,
      "y": 36,
      "w": 114.25,
      "h": 108,
      "label": "본문 조회",
      "body": "필요한 원문",
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          378.75,
          90.0
        ],
        [
          396.75,
          90.0
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 396.75,
      "y": 36,
      "w": 114.25,
      "h": 108,
      "label": "판단 근거",
      "body": "읽은 버전과 범위",
      "color": "coral"
    },
    {
      "kind": "group",
      "x": 0,
      "y": 194,
      "w": 511,
      "h": 209,
      "label": "서로 다른 네 가지 측정"
    },
    {
      "kind": "node",
      "x": 16,
      "y": 230,
      "w": 232,
      "h": 69,
      "label": "검색 정확도",
      "body": "필요한 자료를 찾았는가",
      "color": "blue",
      "body_size": 9
    },
    {
      "kind": "node",
      "x": 264,
      "y": 230,
      "w": 231,
      "h": 69,
      "label": "근거 최신성",
      "body": "읽은 버전이 현재 원문인가",
      "color": "teal",
      "body_size": 9
    },
    {
      "kind": "node",
      "x": 16,
      "y": 315,
      "w": 232,
      "h": 69,
      "label": "전달량",
      "body": "실제로 보낸 본문 바이트",
      "color": "purple",
      "body_size": 9
    },
    {
      "kind": "node",
      "x": 264,
      "y": 315,
      "w": 231,
      "h": 69,
      "label": "실제 비용",
      "body": "입력 · 캐시 · 출력 사용량",
      "color": "coral",
      "body_size": 9
    }
  ],
  "notes": [
    {
      "title": "변경의 의미",
      "body": "새 원문이 질문·제안·결정 중 무엇인지, 어느 플랫폼에 적용되는지 확인."
    },
    {
      "title": "검색과 비용",
      "body": "검색 정확도 개선이 토큰 절감을 뜻하지 않음. 더 많은 관련 문서를 읽을 수도 있음."
    }
  ],
  "source": "docs/memory-retrieval.md · src/server/wikiEvidence.ts"
}
```

## 변경의 의미

새 원문이 질문·제안·결정 중 무엇인지, 어느 플랫폼에 적용되는지 확인.

## 검색과 비용

검색 정확도 개선이 토큰 절감을 뜻하지 않음. 더 많은 관련 문서를 읽을 수도 있음.

관련 자료: docs/memory-retrieval.md · src/server/wikiEvidence.ts

# Slack·Jira·Figma 자료 흐름

등록한 출처의 변경 감지와 모델에 전달할 근거의 판단을 분리.

```diagram
{
  "section": "SOURCES",
  "lead": "등록한 출처의 변경 감지와 모델에 전달할 근거의 판단을 분리.",
  "elements": [
    {
      "kind": "node",
      "x": 0,
      "y": 0,
      "w": 159,
      "h": 99,
      "label": "Slack",
      "body": "대화 페이지\n수정 · 삭제 확인",
      "color": "purple",
      "icon": "slack",
      "body_size": 10
    },
    {
      "kind": "node",
      "x": 176,
      "y": 0,
      "w": 159,
      "h": 99,
      "label": "Jira",
      "body": "본문 · 댓글\n변경 시점 확인",
      "color": "blue",
      "icon": "jira",
      "body_size": 10
    },
    {
      "kind": "node",
      "x": 352,
      "y": 0,
      "w": 159,
      "h": 99,
      "label": "Figma",
      "body": "파일 버전\n관련 노드 비교",
      "color": "coral",
      "icon": "figma",
      "body_size": 10
    },
    {
      "kind": "arrow",
      "points": [
        [
          80,
          99
        ],
        [
          80,
          142
        ],
        [
          255,
          142
        ],
        [
          255,
          174
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          255,
          99
        ],
        [
          255,
          174
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          431,
          99
        ],
        [
          431,
          142
        ],
        [
          255,
          142
        ],
        [
          255,
          174
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 105,
      "y": 174,
      "w": 301,
      "h": 72,
      "label": "수집 · 원문 보존",
      "body": "등록 출처 조회 / LLM 호출 없음",
      "color": "teal",
      "body_size": 10
    },
    {
      "kind": "arrow",
      "points": [
        [
          255,
          246
        ],
        [
          255,
          274
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 105,
      "y": 274,
      "w": 301,
      "h": 79,
      "label": "근거 영향 검토",
      "body": "현재 계획에 필요한 변경만 판단",
      "color": "purple"
    },
    {
      "kind": "text",
      "x": 32,
      "y": 382,
      "w": 447,
      "label": "계획: Figma 링크와 기능 흐름  /  구현: 필요한 화면·노드 직접 확인",
      "size": 10,
      "align": 1
    }
  ],
  "notes": [
    {
      "title": "주기적 확인",
      "body": "등록된 REST 출처의 조회 시점은 기본 15분 간격. 닫힌 작업만 쓰는 출처는 제외."
    },
    {
      "title": "수집의 한계",
      "body": "링크·캐시 이미지는 검증 완료가 아님. 접근 거부와 요청 제한은 실패로 보존."
    }
  ],
  "source": "docs/external-evidence.md · src/server/evidence/"
}
```

## 주기적 확인

등록된 REST 출처의 조회 시점은 기본 15분 간격. 닫힌 작업만 쓰는 출처는 제외.

## 수집의 한계

링크·캐시 이미지는 검증 완료가 아님. 접근 거부와 요청 제한은 실패로 보존.

관련 자료: docs/external-evidence.md · src/server/evidence/

# 자료 누락과 후속 작업

부족한 자료에 의존하는 부분만 후속 목록으로 넘기고, 확보한 근거의 범위에서 진행.

```diagram
{
  "section": "RECOVERY",
  "lead": "부족한 자료에 의존하는 부분만 후속 목록으로 넘기고, 확보한 근거의 범위에서 진행.",
  "elements": [
    {
      "kind": "node",
      "x": 170,
      "y": 0,
      "w": 171,
      "h": 70,
      "label": "자료 조회",
      "body": "실제 응답과 오류 확인",
      "color": "blue"
    },
    {
      "kind": "arrow",
      "points": [
        [
          255,
          70
        ],
        [
          255,
          94
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "diamond",
      "x": 171,
      "y": 94,
      "w": 169,
      "h": 102,
      "label": "확보한 근거",
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          171,
          145
        ],
        [
          82,
          145
        ],
        [
          82,
          220
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          340,
          145
        ],
        [
          427,
          145
        ],
        [
          427,
          220
        ]
      ],
      "color": "coral"
    },
    {
      "kind": "text",
      "x": 98,
      "y": 166,
      "w": 93,
      "label": "진행 가능",
      "align": 1,
      "ink": "#087F80"
    },
    {
      "kind": "text",
      "x": 324,
      "y": 166,
      "w": 93,
      "label": "부족한 부분",
      "align": 1,
      "ink": "#BF674A"
    },
    {
      "kind": "node",
      "x": 0,
      "y": 220,
      "w": 166,
      "h": 103,
      "label": "구현 · 리뷰",
      "body": "지원되는 동작\n같은 근거로 판단",
      "color": "teal",
      "body_size": 10
    },
    {
      "kind": "node",
      "x": 345,
      "y": 220,
      "w": 166,
      "h": 103,
      "label": "후속 목록",
      "body": "미수신 또는 접근 오류\n영향받는 동작 보존",
      "color": "coral",
      "body_size": 9
    },
    {
      "kind": "arrow",
      "points": [
        [
          427,
          323
        ],
        [
          427,
          361
        ],
        [
          255,
          361
        ],
        [
          255,
          383
        ]
      ],
      "color": "purple"
    },
    {
      "kind": "node",
      "x": 165,
      "y": 383,
      "w": 180,
      "h": 43,
      "label": "재수집 → 공백 해소",
      "body": "",
      "color": "purple",
      "size": 10
    }
  ],
  "notes": [
    {
      "title": "실패의 구분",
      "body": "미수신과 실제 접근 오류는 별도 기록. 새 요청의 성공 응답으로만 공백 해소."
    },
    {
      "title": "유지하는 조건",
      "body": "필수 검사 실패·제품 결정 부족을 자료 누락으로 강등하지 않음. 모델의 판단은 모델이 수행."
    }
  ],
  "source": "src/server/evidence/readLifecycle.ts · src/server/evidence/service.ts"
}
```

## 실패의 구분

미수신과 실제 접근 오류는 별도 기록. 새 요청의 성공 응답으로만 공백 해소.

## 유지하는 조건

필수 검사 실패·제품 결정 부족을 자료 누락으로 강등하지 않음. 모델의 판단은 모델이 수행.

관련 자료: src/server/evidence/readLifecycle.ts · src/server/evidence/service.ts

# 계획·구현·리뷰의 세션 연결

호환되는 대화와 유효한 읽음 기록을 이어 사용하고, 검토자의 판단 맥락은 별도로 유지.

```diagram
{
  "section": "SESSIONS",
  "lead": "호환되는 대화와 유효한 읽음 기록을 이어 사용하고, 검토자의 판단 맥락은 별도로 유지.",
  "elements": [
    {
      "kind": "group",
      "x": 0,
      "y": 0,
      "w": 511,
      "h": 177,
      "label": "설계·구현 대화"
    },
    {
      "kind": "node",
      "x": 18,
      "y": 47,
      "w": 216,
      "h": 98,
      "label": "계획",
      "body": "요구사항 · 코드 이해",
      "color": "coral",
      "icon": "claude"
    },
    {
      "kind": "node",
      "x": 277,
      "y": 47,
      "w": 216,
      "h": 98,
      "label": "구현",
      "body": "같은 판단 맥락의 재사용",
      "color": "coral",
      "icon": "claude",
      "body_size": 9
    },
    {
      "kind": "arrow",
      "points": [
        [
          234,
          96
        ],
        [
          277,
          96
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "group",
      "x": 0,
      "y": 206,
      "w": 511,
      "h": 177,
      "label": "독립된 검토 대화"
    },
    {
      "kind": "node",
      "x": 18,
      "y": 253,
      "w": 216,
      "h": 98,
      "label": "첫 리뷰",
      "body": "고정된 전체 변경 확인",
      "color": "gray",
      "icon": "openai"
    },
    {
      "kind": "node",
      "x": 277,
      "y": 253,
      "w": 216,
      "h": 98,
      "label": "후속 리뷰",
      "body": "수정분 · 미해결 지적 확인",
      "color": "gray",
      "icon": "openai",
      "body_size": 9
    },
    {
      "kind": "arrow",
      "points": [
        [
          234,
          302
        ],
        [
          277,
          302
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "text",
      "x": 16,
      "y": 399,
      "w": 480,
      "label": "연결 조건: 공급자 · 참여자 · 배정 · 입력 · 원문 버전",
      "size": 10,
      "align": 1
    }
  ],
  "notes": [
    {
      "title": "설정과 재사용",
      "body": "세션 이름만으로 연결하지 않음. 배정이 호환되지 않으면 재개를 강제하지 않음."
    },
    {
      "title": "사용량 보류 응답",
      "body": "같은 입력·세션·버전·전달 구간을 확인해 재사용. 새 결정·변경 원문은 다시 검토."
    }
  ],
  "source": "아이콘은 예시 배정. 역할별 공급자는 변경 가능."
}
```

## 설정과 재사용

세션 이름만으로 연결하지 않음. 배정이 호환되지 않으면 재개를 강제하지 않음.

## 사용량 보류 응답

같은 입력·세션·버전·전달 구간을 확인해 재사용. 새 결정·변경 원문은 다시 검토.

관련 자료: 아이콘은 예시 배정. 역할별 공급자는 변경 가능.

# 승인 계획과 검토 코드의 동일성

계획 내용, 리뷰 대상, 실제 결과를 각각 고정하고 같은 대상인지 대조.

```diagram
{
  "section": "INTEGRITY",
  "lead": "계획 내용, 리뷰 대상, 실제 결과를 각각 고정하고 같은 대상인지 대조.",
  "elements": [
    {
      "kind": "node",
      "x": 0,
      "y": 10,
      "w": 222,
      "h": 92,
      "label": "현재 계획",
      "body": "내용 정규화 → SHA-256",
      "color": "blue"
    },
    {
      "kind": "node",
      "x": 289,
      "y": 10,
      "w": 222,
      "h": 92,
      "label": "승인 대상",
      "body": "같은 계획 해시",
      "color": "blue"
    },
    {
      "kind": "arrow",
      "points": [
        [
          222,
          56
        ],
        [
          289,
          56
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "text",
      "x": 205,
      "y": 113,
      "w": 100,
      "label": "일치 확인",
      "align": 1,
      "ink": "#306DC0"
    },
    {
      "kind": "node",
      "x": 0,
      "y": 177,
      "w": 222,
      "h": 93,
      "label": "고정 리뷰 대상",
      "body": "기준 · 후보 커밋\n파일 목록 · 변경 내용",
      "color": "purple"
    },
    {
      "kind": "node",
      "x": 289,
      "y": 177,
      "w": 222,
      "h": 93,
      "label": "실제 완료 결과",
      "body": "검토한 트리와\n로컬 커밋의 트리",
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          222,
          223
        ],
        [
          289,
          223
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "group",
      "x": 0,
      "y": 326,
      "w": 511,
      "h": 94,
      "label": "리뷰 지적의 처리"
    },
    {
      "kind": "text",
      "x": 18,
      "y": 362,
      "w": 475,
      "label": "지적 ID → 수정 / 수용 / 반박 / 후속 이관 → 다음 리뷰에서 확인",
      "size": 10,
      "align": 1
    }
  ],
  "notes": [
    {
      "title": "동일성과 타당성",
      "body": "같은 해시는 같은 내용을 의미. 계획의 타당성은 별도 검토 대상."
    },
    {
      "title": "리뷰의 연속성",
      "body": "응답에서 빠진 지적을 해결로 처리하지 않음. 범위 밖 개선은 후속 작업에 기록."
    }
  ],
  "source": ""
}
```

## 동일성과 타당성

같은 해시는 같은 내용을 의미. 계획의 타당성은 별도 검토 대상.

## 리뷰의 연속성

응답에서 빠진 지적을 해결로 처리하지 않음. 범위 밖 개선은 후속 작업에 기록.

# 역할별 권한과 실행 종료

실행 권한·프로세스 종료·결과 형식을 모두 확인한 뒤 결과 수락.

```diagram
{
  "section": "EXECUTION",
  "lead": "실행 권한·프로세스 종료·결과 형식을 모두 확인한 뒤 결과 수락.",
  "elements": [
    {
      "kind": "node",
      "x": 0,
      "y": 0,
      "w": 156,
      "h": 90,
      "label": "계획 · 리뷰",
      "body": "읽기 권한",
      "color": "blue"
    },
    {
      "kind": "node",
      "x": 177,
      "y": 0,
      "w": 156,
      "h": 90,
      "label": "구현",
      "body": "허용된 쓰기 권한",
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 354,
      "y": 0,
      "w": 157,
      "h": 90,
      "label": "단순 확인",
      "body": "도구 없이 응답",
      "color": "gray"
    },
    {
      "kind": "arrow",
      "points": [
        [
          78,
          90
        ],
        [
          78,
          107
        ],
        [
          255,
          107
        ],
        [
          255,
          125
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          255,
          90
        ],
        [
          255,
          125
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          432,
          90
        ],
        [
          432,
          107
        ],
        [
          255,
          107
        ],
        [
          255,
          125
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 104,
      "y": 125,
      "w": 303,
      "h": 77,
      "label": "모델 실행",
      "body": "실행 신원 · 소유 프로세스 추적",
      "color": "purple"
    },
    {
      "kind": "arrow",
      "points": [
        [
          255,
          202
        ],
        [
          255,
          234
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "diamond",
      "x": 163,
      "y": 234,
      "w": 185,
      "h": 106,
      "label": "정상 종료와\n유효한 결과?",
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          163,
          287
        ],
        [
          65,
          287
        ],
        [
          65,
          365
        ]
      ],
      "color": "red"
    },
    {
      "kind": "arrow",
      "points": [
        [
          348,
          287
        ],
        [
          446,
          287
        ],
        [
          446,
          365
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "text",
      "x": 82,
      "y": 310,
      "w": 80,
      "label": "아니요",
      "ink": "#AF4D5D"
    },
    {
      "kind": "text",
      "x": 389,
      "y": 310,
      "w": 48,
      "label": "예",
      "ink": "#087F80"
    },
    {
      "kind": "node",
      "x": 0,
      "y": 365,
      "w": 158,
      "h": 61,
      "label": "실패 기록 보존",
      "body": "",
      "color": "red"
    },
    {
      "kind": "node",
      "x": 354,
      "y": 365,
      "w": 157,
      "h": 61,
      "label": "현재 실행에 수락",
      "body": "",
      "color": "teal"
    }
  ],
  "notes": [
    {
      "title": "늦은 응답",
      "body": "취소·재계획 뒤 도착한 결과는 현재 계획에 반영하지 않음."
    },
    {
      "title": "프로세스 정리",
      "body": "PID와 시작 신원, 소유한 자식 프로세스를 확인. 잘린 JSON이나 사용량 누락을 성공으로 꾸미지 않음."
    }
  ],
  "source": "src/server/processRunner.ts · src/server/processSupervisor.ts · src/server/runtime/service.ts"
}
```

## 늦은 응답

취소·재계획 뒤 도착한 결과는 현재 계획에 반영하지 않음.

## 프로세스 정리

PID와 시작 신원, 소유한 자식 프로세스를 확인. 잘린 JSON이나 사용량 누락을 성공으로 꾸미지 않음.

관련 자료: src/server/processRunner.ts · src/server/processSupervisor.ts · src/server/runtime/service.ts

# 진행 표시와 실제 작업의 구분

실행 시간·문장 증가·완료 선언을 서로 다른 증거로 확인.

```diagram
{
  "section": "OBSERVABILITY",
  "lead": "실행 시간·문장 증가·완료 선언을 서로 다른 증거로 확인.",
  "elements": [
    {
      "kind": "group",
      "x": 0,
      "y": 0,
      "w": 235,
      "h": 414,
      "label": "화면에서 보이는 신호"
    },
    {
      "kind": "group",
      "x": 276,
      "y": 0,
      "w": 235,
      "h": 414,
      "label": "추가로 대조할 사실"
    },
    {
      "kind": "node",
      "x": 15,
      "y": 48,
      "w": 205,
      "h": 81,
      "label": "실행 중",
      "body": "프로세스 · 경과 시간",
      "color": "gray"
    },
    {
      "kind": "node",
      "x": 291,
      "y": 48,
      "w": 205,
      "h": 81,
      "label": "현재 턴의 결과",
      "body": "새 도구 결과 · 판단",
      "color": "blue"
    },
    {
      "kind": "node",
      "x": 15,
      "y": 170,
      "w": 205,
      "h": 81,
      "label": "문장 증가",
      "body": "스트리밍 · 누적 응답",
      "color": "gray"
    },
    {
      "kind": "node",
      "x": 291,
      "y": 170,
      "w": 205,
      "h": 81,
      "label": "원문과 실제 파일",
      "body": "읽음 구간 · 변경 내용",
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 15,
      "y": 292,
      "w": 205,
      "h": 81,
      "label": "완료 응답",
      "body": "모델의 성공 문구",
      "color": "gray"
    },
    {
      "kind": "node",
      "x": 291,
      "y": 292,
      "w": 205,
      "h": 81,
      "label": "검사 · 리뷰 · 커밋",
      "body": "승인한 결과와 일치",
      "color": "purple"
    },
    {
      "kind": "arrow",
      "points": [
        [
          220,
          88
        ],
        [
          291,
          88
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          220,
          210
        ],
        [
          291,
          210
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          220,
          332
        ],
        [
          291,
          332
        ]
      ],
      "color": "teal"
    }
  ],
  "notes": [
    {
      "title": "연결이 끊긴 뒤",
      "body": "화면 재연결 시 저장된 실행·이벤트·원문 해시로 현재 상태 확인."
    },
    {
      "title": "증거의 의미",
      "body": "경로 검사는 범위, 테스트는 실행한 계약을 증명. 미실행 UI나 외부 환경까지 확대 해석하지 않음."
    }
  ],
  "source": ""
}
```

## 연결이 끊긴 뒤

화면 재연결 시 저장된 실행·이벤트·원문 해시로 현재 상태 확인.

## 증거의 의미

경로 검사는 범위, 테스트는 실행한 계약을 증명. 미실행 UI나 외부 환경까지 확대 해석하지 않음.

# 로컬 완료와 원격 전달

검토한 결과를 로컬 커밋에 연결하고, 원격 반영은 별도 OID로 확인.

```diagram
{
  "section": "DELIVERY",
  "lead": "검토한 결과를 로컬 커밋에 연결하고, 원격 반영은 별도 OID로 확인.",
  "elements": [
    {
      "kind": "node",
      "x": 0.0,
      "y": 20,
      "w": 114.25,
      "h": 115,
      "label": "리뷰 통과",
      "body": "현재 승인 · 검사",
      "color": "blue"
    },
    {
      "kind": "arrow",
      "points": [
        [
          114.25,
          77.5
        ],
        [
          132.25,
          77.5
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 132.25,
      "y": 20,
      "w": 114.25,
      "h": 115,
      "label": "로컬 완료",
      "body": "검토한 트리",
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          246.5,
          77.5
        ],
        [
          264.5,
          77.5
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 264.5,
      "y": 20,
      "w": 114.25,
      "h": 115,
      "label": "전달 승인",
      "body": "대상 · 범위",
      "color": "purple"
    },
    {
      "kind": "arrow",
      "points": [
        [
          378.75,
          77.5
        ],
        [
          396.75,
          77.5
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 396.75,
      "y": 20,
      "w": 114.25,
      "h": 115,
      "label": "원격 확인",
      "body": "실제 OID",
      "color": "gray",
      "icon": "github"
    },
    {
      "kind": "group",
      "x": 0,
      "y": 181,
      "w": 511,
      "h": 105,
      "label": "변경이 없는 완료"
    },
    {
      "kind": "text",
      "x": 17,
      "y": 219,
      "w": 477,
      "label": "조건부 계획 → 변경 불필요 확인 → 검토한 기준 커밋을 결과로 사용",
      "size": 10,
      "align": 1
    },
    {
      "kind": "group",
      "x": 0,
      "y": 310,
      "w": 511,
      "h": 104,
      "label": "푸시 응답 유실"
    },
    {
      "kind": "text",
      "x": 17,
      "y": 348,
      "w": 477,
      "label": "응답 없음 → 원격 커밋 조회 → 실행 기록 대조 → 전달 상태 복구",
      "size": 10,
      "align": 1
    }
  ],
  "notes": [
    {
      "title": "단계 통합",
      "body": "갈라진 결과는 충돌 해결·리뷰 뒤 부모 커밋 관계를 보존해 통합."
    },
    {
      "title": "중복 실행 방지",
      "body": "전송 결과가 불명확하면 원격부터 확인. 기존 파일럿은 격리된 bare 원격에서 검증."
    }
  ],
  "source": "src/server/engine/delivery.ts · src/server/git.ts"
}
```

## 단계 통합

갈라진 결과는 충돌 해결·리뷰 뒤 부모 커밋 관계를 보존해 통합.

## 중복 실행 방지

전송 결과가 불명확하면 원격부터 확인. 기존 파일럿은 격리된 bare 원격에서 검증.

관련 자료: src/server/engine/delivery.ts · src/server/git.ts

# 사용량 기록과 실행 한도

원문 읽기 횟수, 논리적 리뷰, 실제 모델 실행을 서로 다른 값으로 기록.

```diagram
{
  "section": "ACCOUNTING",
  "lead": "원문 읽기 횟수, 논리적 리뷰, 실제 모델 실행을 서로 다른 값으로 기록.",
  "elements": [
    {
      "kind": "group",
      "x": 0,
      "y": 0,
      "w": 511,
      "h": 168,
      "label": "한 번의 논리적 리뷰"
    },
    {
      "kind": "node",
      "x": 15,
      "y": 46,
      "w": 148,
      "h": 85,
      "label": "원문 읽기",
      "body": "여러 조각으로 조회",
      "color": "blue",
      "body_size": 9
    },
    {
      "kind": "node",
      "x": 182,
      "y": 46,
      "w": 148,
      "h": 85,
      "label": "판단 · 보완",
      "body": "필요한 모델 실행",
      "color": "purple",
      "body_size": 9
    },
    {
      "kind": "node",
      "x": 349,
      "y": 46,
      "w": 147,
      "h": 85,
      "label": "최종 결과",
      "body": "하나의 리뷰 결론",
      "color": "teal",
      "body_size": 9
    },
    {
      "kind": "arrow",
      "points": [
        [
          163,
          88
        ],
        [
          182,
          88
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          330,
          88
        ],
        [
          349,
          88
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "group",
      "x": 0,
      "y": 203,
      "w": 244,
      "h": 211,
      "label": "누적 기록"
    },
    {
      "kind": "text",
      "x": 18,
      "y": 245,
      "w": 210,
      "label": "입력 · 캐시 · 출력\n실제 호출 수\n호출별 실행시간\n값이 없으면 미제공",
      "size": 12
    },
    {
      "kind": "group",
      "x": 267,
      "y": 203,
      "w": 244,
      "h": 211,
      "label": "별도 적용 조건"
    },
    {
      "kind": "text",
      "x": 285,
      "y": 245,
      "w": 207,
      "label": "사용자가 정한 예산\n명시한 횟수 한도\n공급자의 사용 제한\n취소 가능한 재시도",
      "size": 12
    }
  ],
  "notes": [
    {
      "title": "기본 동작",
      "body": "시간·토큰 관측과 실행 제한을 분리. 새 커밋·세션·재시작으로 사용량 초기화 금지."
    },
    {
      "title": "미확인 사용량",
      "body": "누락 호출과 저장 응답 보존. 재개 권한은 해당 호출에 연결하며 관측값을 만들지 않음."
    }
  ],
  "source": ""
}
```

## 기본 동작

시간·토큰 관측과 실행 제한을 분리. 새 커밋·세션·재시작으로 사용량 초기화 금지.

## 미확인 사용량

누락 호출과 저장 응답 보존. 재개 권한은 해당 호출에 연결하며 관측값을 만들지 않음.

# 검사 결과의 재사용 조건

확인된 정적 검사 한 종류의 입력·도구·환경·계획·로그를 함께 대조.

```diagram
{
  "section": "VERIFICATION",
  "lead": "확인된 정적 검사 한 종류의 입력·도구·환경·계획·로그를 함께 대조.",
  "elements": [
    {
      "kind": "node",
      "x": 0,
      "y": 10,
      "w": 222,
      "h": 175,
      "label": "검사의 입력",
      "body": "관련 파일과 미추적 파일\n검사 도구 · 실행 환경\n승인 계획 · 결과 로그",
      "color": "blue"
    },
    {
      "kind": "node",
      "x": 289,
      "y": 10,
      "w": 222,
      "h": 175,
      "label": "기존 통과 기록",
      "body": "같은 입력 해시\n완료된 결과와 근거\n저장 도중 중단 여부",
      "color": "purple"
    },
    {
      "kind": "arrow",
      "points": [
        [
          222,
          96
        ],
        [
          289,
          96
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          255,
          96
        ],
        [
          255,
          225
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "diamond",
      "x": 169,
      "y": 225,
      "w": 173,
      "h": 102,
      "label": "재사용 조건 일치?",
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          169,
          276
        ],
        [
          78,
          276
        ],
        [
          78,
          353
        ]
      ],
      "color": "coral"
    },
    {
      "kind": "arrow",
      "points": [
        [
          342,
          276
        ],
        [
          434,
          276
        ],
        [
          434,
          353
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "text",
      "x": 94,
      "y": 297,
      "w": 85,
      "label": "불일치",
      "ink": "#BF674A"
    },
    {
      "kind": "text",
      "x": 371,
      "y": 297,
      "w": 54,
      "label": "일치",
      "ink": "#087F80"
    },
    {
      "kind": "node",
      "x": 0,
      "y": 353,
      "w": 158,
      "h": 70,
      "label": "현재 입력으로 실행",
      "body": "근거가 없거나 변경됨",
      "color": "coral",
      "body_size": 9
    },
    {
      "kind": "node",
      "x": 353,
      "y": 353,
      "w": 158,
      "h": 70,
      "label": "검사 결과 재사용",
      "body": "동일한 조건과 로그",
      "color": "teal",
      "body_size": 9
    }
  ],
  "notes": [
    {
      "title": "확인한 적용 범위",
      "body": "Swift 동시성 정책 정적 검사. 전체 단위 테스트·빌드·UI 검사로 확대하지 않음."
    },
    {
      "title": "검증의 구분",
      "body": "컴파일, 설치·실행, 앱 오류, 화면·제스처는 각각 해당 환경에서 확인."
    }
  ],
  "source": "src/server/verificationInputs.ts · src/server/verifications.ts"
}
```

## 확인한 적용 범위

Swift 동시성 정책 정적 검사. 전체 단위 테스트·빌드·UI 검사로 확대하지 않음.

## 검증의 구분

컴파일, 설치·실행, 앱 오류, 화면·제스처는 각각 해당 환경에서 확인.

관련 자료: src/server/verificationInputs.ts · src/server/verifications.ts

# 9월 파일럿의 실행 경로

첫 실패는 보존하고, 엔진 중간 수정 없이 새 파일럿에서 다섯 단계와 원격 전달까지 확인.

```diagram
{
  "section": "PILOT",
  "lead": "첫 실패는 보존하고, 엔진 중간 수정 없이 새 파일럿에서 다섯 단계와 원격 전달까지 확인.",
  "elements": [
    {
      "kind": "node",
      "x": 0,
      "y": 0,
      "w": 511,
      "h": 68,
      "label": "첫 실행의 중단",
      "body": "예산·계획 확정 결함 → 기록 보존 → 수정·검토",
      "color": "coral",
      "body_size": 10
    },
    {
      "kind": "node",
      "x": 0.0,
      "y": 110,
      "w": 158.33333333333334,
      "h": 90,
      "label": "첫 단계",
      "body": "전체 목표에서 착수",
      "color": "blue"
    },
    {
      "kind": "arrow",
      "points": [
        [
          158.33333333333334,
          155.0
        ],
        [
          176.33333333333334,
          155.0
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 176.33333333333334,
      "y": 110,
      "w": 158.33333333333334,
      "h": 90,
      "label": "중재자 교체",
      "body": "배정과 기록 확인",
      "color": "purple"
    },
    {
      "kind": "arrow",
      "points": [
        [
          334.6666666666667,
          155.0
        ],
        [
          352.6666666666667,
          155.0
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 352.6666666666667,
      "y": 110,
      "w": 158.33333333333334,
      "h": 90,
      "label": "미래 단계 분할",
      "body": "무관한 결과 보존",
      "color": "teal"
    },
    {
      "kind": "arrow",
      "points": [
        [
          431,
          200
        ],
        [
          431,
          231
        ],
        [
          80,
          231
        ],
        [
          80,
          269
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 0.0,
      "y": 269,
      "w": 158.33333333333334,
      "h": 90,
      "label": "큰 원문 조회",
      "body": "조각·근거 연결",
      "color": "blue"
    },
    {
      "kind": "arrow",
      "points": [
        [
          158.33333333333334,
          314.0
        ],
        [
          176.33333333333334,
          314.0
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 176.33333333333334,
      "y": 269,
      "w": 158.33333333333334,
      "h": 90,
      "label": "서버 재시작",
      "body": "DB 상태 보존",
      "color": "purple"
    },
    {
      "kind": "arrow",
      "points": [
        [
          334.6666666666667,
          314.0
        ],
        [
          352.6666666666667,
          314.0
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 352.6666666666667,
      "y": 269,
      "w": 158.33333333333334,
      "h": 90,
      "label": "통합 · 전달",
      "body": "5개 단계 종료",
      "color": "teal",
      "icon": "github"
    },
    {
      "kind": "text",
      "x": 20,
      "y": 386,
      "w": 471,
      "label": "실제 Claude·Codex CLI / 저장된 외부 자료 스냅샷 / 격리된 원격",
      "size": 10,
      "align": 1
    }
  ],
  "notes": [
    {
      "title": "엔진 상태",
      "body": "실행 중 비교 대상 243개 파일의 해시 유지. 파일럿 DB 60개 테이블 보존."
    },
    {
      "title": "대상 검사",
      "body": "77개 통과. 필요한 export를 제거한 반대 검사에서 실패 확인."
    }
  ],
  "source": "docs/usage-report.md · 9월 파일럿 당시 관측 결과"
}
```

## 엔진 상태

실행 중 비교 대상 243개 파일의 해시 유지. 파일럿 DB 60개 테이블 보존.

## 대상 검사

77개 통과. 필요한 export를 제거한 반대 검사에서 실패 확인.

관련 자료: docs/usage-report.md · 9월 파일럿 당시 관측 결과

# 파일럿 사용량과 검증 범위

관측값의 범위를 함께 표시하고, 비교 실행 없는 절감률은 제시하지 않음.

```diagram
{
  "section": "MEASUREMENTS",
  "lead": "관측값의 범위를 함께 표시하고, 비교 실행 없는 절감률은 제시하지 않음.",
  "elements": [
    {
      "kind": "node",
      "x": 0,
      "y": 0,
      "w": 158,
      "h": 90,
      "label": "48회",
      "body": "실제 모델 실행",
      "color": "blue",
      "size": 26
    },
    {
      "kind": "node",
      "x": 177,
      "y": 0,
      "w": 158,
      "h": 90,
      "label": "5개",
      "body": "완료한 단계",
      "color": "teal",
      "size": 26
    },
    {
      "kind": "node",
      "x": 354,
      "y": 0,
      "w": 157,
      "h": 90,
      "label": "6,566초",
      "body": "호출별 시간 합계",
      "color": "purple",
      "size": 23
    },
    {
      "kind": "text",
      "x": 0,
      "y": 124,
      "w": 511,
      "label": "입력 토큰 22,602,633",
      "size": 14,
      "bold": true
    },
    {
      "kind": "bar",
      "x": 0,
      "y": 159,
      "w": 511,
      "h": 30,
      "parts": [
        {
          "fraction": 0.8023127659507634,
          "color": "teal"
        },
        {
          "fraction": 0.1976872340492366,
          "color": "gray"
        }
      ]
    },
    {
      "kind": "text",
      "x": 0,
      "y": 202,
      "w": 340,
      "label": "포함된 캐시 입력 18,134,381",
      "size": 11,
      "ink": "#087F80"
    },
    {
      "kind": "text",
      "x": 0,
      "y": 237,
      "w": 511,
      "label": "출력 토큰 620,113",
      "size": 14,
      "bold": true
    },
    {
      "kind": "group",
      "x": 0,
      "y": 295,
      "w": 511,
      "h": 127,
      "label": "10월 5일 엔진 후보 검사"
    },
    {
      "kind": "node",
      "x": 14,
      "y": 335,
      "w": 150,
      "h": 75,
      "label": "2,417개",
      "body": "개발본 검사 통과",
      "color": "blue",
      "size": 17,
      "body_size": 9
    },
    {
      "kind": "node",
      "x": 181,
      "y": 335,
      "w": 150,
      "h": 75,
      "label": "221개",
      "body": "Python 검사 통과",
      "color": "purple",
      "size": 17,
      "body_size": 9
    },
    {
      "kind": "node",
      "x": 348,
      "y": 335,
      "w": 149,
      "h": 75,
      "label": "통과",
      "body": "타입 · 웹 빌드 · 리뷰",
      "color": "teal",
      "size": 17,
      "body_size": 8.5
    }
  ],
  "notes": [
    {
      "title": "합산 주의",
      "body": "캐시 입력은 전체 입력에 포함. 호출별 시간 합계는 작업 경과 시간이 아님."
    },
    {
      "title": "검증의 범위",
      "body": "예상 실패 2개·제외 7개 별도. 파일럿은 시험용 스냅샷이며 실제 외부 서비스 전체 검증은 미포함."
    }
  ],
  "source": "9월 27일 검사: 개발본 1,719 · Python 160 · 공개본 1,381. 새 엔진 검사와 별도 집계."
}
```

## 합산 주의

캐시 입력은 전체 입력에 포함. 호출별 시간 합계는 작업 경과 시간이 아님.

## 검증의 범위

예상 실패 2개·제외 7개 별도. 파일럿은 시험용 스냅샷이며 실제 외부 서비스 전체 검증은 미포함.

관련 자료: 9월 27일 검사: 개발본 1,719 · Python 160 · 공개본 1,381. 새 엔진 검사와 별도 집계.

# 복구 계약의 검증과 남은 과제

멈춘 지점의 복구부터 다음 단계까지 확인하고, 운영 환경에서의 비교는 별도 수행.

```diagram
{
  "section": "NEXT VALIDATION",
  "lead": "멈춘 지점의 복구부터 다음 단계까지 확인하고, 운영 환경에서의 비교는 별도 수행.",
  "elements": [
    {
      "kind": "node",
      "x": 0.0,
      "y": 10,
      "w": 114.25,
      "h": 90,
      "label": "중지 · 실패",
      "body": "자료 요청 도중",
      "color": "coral"
    },
    {
      "kind": "arrow",
      "points": [
        [
          114.25,
          55.0
        ],
        [
          132.25,
          55.0
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 132.25,
      "y": 10,
      "w": 114.25,
      "h": 90,
      "label": "DB 재연결",
      "body": "승인 기록 보존",
      "color": "blue"
    },
    {
      "kind": "arrow",
      "points": [
        [
          246.5,
          55.0
        ],
        [
          264.5,
          55.0
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 264.5,
      "y": 10,
      "w": 114.25,
      "h": 90,
      "label": "명시적 재개",
      "body": "동일 계획·범위",
      "color": "purple"
    },
    {
      "kind": "arrow",
      "points": [
        [
          378.75,
          55.0
        ],
        [
          396.75,
          55.0
        ]
      ],
      "color": "teal"
    },
    {
      "kind": "node",
      "x": 396.75,
      "y": 10,
      "w": 114.25,
      "h": 90,
      "label": "다음 계획",
      "body": "로컬 완료 후",
      "color": "teal"
    },
    {
      "kind": "group",
      "x": 0,
      "y": 143,
      "w": 511,
      "h": 264,
      "label": "검증을 넓힐 항목"
    },
    {
      "kind": "node",
      "x": 15,
      "y": 186,
      "w": 232,
      "h": 85,
      "label": "실제 외부 서비스",
      "body": "인증 · 요청 제한 · 원문 변경",
      "color": "blue",
      "body_size": 9
    },
    {
      "kind": "node",
      "x": 264,
      "y": 186,
      "w": 232,
      "h": 85,
      "label": "전송량·비용 비교",
      "body": "같은 작업·모델·설정의 비교군",
      "color": "purple",
      "body_size": 9
    },
    {
      "kind": "node",
      "x": 15,
      "y": 293,
      "w": 232,
      "h": 85,
      "label": "공통 계약 적용",
      "body": "남은 재시도·무효화 경로 이관",
      "color": "teal",
      "body_size": 9
    },
    {
      "kind": "node",
      "x": 264,
      "y": 293,
      "w": 232,
      "h": 85,
      "label": "손상·전달 실패 복구",
      "body": "저장 기록 복구 · 중재 알림",
      "color": "coral",
      "body_size": 9
    }
  ],
  "notes": [
    {
      "title": "자동 검사",
      "body": "실제 Git·공개 API·DB 재연결, 모델 대역으로 복구와 후속 목록 보존 확인."
    },
    {
      "title": "운영 확인",
      "body": "검토한 코드 설치·재시작 후 계획·체크포인트·배정·한도 보존과 실제 근거 검토 재개 확인."
    }
  ],
  "source": "아이콘: Simple Icons 14.0.0 (CC0) · Figma Brand Assets. 각 상표권은 해당 소유자에게 귀속."
}
```

## 자동 검사

실제 Git·공개 API·DB 재연결, 모델 대역으로 복구와 후속 목록 보존 확인.

## 운영 확인

검토한 코드 설치·재시작 후 계획·체크포인트·배정·한도 보존과 실제 근거 검토 재개 확인.

관련 자료: 아이콘: Simple Icons 14.0.0 (CC0) · Figma Brand Assets. 각 상표권은 해당 소유자에게 귀속.
