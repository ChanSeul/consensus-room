import { basename } from "node:path";

const SUBJECTS = [
  ["매물등록", "houseregist", "houseregister", "house-register"],
  ["숏폼", "shortform", "short-form"],
  ["consensusroom", "consensus-room", "컨센서스룸"],
  ["매물상세", "housedetail", "house-detail"],
  ["로그인", "login", "auth"],
  ["채팅", "chat"], ["지도", "mainmap"], ["알림", "notification", "push"],
  ["문의", "inquiry"], ["아파트", "apartment"], ["동시성", "concurrency"],
  ["빌드", "build"], ["배포", "release", "deploy", "ci-cd"],
] as const;
const STOP = new Set(["그리고", "합니다", "주세요", "사용자", "계획", "구현", "검토", "코드", "작업", "확인", "확인해줘", "확인하세요", "처리", "구조", "구조를", "어떻게", "관련", "필요한", "동작", "찾아줘"]);
const WEAK = new Set(["승인", "취소", "재시작", "복구", "세션", "재개", "해시", "오류", "리뷰", "실행"]);
const compact = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\s_-]+/g, "");

// These labels are emitted by shared/prompts.ts. Framework role instructions are not task subjects.
// For untitled first code reviews use the approved plan, not the reviewer boilerplate.
export function memoryQuery(prompt: string): string {
  const title = /^주제: (.+)$/m.exec(prompt)?.[1];
  const plan = /(?:승인된 계획|검토할 계획):\r?\n---\r?\n([\s\S]*?)\r?\n---/.exec(prompt)?.[1];
  if (!title && !plan) return prompt;
  // A generic title must not hide the actual request in the timeline. Bound the timeline by the
  // contracts emitted by shared/prompts.ts; never use the framework introduction as a topic.
  const timeline = /(?:대화와 증거|직전 전달 이후 추가된 결정과 증거):\r?\n([\s\S]*)/.exec(prompt)?.[1]
    ?.split(/\n(?:최종 plan\.md에는|직전 계획 전문\(|심각도|출력 언어:|위험도)/)[0];
  return [title, plan, timeline?.includes("] user/") ? timeline : undefined].filter(Boolean).join("\n");
}

function tokens(value: string): string[] {
  return [...new Set((value.normalize("NFKC").toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}|[가-힣]{2,}/g) ?? [])
    .filter(token => !STOP.has(token)))];
}

export interface MemoryRelevance { score: number; reason: "subject" | "terms" | "weak-match"; matches: string[] }

export function memoryRelevance(prompt: string, path: string, context: string, content: string): MemoryRelevance {
  const query = memoryQuery(prompt);
  const file = basename(path, ".md").toLowerCase();
  const headings = content.split(/\r?\n/).filter(line => /^#{1,6} /.test(line)).join("\n").toLowerCase();
  const label = context.toLowerCase();
  const searchable = `${file}\n${label}\n${headings}`;
  const normalized = compact(searchable);
  const subjects = SUBJECTS.filter(aliases => aliases.some(alias => compact(query).includes(compact(alias))));
  const subjectMatches = subjects.filter(aliases => aliases.some(alias => normalized.includes(compact(alias))));
  const queryTokens = tokens(query);
  const matches = queryTokens.filter(token => searchable.includes(token));
  const strong = matches.filter(token => !WEAK.has(token));
  const roleReview = /^(claude|codex)-only\//.test(path) && matches.includes("리뷰");
  const exactFileTerm = matches.some(token => /^[a-z0-9][a-z0-9_-]{2,}$/.test(token)
    && (file === token || file.split(/[_-]/).includes(token)));
  // A lone incidental heading word must not route an otherwise unrelated multi-term request.
  const covered = matches.length / Math.max(queryTokens.length, 1) >= 0.5;
  const eligible = subjectMatches.length > 0 || exactFileTerm || roleReview
    || (covered && (strong.length > 0 || matches.length >= 2));
  if (!eligible) return { score: 0, reason: "weak-match", matches };
  const lexical = matches.reduce((sum, token) => sum + (file.includes(token) ? 8 : label.includes(token) ? 4 : 2), 0);
  return { score: subjectMatches.length * 40 + lexical, reason: subjectMatches.length ? "subject" : "terms", matches };
}
