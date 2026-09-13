# `rg` 탐색 비교 기준

`npm run explore -- --repository <저장소> --symbol <문자열> [--path <상대 경로>]`는 모델을 호출하지 않는다. 호출 시점의 Git HEAD 아카이브에서만 `rg --json`을 실행해, 검색한 행과 반환한 앞뒤 문맥이 항상 같은 스냅샷에 속하게 한다. untracked·미커밋 파일은 의도적으로 제외한다.

반환은 최대 20개 위치, 각 위치 앞뒤 5행, 직렬화 JSON 16KiB로 제한한다. 상한에 닿으면 `omitted: true`이고, 완전한 검색 결과로 쓰면 안 된다.

## 재현 가능한 12개 probe

`npm run compare:search`는 Consensus Room 6개와 Duse iOS 6개를 실행한다. 각 probe는 넓은 디렉터리의 개수 대신 한 개의 HEAD 파일에서 `git grep`이 찾은 정확한 `file:line`을 explorer 결과와 대조한다.

- Consensus Room: `TurnUsage`, `ClaudeAdapter`, `getPromptTimeline`, `loadConfig`, `AbortError`, `runMediatorVerification`
- Duse iOS: `NotiFilterViewModel`, `AppRouterTrackingIntegrationTests`, `NetworkCore`, `DesignSystem`, `SwiftUI`, `XCTest`

각 probe는 기준선 위치가 하나 이상 있고, 모든 위치가 explorer에 있으며, `omitted: false`이고, JSON 출력이 16KiB 이하일 때만 성공한다. 이 검증은 12개 대표 검색의 결과 보존을 확인할 뿐, 전체 저장소 탐색의 토큰 절감률이나 기능 완전성을 주장하지 않는다.
